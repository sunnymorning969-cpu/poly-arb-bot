/**
 * 市场扫描器 v2 - WebSocket 实时版本
 * 
 * 核心逻辑：
 * 1. 启动时获取市场列表（缓存 60 秒）
 * 2. 通过 WebSocket 订阅订单簿实时更新
 * 3. 实时检测套利机会
 */

import axios from 'axios';
import CONFIG from './config';
import Logger from './logger';
import { orderBookManager, OrderBookData } from './orderbook-ws';
import { getEventCostAnalysis, predictCostAfterBuy, getGroupCostAnalysis, predictGroupCostAfterBuy, getTimeGroup, TimeGroup, getAssetAvgPrices } from './positions';
import { updateTokenMap, clearTriggeredStopLoss, printEventSummary, clearExtremeImbalance, setEmergencyMode, isInEmergencyMode, clearEmergencyMode } from './stopLoss';
import { getGroupPositionSummary, calculateHedgeNeeded, startHedging, isHedging, isHedgeCompleted, completeHedging, stopHedging, shouldPrintHedgeLog, canExecuteHedge, getRemainingHedge } from './hedging';

// 扫描级别的冷却记录（防止重复检测）
const scanCooldown = new Map<string, number>();
const SCAN_COOLDOWN_MS = 2000;  // 同一时间段组 2秒内不重复扫描

const isGroupOnCooldown = (timeGroup: TimeGroup): boolean => {
    const lastTime = scanCooldown.get(timeGroup);
    if (!lastTime) return false;
    return Date.now() - lastTime < SCAN_COOLDOWN_MS;
};

const recordGroupScan = (timeGroup: TimeGroup): void => {
    scanCooldown.set(timeGroup, Date.now());
};

// 清除冷却（交易执行后调用）
export const clearGroupCooldown = (timeGroup: TimeGroup): void => {
    scanCooldown.delete(timeGroup);
};

// 市场数据接口
export interface MarketToken {
    token_id: string;
    outcome: string;
    price: number;
}

export interface ArbitrageOpportunity {
    // 基本信息（可能跨池子）
    conditionId: string;         // Up 所在市场的 conditionId
    slug: string;                // Up 所在市场的 slug
    title: string;
    upToken: MarketToken;
    downToken: MarketToken;
    // 跨池子支持
    timeGroup: TimeGroup;        // 时间段分组
    isCrossPool: boolean;        // 是否跨池子
    upMarketSlug: string;        // Up 来自哪个市场
    downMarketSlug: string;      // Down 来自哪个市场
    downConditionId: string;     // Down 所在市场的 conditionId
    // 从订单簿获取的实时价格
    upAskPrice: number;
    downAskPrice: number;
    upAskSize: number;
    downAskSize: number;
    // 套利计算
    combinedCost: number;
    profitPercent: number;
    maxShares: number;
    endDate: string;
    // 单边策略
    upIsCheap: boolean;
    downIsCheap: boolean;
    priority: number;
    // 组合级策略（跨池子）
    groupAnalysis: {
        hasPosition: boolean;
        currentAvgCost: number;     // 组合当前平均成本
        currentProfit: number;      // 组合当前预期利润
        imbalance: number;          // 组合不平衡度
        needMoreUp: boolean;        // 组合需要更多 Up
        needMoreDown: boolean;      // 组合需要更多 Down
        predictedAvgCost: number;   // 买入后预测的平均成本
        predictedProfit: number;    // 买入后预测的利润
        worthBuying: boolean;       // 是否值得买入
    };
    // 兼容旧字段
    eventAnalysis: {
        hasPosition: boolean;
        currentAvgCost: number;
        currentProfit: number;
        imbalance: number;
        needMoreUp: boolean;
        needMoreDown: boolean;
        predictedAvgCost: number;
        predictedProfit: number;
        worthBuying: boolean;
    };
    // 交易建议
    tradingAction: 'buy_both' | 'buy_up_only' | 'buy_down_only' | 'wait';
    // 对冲标记
    isHedge?: boolean;  // 是否为对冲补仓交易
    hedgeSide?: 'btcUp' | 'btcDown' | 'ethUp' | 'ethDown';  // 对冲方向
    // 同池增持标记
    isSamePoolRebalance?: boolean;  // 是否为同池增持交易
    rebalanceAsset?: 'btc' | 'eth';  // 增持的资产
    rebalanceSide?: 'up' | 'down';   // 增持的方向
}

// API 响应接口
interface PolymarketMarket {
    condition_id: string;
    question: string;
    slug: string;
    tokens: Array<{
        token_id: string;
        outcome: string;
        price: number;
    }>;
    end_date_iso: string;
    active: boolean;
    closed: boolean;
}

// 市场缓存
let cachedMarkets: PolymarketMarket[] = [];
let lastMarketFetch = 0;
let lastSlugs: string[] = [];  // 记录上次的 slug，用于检测变化
let lastSlugCheck = 0;  // 上次检查 slug 的时间
const MARKET_CACHE_DURATION = 5 * 60 * 1000;  // 市场列表缓存 5 分钟
const SLUG_CHECK_INTERVAL = 10 * 1000;  // 每 10 秒检查一次 slug 变化

// 市场 token 映射（用于快速查找）
let marketTokenMap = new Map<string, { market: PolymarketMarket; upToken: any; downToken: any }>();

/**
 * 检查并处理事件切换（15分钟边界）
 * 由主循环定期调用
 */
export const checkEventSwitch = async (): Promise<boolean> => {
    const now = Date.now();
    if (now - lastSlugCheck < SLUG_CHECK_INTERVAL) {
        return false;  // 未到检查时间
    }
    lastSlugCheck = now;
    
    const currentSlugs = generateMarketSlugs();
    const slugsChanged = lastSlugs.length > 0 && 
        currentSlugs.some((slug, i) => slug !== lastSlugs[i]);
    
    if (slugsChanged) {
        // 在清除前，打印上一个事件的统计摘要
        const oldTimeGroups = new Set<TimeGroup>();
        for (const slug of lastSlugs) {
            const timeGroup = getTimeGroup(slug);
            if (timeGroup) {
                oldTimeGroups.add(timeGroup);
            }
        }
        for (const timeGroup of oldTimeGroups) {
            printEventSummary(timeGroup);
        }
        
        Logger.info(`🔄 检测到事件切换，更新市场订阅...`);
        
        // ===== 关键：强制结算旧事件的所有仓位 =====
        // 避免旧仓位被带到新事件
        const { forceSettleByTimeGroup } = await import('./positions');
        for (const timeGroup of oldTimeGroups) {
            await forceSettleByTimeGroup(timeGroup);
        }
        
        // 清除止损记录、极端不平衡记录、紧急模式和对冲状态（新事件开始）
        clearTriggeredStopLoss();
        clearExtremeImbalance();
        clearEmergencyMode();
        for (const timeGroup of oldTimeGroups) {
            stopHedging(timeGroup);
        }
        await fetchCryptoMarkets();
        return true;
    }
    return false;
};

/**
 * 根据当前 ET 时间生成市场 slug
 * 根据配置决定是否包含 15分钟/1小时市场
 */
