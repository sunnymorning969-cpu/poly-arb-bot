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
import { getEventCostAnalysis, predictCostAfterBuy } from './positions';

// 市场数据接口
export interface MarketToken {
    token_id: string;
    outcome: string;
    price: number;
}

export interface ArbitrageOpportunity {
    conditionId: string;
    slug: string;
    title: string;
    upToken: MarketToken;
    downToken: MarketToken;
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
    // 事件级策略（新增）
    eventAnalysis: {
        hasPosition: boolean;
        currentAvgCost: number;     // 当前平均成本
        currentProfit: number;      // 当前预期利润
        imbalance: number;          // 不平衡度
        needMoreUp: boolean;        // 需要更多 Up
        needMoreDown: boolean;      // 需要更多 Down
        predictedAvgCost: number;   // 买入后预测的平均成本
        predictedProfit: number;    // 买入后预测的利润
        worthBuying: boolean;       // 是否值得买入
    };
    // 交易建议
    tradingAction: 'buy_both' | 'buy_up_only' | 'buy_down_only' | 'wait';
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

// 市场缓存（30 秒刷新一次，确保 15 分钟事件能及时切换）
let cachedMarkets: PolymarketMarket[] = [];
let lastMarketFetch = 0;
const MARKET_CACHE_DURATION = 30000;  // 市场列表缓存 30 秒

// 市场 token 映射（用于快速查找）
let marketTokenMap = new Map<string, { market: PolymarketMarket; upToken: any; downToken: any }>();

/**
 * 根据当前 ET 时间生成市场 slug
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
    
    // === 1小时市场 ===
    const h12 = hour % 12 || 12;
    const ampm = hour >= 12 ? 'pm' : 'am';
    slugs.push(`bitcoin-up-or-down-${month}-${day}-${h12}${ampm}-et`);
    slugs.push(`ethereum-up-or-down-${month}-${day}-${h12}${ampm}-et`);
    
    // === 15分钟市场 ===
    const min15Start = Math.floor(minute / 15) * 15;
    const startEt = new Date(etDate);
    startEt.setUTCMinutes(min15Start, 0, 0);
    const timestamp = Math.floor((startEt.getTime() + 5 * 3600 * 1000) / 1000);
    
    slugs.push(`btc-updown-15m-${timestamp}`);
    slugs.push(`eth-updown-15m-${timestamp}`);
    
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
 * 获取 BTC/ETH Up/Down 市场（带缓存，60 秒刷新）
 */
export const fetchCryptoMarkets = async (): Promise<PolymarketMarket[]> => {
    const now = Date.now();
    
    // 市场列表不需要频繁更新，60 秒一次足够
    if (cachedMarkets.length > 0 && (now - lastMarketFetch) < MARKET_CACHE_DURATION) {
        return cachedMarkets;
    }
    
    try {
        // 根据当前时间生成 slug
        const slugs = generateMarketSlugs();
        
        // 并行获取所有市场
        const marketPromises = slugs.map(slug => fetchEventBySlug(slug));
        const results = await Promise.all(marketPromises);
        
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
            }
        }
        
        Logger.success(`📊 找到 ${cachedMarkets.length} 个 BTC/ETH Up/Down 市场`);
        