function generateMarketSlugs(): string[] {
    const nowMs = Date.now();
    const etMs = nowMs - 5 * 3600 * 1000;  // ET = UTC - 5
    const etDate = new Date(etMs);
    
    const month = etDate.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase();
    const day = etDate.getUTCDate();
    const hour = etDate.getUTCHours();
    const minute = etDate.getUTCMinutes();
    
    const slugs: string[] = [];
    
    // === 1小时市场（根据配置开关）===
    if (CONFIG.ENABLE_1HR) {
        const h12 = hour % 12 || 12;
        const ampm = hour >= 12 ? 'pm' : 'am';
        slugs.push(`bitcoin-up-or-down-${month}-${day}-${h12}${ampm}-et`);
        slugs.push(`ethereum-up-or-down-${month}-${day}-${h12}${ampm}-et`);
    }
    
    // === 15分钟市场（根据配置开关）===
    if (CONFIG.ENABLE_15MIN) {
        const min15Start = Math.floor(minute / 15) * 15;
        const startEt = new Date(etDate);
        startEt.setUTCMinutes(min15Start, 0, 0);
        const timestamp = Math.floor((startEt.getTime() + 5 * 3600 * 1000) / 1000);
        
        slugs.push(`btc-updown-15m-${timestamp}`);
        slugs.push(`eth-updown-15m-${timestamp}`);
    }
    
    return slugs;
}

/**
 * 通过 slug 从 gamma-api 获取 event 和 market 信息
 */
async function fetchEventBySlug(slug: string): Promise<PolymarketMarket | null> {
    try {
        const resp = await axios.get(`${CONFIG.GAMMA_API}/events`, {
            params: { slug },
            timeout: 10000,
        });
        
        const events = resp.data;
        if (!events || !Array.isArray(events) || events.length === 0) {
            return null;
        }
        
        const event = events[0];
        const markets = event.markets;
        
        if (!markets || !Array.isArray(markets) || markets.length === 0) {
            return null;
        }
        
        // 找到有 Up/Down tokens 的 market
        for (const market of markets) {
            // outcomes 和 clobTokenIds 可能是字符串，需要解析
            let outcomes = market.outcomes;
            let clobTokenIds = market.clobTokenIds;
            let outcomePrices = market.outcomePrices;
            
            // 如果是字符串，解析成数组
            if (typeof outcomes === 'string') {
                try { outcomes = JSON.parse(outcomes); } catch {}
            }
            if (typeof clobTokenIds === 'string') {
                try { clobTokenIds = JSON.parse(clobTokenIds); } catch {}
            }
            if (typeof outcomePrices === 'string') {
                try { outcomePrices = JSON.parse(outcomePrices); } catch {}
            }
            
            if (outcomes && Array.isArray(outcomes) && outcomes.length === 2) {
                const outcomeNames = outcomes.map((o: string) => o.toLowerCase());
                if (outcomeNames.includes('up') && outcomeNames.includes('down')) {
                    // 检查 clobTokenIds 是否有效
                    if (!clobTokenIds || !Array.isArray(clobTokenIds) || clobTokenIds.length < 2) {
                        Logger.warning(`   ⚠️ ${slug} - clobTokenIds 无效: ${JSON.stringify(clobTokenIds)}`);
                        return null;
                    }
                    
                    // 构建 tokens 数组
                    const tokens = [];
                    for (let i = 0; i < outcomes.length; i++) {
                        const tokenId = String(clobTokenIds[i] || '');
                        if (!tokenId) {
                            Logger.warning(`   ⚠️ ${slug} - token ${i} 为空`);
                            return null;
                        }
                        tokens.push({
                            token_id: tokenId,
                            outcome: outcomes[i],
                            price: outcomePrices?.[i] ? parseFloat(outcomePrices[i]) : 0.5,
                        });
                    }
                    
                    // 调试日志已关闭
                    
                    // 计算结束时间（从 slug 计算，比 API 返回的更可靠）
                    let endDateIso = market.endDateIso || market.endDate || event.endDate;
                    
                    // 15分钟市场：slug 包含时间戳
                    const timestampMatch = slug.match(/(\d{10})$/);
                    if (timestampMatch) {
                        const startTimestamp = parseInt(timestampMatch[1]);
                        const endTimestamp = startTimestamp + 15 * 60;  // +15分钟
                        endDateIso = new Date(endTimestamp * 1000).toISOString();
                    }
                    
                    // 1小时市场：从 slug 解析小时，结束时间 = 开始时间 + 1小时
                    const hourMatch = slug.match(/(\d{1,2})(am|pm)-et$/);
                    if (hourMatch) {
                        // 获取当前 ET 日期
                        const nowMs = Date.now();
                        const etMs = nowMs - 5 * 3600 * 1000;
                        const etDate = new Date(etMs);
                        
                        let hour = parseInt(hourMatch[1]);
                        const isPM = hourMatch[2] === 'pm';
                        if (isPM && hour !== 12) hour += 12;
                        if (!isPM && hour === 12) hour = 0;
                        
                        // 设置结束时间 = 开始时间 + 1小时
                        etDate.setUTCHours(hour + 1, 0, 0, 0);
                        const endTimestamp = etDate.getTime() + 5 * 3600 * 1000;  // 转回 UTC
                        endDateIso = new Date(endTimestamp).toISOString();
                    }
                    
                    return {
                        condition_id: market.conditionId,
                        question: market.question || event.title,
                        slug: slug,
                        tokens,
                        end_date_iso: endDateIso,
                        active: market.active !== false,
                        closed: market.closed === true,
                    };
                }
            }
        }
        
        return null;  // 未找到 Up/Down 市场
    } catch (error: any) {
        Logger.error(`   ❌ ${slug} - 请求失败: ${error.message}`);
        return null;
    }
}

/**
 * 获取 BTC/ETH Up/Down 市场（智能缓存，只有 slug 变化时才重新订阅）
 */
export const fetchCryptoMarkets = async (): Promise<PolymarketMarket[]> => {
    const now = Date.now();
    
    // 根据当前时间生成 slug
    const currentSlugs = generateMarketSlugs();
    
    // 检查 slug 是否变化（15 分钟事件切换时会变）
    const slugsChanged = lastSlugs.length === 0 || 
        currentSlugs.some((slug, i) => slug !== lastSlugs[i]);
    
    // 如果 slug 没变且缓存未过期，直接返回缓存
    if (!slugsChanged && cachedMarkets.length > 0 && (now - lastMarketFetch) < MARKET_CACHE_DURATION) {
        return cachedMarkets;
    }
    
    // slug 变化了，需要重新获取
    if (slugsChanged && lastSlugs.length > 0) {
        Logger.info(`🔄 检测到事件切换，更新市场订阅...`);
        Logger.info(`   旧: ${lastSlugs.slice(2).join(', ')}`);  // 只显示 15 分钟的
        Logger.info(`   新: ${currentSlugs.slice(2).join(', ')}`);
    }
    
    try {
        // 并行获取所有市场
        const marketPromises = currentSlugs.map(slug => fetchEventBySlug(slug));
        const results = await Promise.all(marketPromises);
        
        // 检查是否有市场获取失败
        const failedCount = results.filter(r => r === null).length;
        if (failedCount > 0) {
            Logger.warning(`   ⚠️ ${failedCount} 个市场获取失败，可能新事件尚未创建，5秒后重试...`);
            
            // 5 秒后重试一次
            await new Promise(r => setTimeout(r, 5000));
            const retryResults = await Promise.all(currentSlugs.map(slug => fetchEventBySlug(slug)));
            
            // 合并结果：使用重试成功的替换原来失败的
            for (let i = 0; i < results.length; i++) {
                if (results[i] === null && retryResults[i] !== null) {
                    results[i] = retryResults[i];
                }
            }
            
            const stillFailed = results.filter(r => r === null).length;
            if (stillFailed > 0) {
                Logger.warning(`   ⚠️ 重试后仍有 ${stillFailed} 个市场不可用`);
            } else {
                Logger.success(`   ✅ 重试成功，所有市场已获取`);
            }
        }
        
        // 过滤有效且未关闭的市场
        cachedMarkets = results.filter((m): m is PolymarketMarket => {
            if (m === null) return false;
            if (m.closed) return false;
            if (m.tokens.length !== 2) return false;
            return true;
        });
        
        // 构建 token 映射
        marketTokenMap.clear();
        const tokenIds: string[] = [];
        
        for (const market of cachedMarkets) {
            const upToken = market.tokens.find(t => t.outcome.toLowerCase() === 'up');
            const downToken = market.tokens.find(t => t.outcome.toLowerCase() === 'down');
            
            if (upToken && downToken) {
                marketTokenMap.set(market.condition_id, { market, upToken, downToken });
                tokenIds.push(upToken.token_id, downToken.token_id);
                
                // 更新止损模块的 token 映射（区分 BTC 和 ETH）
                const timeGroup = getTimeGroup(market.slug);
                const isBtc = market.slug.includes('btc') || market.slug.includes('bitcoin');
                const asset = isBtc ? 'btc' : 'eth';
                updateTokenMap(timeGroup, upToken.token_id, downToken.token_id, market.end_date_iso, asset, market.condition_id);
            }
        }
        
        // 只有 slug 变化时才重新订阅 WebSocket
        if (slugsChanged && tokenIds.length > 0) {
            Logger.success(`📊 找到 ${cachedMarkets.length} 个 BTC/ETH Up/Down 市场`);
            // 更新订阅列表
            orderBookManager.clearStaleOrderBooks(tokenIds);
            tokenIds.forEach(id => orderBookManager.subscribe([id]));
            // 强制重连 WebSocket（Polymarket 需要重新连接才能订阅新 token）
            await orderBookManager.forceReconnect();
        }
        
        lastSlugs = currentSlugs;
        lastMarketFetch = now;
        return cachedMarkets;
    } catch (error) {
        if (cachedMarkets.length > 0) {
            return cachedMarkets;
        }
        Logger.error(`获取市场数据失败: ${error}`);
        return [];
    }
};

/**
 * 初始化 WebSocket 连接并订阅市场
 */
export const initWebSocket = async (): Promise<void> => {
    // 先获取市场列表
    await fetchCryptoMarkets();
    
    // 连接 WebSocket
    await orderBookManager.connect();
    
    // 订阅市场（fetchCryptoMarkets 已经做了）
    Logger.success(`✅ WebSocket 已连接，订阅了 ${orderBookManager.subscribedCount} 个 token`);
};

/**
 * 扫描套利机会 - 跨池子策略
 */
export const scanArbitrageOpportunities = async (silent: boolean = false): Promise<ArbitrageOpportunity[]> => {
    // 只在需要时刷新市场
    if (cachedMarkets.length === 0) {
        await fetchCryptoMarkets();
    }
    
    // 检查 WebSocket 是否有新鲜数据
    if (!orderBookManager.hasFreshData()) {
        return [];
    }
    
    const opportunities: ArbitrageOpportunity[] = [];
    
    // 按时间段分组市场
    const groups: Map<TimeGroup, Array<{
        conditionId: string;
        market: PolymarketMarket;
        upToken: any;
        downToken: any;
        upBook: OrderBookData;
        downBook: OrderBookData;
    }>> = new Map();
    
    for (const [conditionId, { market, upToken, downToken }] of marketTokenMap) {
        const upBook = orderBookManager.getOrderBook(upToken.token_id);
        const downBook = orderBookManager.getOrderBook(downToken.token_id);
        
        if (!upBook || !downBook) continue;
        
        const timeGroup = getTimeGroup(market.slug);
        if (!groups.has(timeGroup)) {
            groups.set(timeGroup, []);
        }
        groups.get(timeGroup)!.push({ conditionId, market, upToken, downToken, upBook, downBook });
    }
    
    // 在每个时间段组内寻找套利机会
    for (const [timeGroup, markets] of groups) {
        if (markets.length === 0) continue;
        
        // 检查组级别冷却（防止同一组重复触发）
        if (isGroupOnCooldown(timeGroup)) {
            continue;
        }
        
        // 找出组内最便宜的 Up 和最便宜的 Down（必须有深度 > 0）
        let cheapestUp: typeof markets[0] | null = null;
        let cheapestDown: typeof markets[0] | null = null;
        
        for (const m of markets) {
            // 选择最便宜的 Up（深度必须 >= 1）
            if (m.upBook.bestAskSize >= 1 && m.upBook.bestAsk > 0.01) {
                if (!cheapestUp || m.upBook.bestAsk < cheapestUp.upBook.bestAsk) {
                    cheapestUp = m;
                }
            }
            // 选择最便宜的 Down（深度必须 >= 1）
            if (m.downBook.bestAskSize >= 1 && m.downBook.bestAsk > 0.01) {
                if (!cheapestDown || m.downBook.bestAsk < cheapestDown.downBook.bestAsk) {
                    cheapestDown = m;
                }
            }
        }
        
        // 如果找不到有深度的 Up 或 Down，记录原因并跳过
        if (!cheapestUp || !cheapestDown) {
            // 诊断：为什么这个时间组没有有效机会
            if (!silent && markets.length > 0) {
                const noUpDepth = markets.every(m => m.upBook.bestAskSize < 1 || m.upBook.bestAsk < 0.01);
                const noDownDepth = markets.every(m => m.downBook.bestAskSize < 1 || m.downBook.bestAsk < 0.01);
                if (noUpDepth || noDownDepth) {
                    Logger.warning(`⚠️ ${timeGroup}: ${noUpDepth ? 'Up' : ''}${noUpDepth && noDownDepth ? '+' : ''}${noDownDepth ? 'Down' : ''} 深度不足`);
                }
            }
            continue;
        }
        
        // 获取组合仓位分析
        const groupAnalysis = getGroupCostAnalysis(timeGroup);
        
        // 计算跨池组合成本
        const crossPoolCost = cheapestUp.upBook.bestAsk + cheapestDown.downBook.bestAsk;
        const crossPoolProfit = (1 - crossPoolCost) * 100;
        const isCrossPool = cheapestUp.conditionId !== cheapestDown.conditionId;
        
        // ============ 核心套利条件 ============
        const isRealArbitrage = crossPoolCost < 0.995;
        
        // 跨池套利单边最低价格检查：避免在走势极端时进行高风险套利
        const upPriceTooLow = cheapestUp.upBook.bestAsk < CONFIG.MIN_CROSS_POOL_SINGLE_PRICE;
        const downPriceTooLow = cheapestDown.downBook.bestAsk < CONFIG.MIN_CROSS_POOL_SINGLE_PRICE;
        
        // 调试日志：每10秒输出一次当前价格状态
        const debugKey = `crosspool_${timeGroup}`;
        const lastDebug = scanCooldown.get(debugKey) || 0;
        const now = Date.now();
        if (now - lastDebug >= 10000) {
            scanCooldown.set(debugKey, now);
            const upAsset = cheapestUp.market.slug.toLowerCase().includes('btc') ? 'BTC' : 'ETH';
            const downAsset = cheapestDown.market.slug.toLowerCase().includes('btc') ? 'BTC' : 'ETH';
            Logger.info(`🔍 [${timeGroup}] ${upAsset}↑$${cheapestUp.upBook.bestAsk.toFixed(2)}(${cheapestUp.upBook.bestAskSize.toFixed(0)}) + ${downAsset}↓$${cheapestDown.downBook.bestAsk.toFixed(2)}(${cheapestDown.downBook.bestAskSize.toFixed(0)}) = $${crossPoolCost.toFixed(3)} | 利润${crossPoolProfit.toFixed(1)}%`);
        }
        
        if (isCrossPool && (upPriceTooLow || downPriceTooLow)) {
            // 跨池套利时，任何一边价格太低都跳过
            if (now - lastDebug < 1000) { // 刚输出过价格，补充跳过原因
                Logger.warning(`   ⚠️ 跳过: 单边价格 < ${CONFIG.MIN_CROSS_POOL_SINGLE_PRICE} (${upPriceTooLow ? 'Up' : 'Down'}太低)`);
            }
            continue;
        }
        
        // 预测组合买入后的成本
        // 注意：$1 最低限制在 executor.ts 中检查，scanner 只负责发现机会
        const maxShares = Math.min(cheapestUp.upBook.bestAskSize, cheapestDown.downBook.bestAskSize);
        
        const groupPrediction = predictGroupCostAfterBuy(
            timeGroup,
            maxShares,
            cheapestUp.upBook.bestAsk,
            maxShares,
            cheapestDown.downBook.bestAsk
        );
        
        // 决定交易动作
        let tradingAction: 'buy_both' | 'buy_up_only' | 'buy_down_only' | 'wait' = 'wait';
        let priority = 0;
        
        const upIsCheap = cheapestUp.upBook.bestAsk < 0.50;
        const downIsCheap = cheapestDown.downBook.bestAsk < 0.50;
        
        // 获取价格和深度（已在选择时验证过）
        const upPrice = cheapestUp.upBook.bestAsk;
        const downPrice = cheapestDown.downBook.bestAsk;
        const upSize = cheapestUp.upBook.bestAskSize;
        const downSize = cheapestDown.downBook.bestAskSize;
        
        // 策略 1: 真正的套利机会（Up + Down < $1.00）
        if (isRealArbitrage && crossPoolProfit >= CONFIG.MIN_ARBITRAGE_PERCENT) {
            tradingAction = 'buy_both';
            priority = crossPoolProfit * 10 + (isCrossPool ? 5 : 0);
        }
        // 策略 2: 有仓位时的平衡操作
        else if (groupAnalysis.hasPosition) {
            // 2a: 当前组合成本仍有套利空间，可以加仓
            if (isRealArbitrage && crossPoolProfit >= CONFIG.MIN_ARBITRAGE_PERCENT && groupPrediction.newAvgCostPerPair < 0.995) {
                tradingAction = 'buy_both';
                priority = (1.0 - groupPrediction.newAvgCostPerPair) * 100;
            }
            // 2b: 组合需要更多 Up，且 Up 便宜
            else if (groupAnalysis.needMoreUp && upIsCheap) {
                const upOnlyPrediction = predictGroupCostAfterBuy(
                    timeGroup,
                    Math.min(cheapestUp.upBook.bestAskSize, Math.abs(groupAnalysis.imbalance) + 50),
                    upPrice,
                    0,
                    downPrice
                );
                if (upOnlyPrediction.newAvgCostPerPair < 0.995) {
                    tradingAction = 'buy_up_only';
                    priority = 8;
                }
            }
            // 2c: 组合需要更多 Down，且 Down 便宜
            else if (groupAnalysis.needMoreDown && downIsCheap) {
                const downOnlyPrediction = predictGroupCostAfterBuy(
                    timeGroup,
                    0,
                    upPrice,
                    Math.min(cheapestDown.downBook.bestAskSize, Math.abs(groupAnalysis.imbalance) + 50),
                    downPrice
                );
                if (downOnlyPrediction.newAvgCostPerPair < 0.995) {
                    tradingAction = 'buy_down_only';
                    priority = 8;
                }
            }
        }
        
        // 只添加有动作的机会
        if (tradingAction !== 'wait') {
            // 记录组级别冷却，防止重复扫描
            recordGroupScan(timeGroup);
            
            opportunities.push({
                conditionId: cheapestUp.conditionId,
                slug: cheapestUp.market.slug,
                title: `${timeGroup} 组合: ${cheapestUp.market.slug.split('-')[0].toUpperCase()} Up + ${cheapestDown.market.slug.split('-')[0].toUpperCase()} Down`,
                upToken: {
                    token_id: cheapestUp.upToken.token_id,
                    outcome: cheapestUp.upToken.outcome,
                    price: cheapestUp.upToken.price,
                },
                downToken: {
                    token_id: cheapestDown.downToken.token_id,
                    outcome: cheapestDown.downToken.outcome,
                    price: cheapestDown.downToken.price,
                },
                timeGroup,
                isCrossPool,
                upMarketSlug: cheapestUp.market.slug,
                downMarketSlug: cheapestDown.market.slug,
                downConditionId: cheapestDown.conditionId,
                upAskPrice: cheapestUp.upBook.bestAsk,
                downAskPrice: cheapestDown.downBook.bestAsk,
                upAskSize: cheapestUp.upBook.bestAskSize,
                downAskSize: cheapestDown.downBook.bestAskSize,
                combinedCost: crossPoolCost,
                profitPercent: crossPoolProfit,
                maxShares,
                endDate: cheapestUp.market.end_date_iso,
                upIsCheap,
                downIsCheap,
                priority,
                groupAnalysis: {
                    hasPosition: groupAnalysis.hasPosition,
                    currentAvgCost: groupAnalysis.avgCostPerPair,
                    currentProfit: groupAnalysis.currentProfit,
                    imbalance: groupAnalysis.imbalance,
                    needMoreUp: groupAnalysis.needMoreUp,
                    needMoreDown: groupAnalysis.needMoreDown,
                    predictedAvgCost: groupPrediction.newAvgCostPerPair,
                    predictedProfit: groupPrediction.newProfit,
                    worthBuying: groupPrediction.worthBuying,
                },
                eventAnalysis: {
                    hasPosition: groupAnalysis.hasPosition,
                    currentAvgCost: groupAnalysis.avgCostPerPair,
                    currentProfit: groupAnalysis.currentProfit,
                    imbalance: groupAnalysis.imbalance,
                    needMoreUp: groupAnalysis.needMoreUp,
                    needMoreDown: groupAnalysis.needMoreDown,
                    predictedAvgCost: groupPrediction.newAvgCostPerPair,
                    predictedProfit: groupPrediction.newProfit,
                    worthBuying: groupPrediction.worthBuying,
                },
                tradingAction,
            });
        }
    }
    
    // 按优先级排序
    opportunities.sort((a, b) => b.priority - a.priority);
    
    return opportunities;
};