        // 清除旧的订单簿数据，订阅新的 token
        if (tokenIds.length > 0) {
            orderBookManager.clearStaleOrderBooks(tokenIds);
            orderBookManager.subscribe(tokenIds);
        }
        
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
 * 扫描套利机会（事件级套利策略）
 * 
 * 新策略：
 * 1. 不只看单笔 Up+Down < $1.00
 * 2. 考虑当前仓位的平均成本
 * 3. 考虑仓位不平衡度
 * 4. 即使 Up+Down >= $1.00，如果能改善整体仓位也值得交易
 */
export const scanArbitrageOpportunities = async (silent: boolean = false): Promise<ArbitrageOpportunity[]> => {
    // 检查是否需要刷新市场列表
    const now = Date.now();
    if (now - lastMarketFetch > MARKET_CACHE_DURATION) {
        await fetchCryptoMarkets();
    }
    
    // 检查 WebSocket 是否有新鲜数据
    if (!orderBookManager.hasFreshData()) {
        return [];
    }
    
    const opportunities: ArbitrageOpportunity[] = [];
    
    // 遍历所有市场
    for (const [conditionId, { market, upToken, downToken }] of marketTokenMap) {
        const upBook = orderBookManager.getOrderBook(upToken.token_id);
        const downBook = orderBookManager.getOrderBook(downToken.token_id);
        
        if (!upBook || !downBook) continue;
        
        const combinedCost = upBook.bestAsk + downBook.bestAsk;
        const profitPercent = (1 - combinedCost) * 100;
        const maxShares = Math.min(upBook.bestAskSize, downBook.bestAskSize);
        
        // 获取当前仓位分析
        const eventAnalysis = getEventCostAnalysis(market.condition_id);
        
        // 预测买入后的成本（假设两边各买 maxShares）
        const prediction = predictCostAfterBuy(
            market.condition_id,
            maxShares,
            upBook.bestAsk,
            maxShares,
            downBook.bestAsk
        );
        
        // 决定交易动作
        // 核心原则：必须保证整体平均成本 < $1.00，确保无论结果如何都是盈利
        // 不追求随机性，追求确定性盈利
        let tradingAction: 'buy_both' | 'buy_up_only' | 'buy_down_only' | 'wait' = 'wait';
        let priority = 0;
        
        // 策略 1: 新开仓 - 只有 combinedCost < $1.00 才开仓
        if (!eventAnalysis.hasPosition && combinedCost < 1.0 && profitPercent >= CONFIG.MIN_ARBITRAGE_PERCENT) {
            tradingAction = 'buy_both';
            priority = profitPercent * 10;  // 利润越高优先级越高
        }
        // 策略 2: 已有仓位加仓 - 只有买入后整体平均成本 < $1.00 才加仓
        else if (eventAnalysis.hasPosition) {
            // 双边加仓：必须保证买入后整体平均成本 < $1.00
            if (prediction.newAvgCostPerPair < 1.0) {
                tradingAction = 'buy_both';
                priority = (1.0 - prediction.newAvgCostPerPair) * 100;  // 成本越低优先级越高
            }
            // 单边平衡：仓位不平衡时，买入较少的一边
            else if (Math.abs(eventAnalysis.imbalance) > 5) {
                // 需要更多 Up
                if (eventAnalysis.needMoreUp && upBook.bestAsk < CONFIG.UP_PRICE_THRESHOLD) {
                    const upOnlyPrediction = predictCostAfterBuy(
                        market.condition_id,
                        Math.min(upBook.bestAskSize, Math.abs(eventAnalysis.imbalance)),
                        upBook.bestAsk,
                        0,
                        downBook.bestAsk
                    );
                    // 只有买入后整体平均成本 < $1.00 才买入
                    if (upOnlyPrediction.newAvgCostPerPair < 1.0) {
                        tradingAction = 'buy_up_only';
                        priority = 5;
                    }
                }
                // 需要更多 Down
                else if (eventAnalysis.needMoreDown && downBook.bestAsk < CONFIG.DOWN_PRICE_THRESHOLD) {
                    const downOnlyPrediction = predictCostAfterBuy(
                        market.condition_id,
                        0,
                        upBook.bestAsk,
                        Math.min(downBook.bestAskSize, Math.abs(eventAnalysis.imbalance)),
                        downBook.bestAsk
                    );
                    // 只有买入后整体平均成本 < $1.00 才买入
                    if (downOnlyPrediction.newAvgCostPerPair < 1.0) {
                        tradingAction = 'buy_down_only';
                        priority = 5;
                    }
                }
            }
        }
        
        // 只添加有动作的机会
        if (tradingAction !== 'wait') {
            const upIsCheap = upBook.bestAsk < CONFIG.UP_PRICE_THRESHOLD;
            const downIsCheap = downBook.bestAsk < CONFIG.DOWN_PRICE_THRESHOLD;
            
            opportunities.push({
                conditionId: market.condition_id,
                slug: market.slug,
                title: market.question,
                upToken: {
                    token_id: upToken.token_id,
                    outcome: upToken.outcome,
                    price: upToken.price,
                },
                downToken: {
                    token_id: downToken.token_id,
                    outcome: downToken.outcome,
                    price: downToken.price,
                },
                upAskPrice: upBook.bestAsk,
                downAskPrice: downBook.bestAsk,
                upAskSize: upBook.bestAskSize,
                downAskSize: downBook.bestAskSize,
                combinedCost,
                profitPercent,
                maxShares,
                endDate: market.end_date_iso,
                upIsCheap,
                downIsCheap,
                priority,
                eventAnalysis: {
                    hasPosition: eventAnalysis.hasPosition,
                    currentAvgCost: eventAnalysis.avgCostPerPair,
                    currentProfit: eventAnalysis.currentProfit,
                    imbalance: eventAnalysis.imbalance,
                    needMoreUp: eventAnalysis.needMoreUp,
                    needMoreDown: eventAnalysis.needMoreDown,
                    predictedAvgCost: prediction.newAvgCostPerPair,
                    predictedProfit: prediction.newProfit,
                    worthBuying: prediction.worthBuying,
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
    const mapTokens = marketTokenMap.size * 2;  // 每个市场 2 个 token
    
    // 检查每个市场的 token 是否在 orderBooks 中
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

export default {
    fetchCryptoMarkets,
    initWebSocket,
    scanArbitrageOpportunities,
    printOpportunities,
    getWebSocketStatus,
    getCurrentPrices,
    getDebugInfo,
};