/**
 * 打印套利机会
 */
export const printOpportunities = (opportunities: ArbitrageOpportunity[]) => {
    if (opportunities.length === 0) {
        Logger.warning('未找到套利机会');
        return;
    }
    
    Logger.success(`找到 ${opportunities.length} 个套利机会！`);
    Logger.divider();
    
    for (const opp of opportunities) {
        const maxProfit = opp.maxShares * (1 - opp.combinedCost);
        const endTime = new Date(opp.endDate).toLocaleString('zh-CN');
        
        const upTag = opp.upIsCheap ? '💰' : '';
        const downTag = opp.downIsCheap ? '💰' : '';
        
        console.log(`📊 ${opp.title.slice(0, 55)}...`);
        console.log(`   Up:   $${opp.upAskPrice.toFixed(3)} ${upTag} (${opp.upAskSize.toFixed(1)} 可买)`);
        console.log(`   Down: $${opp.downAskPrice.toFixed(3)} ${downTag} (${opp.downAskSize.toFixed(1)} 可买)`);
        console.log(`   组合成本: $${opp.combinedCost.toFixed(4)}`);
        console.log(`   💰 利润率: ${opp.profitPercent.toFixed(2)}%`);
        console.log(`   📈 最大可套利: ${opp.maxShares.toFixed(1)} shares (利润 $${maxProfit.toFixed(2)})`);
        console.log(`   ⏰ 结算时间: ${endTime}`);
        Logger.divider();
    }
};

/**
 * 获取 WebSocket 状态
 */
export const getWebSocketStatus = () => {
    return {
        connected: orderBookManager.connected,
        subscribedTokens: orderBookManager.subscribedCount,
        cachedOrderBooks: orderBookManager.cachedCount,
    };
};

/**
 * 获取当前所有市场的实时价格（用于调试）
 */
export const getCurrentPrices = (): { market: string; upAsk: number | null; downAsk: number | null; combined: number | null }[] => {
    const prices: { market: string; upAsk: number | null; downAsk: number | null; combined: number | null }[] = [];
    
    for (const [conditionId, { market, upToken, downToken }] of marketTokenMap) {
        const upBook = orderBookManager.getOrderBook(upToken.token_id);
        const downBook = orderBookManager.getOrderBook(downToken.token_id);
        
        const upAsk = upBook?.bestAsk ?? null;
        const downAsk = downBook?.bestAsk ?? null;
        const combined = (upAsk !== null && downAsk !== null) ? upAsk + downAsk : null;
        
        prices.push({
            market: market.question.slice(0, 40),
            upAsk,
            downAsk,
            combined,
        });
    }
    
    return prices;
};

/**
 * 获取调试信息
 */
export const getDebugInfo = (): string => {
    const wsBooks = orderBookManager.cachedCount;
    const mapTokens = marketTokenMap.size * 2;
    
    let matched = 0;
    let missing: string[] = [];
    
    for (const [_, { market, upToken, downToken }] of marketTokenMap) {
        const upBook = orderBookManager.getOrderBook(upToken.token_id);
        const downBook = orderBookManager.getOrderBook(downToken.token_id);
        
        if (upBook) matched++;
        else missing.push(`${market.slug.slice(0, 20)}/Up`);
        
        if (downBook) matched++;
        else missing.push(`${market.slug.slice(0, 20)}/Down`);
    }
    
    if (missing.length > 0) {
        return `WS有${wsBooks}个book, 需要${mapTokens}个, 匹配${matched}个, 缺失: ${missing.slice(0, 4).join(', ')}`;
    }
    
    return `WS有${wsBooks}个book, 需要${mapTokens}个, 全部匹配✅`;
};

/**
 * 生成同池对冲补仓机会
 */
export const generateHedgeOpportunities = (timeGroup: TimeGroup): ArbitrageOpportunity[] => {
    const opportunities: ArbitrageOpportunity[] = [];
    
    if (isHedgeCompleted(timeGroup)) {
        return opportunities;
    }
    
    if (!canExecuteHedge(timeGroup)) {
        return opportunities;
    }
    
    let btcMarket: {
        conditionId: string;
        market: PolymarketMarket;
        upToken: MarketToken;
        downToken: MarketToken;
        upBook: OrderBookData;
        downBook: OrderBookData;
    } | null = null;
    
    let ethMarket: {
        conditionId: string;
        market: PolymarketMarket;
        upToken: MarketToken;
        downToken: MarketToken;
        upBook: OrderBookData;
        downBook: OrderBookData;
    } | null = null;
    
    for (const [conditionId, { market, upToken, downToken }] of marketTokenMap) {
        const upBook = orderBookManager.getOrderBook(upToken.token_id);
        const downBook = orderBookManager.getOrderBook(downToken.token_id);
        
        if (!upBook || !downBook) continue;
        
        const marketTimeGroup = getTimeGroup(market.slug);
        if (marketTimeGroup !== timeGroup) continue;
        
        const isBtc = market.slug.toLowerCase().includes('btc') || market.slug.toLowerCase().includes('bitcoin');
        
        if (isBtc) {
            btcMarket = { conditionId, market, upToken, downToken, upBook, downBook };
        } else {
            ethMarket = { conditionId, market, upToken, downToken, upBook, downBook };
        }
    }
    
    if (!btcMarket || !ethMarket) {
        return opportunities;
    }
    
    if (!isHedging(timeGroup)) {
        const summary = getGroupPositionSummary(timeGroup);
        
        Logger.info(`🔍 [对冲调试] 仓位汇总: BTC Up=${summary.btcUpShares.toFixed(0)} Down=${summary.btcDownShares.toFixed(0)} | ETH Up=${summary.ethUpShares.toFixed(0)} Down=${summary.ethDownShares.toFixed(0)} | 总成本=$${summary.totalCost.toFixed(2)}`);
        
        if (summary.totalCost === 0) {
            Logger.warning(`🔍 [对冲调试] 没有持仓，跳过对冲`);
            return opportunities;
        }
        
        const hedgeInfo = calculateHedgeNeeded(
            summary,
            btcMarket.upBook.bestAsk,
            btcMarket.downBook.bestAsk,
            ethMarket.upBook.bestAsk,
            ethMarket.downBook.bestAsk
        );
        
        const currentCombo = btcMarket.downBook.bestAsk + ethMarket.upBook.bestAsk;
        const hedgeCombo = btcMarket.upBook.bestAsk + ethMarket.downBook.bestAsk;
        
        Logger.info(`🔍 [对冲分析]`);
        Logger.info(`   原成本: $${summary.totalCost.toFixed(2)} | 仓位: BTC Down ${summary.btcDownShares.toFixed(0)} + ETH Up ${summary.ethUpShares.toFixed(0)}`);
        Logger.info(`   当前组合价: $${currentCombo.toFixed(2)} | 对冲组合价: $${hedgeCombo.toFixed(2)}`);
        Logger.info(`   ${hedgeInfo.breakEvenReason}`);
        
        if (!hedgeInfo.canBreakEven) {
            Logger.warning(`⚠️ 对冲后仍有亏损，但远好于双输 100% 归零！`);
            Logger.warning(`   预期亏损: $${hedgeInfo.expectedLoss.toFixed(0)} (${hedgeInfo.expectedLossPercent.toFixed(1)}%)`);
            Logger.warning(`   对比双输: $${summary.totalCost.toFixed(0)} (100%)`);
        }
        
        if (!hedgeInfo.needHedge) {
            Logger.warning(`🔍 [对冲调试] 不需要对冲（仓位已平衡）`);
            return opportunities;
        }
        
        startHedging(timeGroup, {
            btcUp: hedgeInfo.btcUpNeeded,
            btcDown: hedgeInfo.btcDownNeeded,
            ethUp: hedgeInfo.ethUpNeeded,
            ethDown: hedgeInfo.ethDownNeeded,
        });
        
        Logger.warning(`   当前仓位: BTC Up=${summary.btcUpShares.toFixed(0)} Down=${summary.btcDownShares.toFixed(0)} | ETH Up=${summary.ethUpShares.toFixed(0)} Down=${summary.ethDownShares.toFixed(0)}`);
        Logger.warning(`   预计对冲成本: $${hedgeInfo.hedgeCost.toFixed(2)}`);
    }
    
    const remaining = getRemainingHedge(timeGroup);
    if (!remaining) {
        return opportunities;
    }
    
    if (remaining.btcUp === 0 && remaining.btcDown === 0 && 
        remaining.ethUp === 0 && remaining.ethDown === 0) {
        completeHedging(timeGroup);
        return opportunities;
    }
    
    if (shouldPrintHedgeLog(timeGroup)) {
        Logger.warning(`🛡️ [${timeGroup}] 对冲进度:`);
        if (remaining.btcUp > 0) Logger.warning(`   → 剩余 ${remaining.btcUp} BTC Up`);
        if (remaining.btcDown > 0) Logger.warning(`   → 剩余 ${remaining.btcDown} BTC Down`);
        if (remaining.ethUp > 0) Logger.warning(`   → 剩余 ${remaining.ethUp} ETH Up`);
        if (remaining.ethDown > 0) Logger.warning(`   → 剩余 ${remaining.ethDown} ETH Down`);
    }
    
    const createHedgeOpp = (
        market: typeof btcMarket,
        side: 'up' | 'down',
        sharesNeeded: number,
        hedgeSide: 'btcUp' | 'btcDown' | 'ethUp' | 'ethDown'
    ): ArbitrageOpportunity | null => {
        const book = side === 'up' ? market!.upBook : market!.downBook;
        const token = side === 'up' ? market!.upToken : market!.downToken;
        const shares = Math.min(sharesNeeded, book.bestAskSize);
        
        if (shares < 1) return null;
        
        return {
            conditionId: market!.conditionId,
            slug: market!.market.slug,
            title: `${timeGroup} 对冲: 补 ${side === 'up' ? 'Up' : 'Down'}`,
            upToken: side === 'up' ? {
                token_id: token.token_id,
                outcome: token.outcome,
                price: token.price,
            } : { token_id: '', outcome: 'Up', price: 0 },
            downToken: side === 'down' ? {
                token_id: token.token_id,
                outcome: token.outcome,
                price: token.price,
            } : { token_id: '', outcome: 'Down', price: 0 },
            timeGroup,
            isCrossPool: false,
            upMarketSlug: market!.market.slug,
            downMarketSlug: market!.market.slug,
            downConditionId: market!.conditionId,
            upAskPrice: side === 'up' ? book.bestAsk : 0,
            downAskPrice: side === 'down' ? book.bestAsk : 0,
            upAskSize: side === 'up' ? book.bestAskSize : 0,
            downAskSize: side === 'down' ? book.bestAskSize : 0,
            combinedCost: book.bestAsk,
            profitPercent: 0,
            maxShares: shares,
            endDate: market!.market.end_date_iso,
            upIsCheap: side === 'up',
            downIsCheap: side === 'down',
            priority: 100,
            groupAnalysis: { hasPosition: true, currentAvgCost: 0, currentProfit: 0, imbalance: 0, needMoreUp: side === 'up', needMoreDown: side === 'down', predictedAvgCost: 0, predictedProfit: 0, worthBuying: true },
            eventAnalysis: { hasPosition: true, currentAvgCost: 0, currentProfit: 0, imbalance: 0, needMoreUp: side === 'up', needMoreDown: side === 'down', predictedAvgCost: 0, predictedProfit: 0, worthBuying: true },
            tradingAction: side === 'up' ? 'buy_up_only' : 'buy_down_only',
            isHedge: true,
            hedgeSide,
        };
    };
    
    if (remaining.btcUp > 0) {
        const opp = createHedgeOpp(btcMarket, 'up', remaining.btcUp, 'btcUp');
        if (opp) opportunities.push(opp);
    }
    if (remaining.btcDown > 0) {
        const opp = createHedgeOpp(btcMarket, 'down', remaining.btcDown, 'btcDown');
        if (opp) opportunities.push(opp);
    }
    if (remaining.ethUp > 0) {
        const opp = createHedgeOpp(ethMarket, 'up', remaining.ethUp, 'ethUp');
        if (opp) opportunities.push(opp);
    }
    if (remaining.ethDown > 0) {
        const opp = createHedgeOpp(ethMarket, 'down', remaining.ethDown, 'ethDown');
        if (opp) opportunities.push(opp);
    }
    
    return opportunities;
};

// 同池诊断日志冷却
let lastSamePoolDiagTime = 0;
const SAME_POOL_DIAG_COOLDOWN = 30000;
let lastEmergencyLogTime = 0;

/**
 * 计算平衡度（0-100%）
 */
export const calculateBalancePercent = (upShares: number, downShares: number): number => {
    if (upShares === 0 && downShares === 0) return 100;
    if (upShares === 0 || downShares === 0) return 0;
    return Math.min(upShares, downShares) / Math.max(upShares, downShares) * 100;
};

/**
 * 检查是否需要紧急平衡
 */
export const checkEmergencyBalance = (
    timeGroup: TimeGroup,
    btcBalance: number,
    ethBalance: number,
    endDate: string
): { isEmergency: boolean; maxLossPercent: number } => {
    if (!CONFIG.EMERGENCY_BALANCE_ENABLED) {
        return { isEmergency: false, maxLossPercent: 0 };
    }
    
    const endTime = new Date(endDate).getTime();
    const now = Date.now();
    const remainingSeconds = Math.max(0, (endTime - now) / 1000);
    
    if (remainingSeconds > CONFIG.EMERGENCY_BALANCE_SECONDS) {
        return { isEmergency: false, maxLossPercent: 0 };
    }
    
    const minBalance = Math.min(btcBalance, ethBalance);
    if (minBalance >= CONFIG.EMERGENCY_BALANCE_THRESHOLD) {
        return { isEmergency: false, maxLossPercent: 0 };
    }
    
    return { 
        isEmergency: true, 
        maxLossPercent: CONFIG.EMERGENCY_BALANCE_MAX_LOSS 
    };
};

/**
 * 生成同池增持机会（基于平均持仓价）
 */
export const generateSamePoolOpportunities = (timeGroup: TimeGroup): ArbitrageOpportunity[] => {
    if (!CONFIG.SAME_POOL_REBALANCE_ENABLED) return [];
    
    const opportunities: ArbitrageOpportunity[] = [];
    const avgPrices = getAssetAvgPrices(timeGroup);
    
    const btcBalance = avgPrices.btc ? calculateBalancePercent(avgPrices.btc.upShares, avgPrices.btc.downShares) : 100;
    const ethBalance = avgPrices.eth ? calculateBalancePercent(avgPrices.eth.upShares, avgPrices.eth.downShares) : 100;
    
    const now = Date.now();
    const shouldLog = now - lastSamePoolDiagTime >= SAME_POOL_DIAG_COOLDOWN;
    if (shouldLog) {
        lastSamePoolDiagTime = now;
        if (avgPrices.btc) {
            Logger.info(`📊 [同池诊断] BTC: Up=${avgPrices.btc.upShares.toFixed(0)}@$${avgPrices.btc.upAvgPrice.toFixed(3)} Down=${avgPrices.btc.downShares.toFixed(0)}@$${avgPrices.btc.downAvgPrice.toFixed(3)} imbalance=${avgPrices.btc.imbalance.toFixed(0)} 平衡${btcBalance.toFixed(0)}%`);
        }
        if (avgPrices.eth) {
            Logger.info(`📊 [同池诊断] ETH: Up=${avgPrices.eth.upShares.toFixed(0)}@$${avgPrices.eth.upAvgPrice.toFixed(3)} Down=${avgPrices.eth.downShares.toFixed(0)}@$${avgPrices.eth.downAvgPrice.toFixed(3)} imbalance=${avgPrices.eth.imbalance.toFixed(0)} 平衡${ethBalance.toFixed(0)}%`);
        }
    }
    
    let btcMarketData: { conditionId: string; market: PolymarketMarket; upToken: any; downToken: any; upBook: OrderBookData; downBook: OrderBookData } | null = null;
    let ethMarketData: { conditionId: string; market: PolymarketMarket; upToken: any; downToken: any; upBook: OrderBookData; downBook: OrderBookData } | null = null;
    
    for (const [conditionId, { market, upToken, downToken }] of marketTokenMap) {
        const upBook = orderBookManager.getOrderBook(upToken.token_id);
        const downBook = orderBookManager.getOrderBook(downToken.token_id);
        
        if (!upBook || !downBook) continue;
        
        const marketTimeGroup = getTimeGroup(market.slug);
        if (marketTimeGroup !== timeGroup) continue;
        
        const isBtc = market.slug.toLowerCase().includes('btc') || market.slug.toLowerCase().includes('bitcoin');
        
        if (isBtc) {
            btcMarketData = { conditionId, market, upToken, downToken, upBook, downBook };
        } else {
            ethMarketData = { conditionId, market, upToken, downToken, upBook, downBook };
        }
    }
    
    if (!btcMarketData || !ethMarketData) return opportunities;
    
    const endDate = btcMarketData.market.end_date_iso || '';
    const emergency = checkEmergencyBalance(timeGroup, btcBalance, ethBalance, endDate);
    const safetyMargin = CONFIG.SAME_POOL_SAFETY_MARGIN / 100;
    
    // BTC 池：Up > Down，买入 Down
    if (avgPrices.btc && avgPrices.btc.imbalance > 0) {
        const btcUpAvgPrice = avgPrices.btc.upAvgPrice;
        const asks = btcMarketData.downBook.asks || [];
        
        let maxPriceLevel: number;
        if (emergency.isEmergency) {
            maxPriceLevel = 1 + (emergency.maxLossPercent / 100) - btcUpAvgPrice;
        } else {
            maxPriceLevel = 1 - safetyMargin - btcUpAvgPrice;
        }
        
        let totalAvailableSize = 0;
        let weightedAvgPrice = 0;
        
        for (const level of asks) {
            if (level.price < maxPriceLevel) {
                totalAvailableSize += level.size;
                weightedAvgPrice += level.price * level.size;
            }
        }
        
        const avgAskPrice = totalAvailableSize > 0 ? weightedAvgPrice / totalAvailableSize : 0;
        const combinedCost = btcUpAvgPrice + avgAskPrice;
        
        if (shouldLog && btcUpAvgPrice > 0) {
            const levelsCount = asks.filter((l: any) => l.price < maxPriceLevel).length;
            const modeTag = emergency.isEmergency ? '🚨紧急' : '正常';
            Logger.info(`   BTC同池[${modeTag}]: 平均Up $${btcUpAvgPrice.toFixed(3)} + 深度${levelsCount}档共${totalAvailableSize.toFixed(0)}@$${avgAskPrice.toFixed(3)} = $${combinedCost.toFixed(3)} 限价$${maxPriceLevel.toFixed(3)}`);
        }
        
        // 检查金额是否 >= $1（不是股数）
        const totalAmount1 = totalAvailableSize * avgAskPrice;
        if (totalAmount1 >= CONFIG.MIN_ORDER_AMOUNT_USD && btcUpAvgPrice > 0) {
            const profitPercent = ((1 - combinedCost) / combinedCost) * 100;
            const neededShares = avgPrices.btc.imbalance;
            const maxShares = Math.min(neededShares, totalAvailableSize);
            
            // 检查实际要买的金额是否 >= $1
            const actualAmount1 = maxShares * avgAskPrice;
            if (actualAmount1 >= CONFIG.MIN_ORDER_AMOUNT_USD) {
                const defaultAnalysis = {
                    hasPosition: true,
                    currentAvgCost: 0,
                    currentProfit: 0,
                    imbalance: avgPrices.btc.imbalance,
                    needMoreUp: false,
                    needMoreDown: true,
                    predictedAvgCost: combinedCost,
                    predictedProfit: profitPercent,
                    worthBuying: true,
                };
                
                opportunities.push({
                    conditionId: btcMarketData.conditionId,
                    slug: btcMarketData.market.slug,
                    title: `${timeGroup} BTC 同池增持`,
                    upToken: btcMarketData.upToken,
                    downToken: btcMarketData.downToken,
                    timeGroup,
                    isCrossPool: false,
                    upMarketSlug: btcMarketData.market.slug,
                    downMarketSlug: btcMarketData.market.slug,
                    downConditionId: btcMarketData.conditionId,
                    upAskPrice: 0,
                    downAskPrice: avgAskPrice,
                    upAskSize: 0,
                    downAskSize: totalAvailableSize,
                    combinedCost,
                    profitPercent,
                    maxShares,
                    endDate: btcMarketData.market.end_date_iso || '',
                    upIsCheap: false,
                    downIsCheap: true,
                    priority: 5,
                    tradingAction: 'buy_down_only',
                    groupAnalysis: defaultAnalysis,
                    eventAnalysis: defaultAnalysis,
                    isSamePoolRebalance: true,
                    rebalanceAsset: 'btc',
                    rebalanceSide: 'down',
                } as ArbitrageOpportunity);
            }
        }
    }
    
    // BTC 池：Down > Up，买入 Up
    if (avgPrices.btc && avgPrices.btc.imbalance < 0) {
        const btcDownAvgPrice = avgPrices.btc.downAvgPrice;
        const asks = btcMarketData.upBook.asks || [];
        
        let maxPriceLevel: number;
        if (emergency.isEmergency) {
            maxPriceLevel = 1 + (emergency.maxLossPercent / 100) - btcDownAvgPrice;
        } else {
            maxPriceLevel = 1 - safetyMargin - btcDownAvgPrice;
        }
        
        let totalAvailableSize = 0;
        let weightedAvgPrice = 0;
        
        for (const level of asks) {
            if (level.price < maxPriceLevel) {
                totalAvailableSize += level.size;
                weightedAvgPrice += level.price * level.size;
            }
        }
        
        const avgAskPrice = totalAvailableSize > 0 ? weightedAvgPrice / totalAvailableSize : 0;
        const combinedCost = avgAskPrice + btcDownAvgPrice;
        
        // 检查金额是否 >= $1（不是股数）
        const totalAmount2 = totalAvailableSize * avgAskPrice;
        if (totalAmount2 >= CONFIG.MIN_ORDER_AMOUNT_USD && btcDownAvgPrice > 0) {
            const profitPercent = ((1 - combinedCost) / combinedCost) * 100;
            const neededShares = Math.abs(avgPrices.btc.imbalance);
            const maxShares = Math.min(neededShares, totalAvailableSize);
            
            // 检查实际要买的金额是否 >= $1
            const actualAmount2 = maxShares * avgAskPrice;
            if (actualAmount2 >= CONFIG.MIN_ORDER_AMOUNT_USD) {
                const defaultAnalysis = {
                    hasPosition: true,
                    currentAvgCost: 0,
                    currentProfit: 0,
                    imbalance: avgPrices.btc.imbalance,
                    needMoreUp: true,
                    needMoreDown: false,
                    predictedAvgCost: combinedCost,
                    predictedProfit: profitPercent,
                    worthBuying: true,
                };
                
                opportunities.push({
                    conditionId: btcMarketData.conditionId,
                    slug: btcMarketData.market.slug,
                    title: `${timeGroup} BTC 同池增持`,
                    upToken: btcMarketData.upToken,
                    downToken: btcMarketData.downToken,
                    timeGroup,
                    isCrossPool: false,
                    upMarketSlug: btcMarketData.market.slug,
                    downMarketSlug: btcMarketData.market.slug,
                    downConditionId: btcMarketData.conditionId,
                    upAskPrice: avgAskPrice,
                    downAskPrice: 0,
                    upAskSize: totalAvailableSize,
                    downAskSize: 0,
                    combinedCost,
                    profitPercent,
                    maxShares,
                    endDate: btcMarketData.market.end_date_iso || '',
                    upIsCheap: true,
                    downIsCheap: false,
                    priority: 5,
                    tradingAction: 'buy_up_only',
                    groupAnalysis: defaultAnalysis,
                    eventAnalysis: defaultAnalysis,
                    isSamePoolRebalance: true,
                    rebalanceAsset: 'btc',
                    rebalanceSide: 'up',
                } as ArbitrageOpportunity);
            }
        }
    }
    
    // ETH 池：Down > Up，买入 Up
    if (avgPrices.eth && avgPrices.eth.imbalance < 0) {
        const ethDownAvgPrice = avgPrices.eth.downAvgPrice;
        const asks = ethMarketData.upBook.asks || [];
        
        let maxPriceLevel: number;
        if (emergency.isEmergency) {
            maxPriceLevel = 1 + (emergency.maxLossPercent / 100) - ethDownAvgPrice;
        } else {
            maxPriceLevel = 1 - safetyMargin - ethDownAvgPrice;
        }
        
        let totalAvailableSize = 0;
        let weightedAvgPrice = 0;
        
        for (const level of asks) {
            if (level.price < maxPriceLevel) {
                totalAvailableSize += level.size;
                weightedAvgPrice += level.price * level.size;
            }
        }
        
        const avgAskPrice = totalAvailableSize > 0 ? weightedAvgPrice / totalAvailableSize : 0;
        const combinedCost = avgAskPrice + ethDownAvgPrice;
        
        if (shouldLog && ethDownAvgPrice > 0) {
            const levelsCount = asks.filter((l: any) => l.price < maxPriceLevel).length;
            const modeTag = emergency.isEmergency ? '🚨紧急' : '正常';
            Logger.info(`   ETH同池[${modeTag}]: 深度${levelsCount}档共${totalAvailableSize.toFixed(0)}@$${avgAskPrice.toFixed(3)} + 平均Down $${ethDownAvgPrice.toFixed(3)} = $${combinedCost.toFixed(3)} 限价$${maxPriceLevel.toFixed(3)}`);
        }
        
        // 检查金额是否 >= $1（不是股数）
        const totalAmount3 = totalAvailableSize * avgAskPrice;
        if (totalAmount3 >= CONFIG.MIN_ORDER_AMOUNT_USD && ethDownAvgPrice > 0) {
            const profitPercent = ((1 - combinedCost) / combinedCost) * 100;
            const neededShares = Math.abs(avgPrices.eth.imbalance);
            const maxShares = Math.min(neededShares, totalAvailableSize);
            
            // 检查实际要买的金额是否 >= $1
            const actualAmount3 = maxShares * avgAskPrice;
            if (actualAmount3 >= CONFIG.MIN_ORDER_AMOUNT_USD) {
                const defaultAnalysis = {
                    hasPosition: true,
                    currentAvgCost: 0,
                    currentProfit: 0,
                    imbalance: avgPrices.eth.imbalance,
                    needMoreUp: true,
                    needMoreDown: false,
                    predictedAvgCost: combinedCost,
                    predictedProfit: profitPercent,
                    worthBuying: true,
                };
                
                opportunities.push({
                    conditionId: ethMarketData.conditionId,
                    slug: ethMarketData.market.slug,
                    title: `${timeGroup} ETH 同池增持`,
                    upToken: ethMarketData.upToken,
                    downToken: ethMarketData.downToken,
                    timeGroup,
                    isCrossPool: false,
                    upMarketSlug: ethMarketData.market.slug,
                    downMarketSlug: ethMarketData.market.slug,
                    downConditionId: ethMarketData.conditionId,
                    upAskPrice: avgAskPrice,
                    downAskPrice: 0,
                    upAskSize: totalAvailableSize,
                    downAskSize: 0,
                    combinedCost,
                    profitPercent,
                    maxShares,
                    endDate: ethMarketData.market.end_date_iso || '',
                    upIsCheap: true,
                    downIsCheap: false,
                    priority: 5,
                    tradingAction: 'buy_up_only',
                    groupAnalysis: defaultAnalysis,
                    eventAnalysis: defaultAnalysis,
                    isSamePoolRebalance: true,
                    rebalanceAsset: 'eth',
                    rebalanceSide: 'up',
                } as ArbitrageOpportunity);
            }
        }
    }
    
    // ETH 池：Up > Down，买入 Down
    if (avgPrices.eth && avgPrices.eth.imbalance > 0) {
        const ethUpAvgPrice = avgPrices.eth.upAvgPrice;
        const asks = ethMarketData.downBook.asks || [];
        
        let maxPriceLevel: number;
        if (emergency.isEmergency) {
            maxPriceLevel = 1 + (emergency.maxLossPercent / 100) - ethUpAvgPrice;
        } else {
            maxPriceLevel = 1 - safetyMargin - ethUpAvgPrice;
        }
        
        let totalAvailableSize = 0;
        let weightedAvgPrice = 0;
        
        for (const level of asks) {
            if (level.price < maxPriceLevel) {
                totalAvailableSize += level.size;
                weightedAvgPrice += level.price * level.size;
            }
        }
        
        const avgAskPrice = totalAvailableSize > 0 ? weightedAvgPrice / totalAvailableSize : 0;
        const combinedCost = ethUpAvgPrice + avgAskPrice;
        
        // 检查金额是否 >= $1（不是股数）
        const totalAmount4 = totalAvailableSize * avgAskPrice;
        if (totalAmount4 >= CONFIG.MIN_ORDER_AMOUNT_USD && ethUpAvgPrice > 0) {
            const profitPercent = ((1 - combinedCost) / combinedCost) * 100;
            const neededShares = avgPrices.eth.imbalance;
            const maxShares = Math.min(neededShares, totalAvailableSize);
            
            // 检查实际要买的金额是否 >= $1
            const actualAmount4 = maxShares * avgAskPrice;
            if (actualAmount4 >= CONFIG.MIN_ORDER_AMOUNT_USD) {
                const defaultAnalysis = {
                    hasPosition: true,
                    currentAvgCost: 0,
                    currentProfit: 0,
                    imbalance: avgPrices.eth.imbalance,
                    needMoreUp: false,
                    needMoreDown: true,
                    predictedAvgCost: combinedCost,
                    predictedProfit: profitPercent,
                    worthBuying: true,
                };
                
                opportunities.push({
                    conditionId: ethMarketData.conditionId,
                    slug: ethMarketData.market.slug,
                    title: `${timeGroup} ETH 同池增持`,
                    upToken: ethMarketData.upToken,
                    downToken: ethMarketData.downToken,
                    timeGroup,
                    isCrossPool: false,
                    upMarketSlug: ethMarketData.market.slug,
                    downMarketSlug: ethMarketData.market.slug,
                    downConditionId: ethMarketData.conditionId,
                    upAskPrice: 0,
                    downAskPrice: avgAskPrice,
                    upAskSize: 0,
                    downAskSize: totalAvailableSize,
                    combinedCost,
                    profitPercent,
                    maxShares,
                    endDate: ethMarketData.market.end_date_iso || '',
                    upIsCheap: false,
                    downIsCheap: true,
                    priority: 5,
                    tradingAction: 'buy_down_only',
                    groupAnalysis: defaultAnalysis,
                    eventAnalysis: defaultAnalysis,
                    isSamePoolRebalance: true,
                    rebalanceAsset: 'eth',
                    rebalanceSide: 'down',
                } as ArbitrageOpportunity);
            }
        }
    }
    
    return opportunities;
};

/**
 * 获取指定 timeGroup 的市场结束时间
 */
export const getMarketEndTime = (timeGroup: TimeGroup): string | null => {
    for (const market of cachedMarkets) {
        const is15min = market.slug.includes('15m') || market.slug.includes('15min');
        const marketTimeGroup: TimeGroup = is15min ? '15min' : '1hr';
        
        if (marketTimeGroup === timeGroup && market.end_date_iso) {
            return market.end_date_iso;
        }
    }
    return null;
};

export default {
    fetchCryptoMarkets,
    initWebSocket,
    scanArbitrageOpportunities,
    generateHedgeOpportunities,
    generateSamePoolOpportunities,
    printOpportunities,
    getWebSocketStatus,
    getCurrentPrices,
    getDebugInfo,
    getMarketEndTime,
};
