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

// 市场缓存（60 秒刷新一次即可）
let cachedMarkets: PolymarketMarket[] = [];
let lastMarketFetch = 0;
const MARKET_CACHE_DURATION = 60000;  // 市场列表缓存 60 秒

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
            Logger.warning(`   ❌ ${slug} - 无 events 数据`);
            return null;
        }
        
        const event = events[0];
        const markets = event.markets;
        
        if (!markets || !Array.isArray(markets) || markets.length === 0) {
            Logger.warning(`   ❌ ${slug} - 无 markets 数据`);
            return null;
        }
        
        // 找到有 Up/Down tokens 的 market
        for (const market of markets) {
            // outcomes 和 clobTokenIds 可能是字符串，需要解析
            let outcomes = market.outcomes;
            let clobTokenIds = market.clobTokenIds;
            let outcomePrices = market.outcomePrices;
            
            // 调试：打印原始类型
            Logger.info(`   🔍 原始: outcomes type=${typeof outcomes}, clobTokenIds type=${typeof clobTokenIds}`);
            
            // 如果是字符串，解析成数组
            if (typeof outcomes === 'string') {
                try { 
                    outcomes = JSON.parse(outcomes); 
                    Logger.info(`   ✅ outcomes 解析成功: ${JSON.stringify(outcomes)}`);
                } catch (e: any) {
                    Logger.error(`   ❌ outcomes 解析失败: ${e.message}`);
                }
            }
            if (typeof clobTokenIds === 'string') {
                try { 
                    clobTokenIds = JSON.parse(clobTokenIds); 
                    Logger.info(`   ✅ clobTokenIds 解析成功, 长度: ${clobTokenIds?.length}`);
                } catch (e: any) {
                    Logger.error(`   ❌ clobTokenIds 解析失败: ${e.message}`);
                }
            }
            if (typeof outcomePrices === 'string') {
                try { 
                    outcomePrices = JSON.parse(outcomePrices); 
                } catch {}
            }
            
            Logger.info(`   🔍 解析后: outcomes=${JSON.stringify(outcomes)}, isArray=${Array.isArray(outcomes)}, clobTokenIds长度=${Array.isArray(clobTokenIds) ? clobTokenIds.length : 'NOT_ARRAY'}`);
            
            if (outcomes && Array.isArray(outcomes) && outcomes.length === 2) {
                const outcomeNames = outcomes.map((o: string) => o.toLowerCase());
                if (outcomeNames.includes('up') && outcomeNames.includes('down')) {
                    // 构建 tokens 数组
                    const tokens = [];
                    for (let i = 0; i < outcomes.length; i++) {
                        tokens.push({
                            token_id: clobTokenIds?.[i] || '',
                            outcome: outcomes[i],
                            price: outcomePrices?.[i] ? parseFloat(outcomePrices[i]) : 0.5,
                        });
                    }
                    
                    const result = {
                        condition_id: market.conditionId,
                        question: market.question || event.title,
                        slug: slug,
                        tokens,
                        end_date_iso: market.endDateIso || market.endDate || event.endDate,
                        active: market.active !== false,
                        closed: market.closed === true,
                    };
                    
                    Logger.info(`   📍 ${slug}: closed=${result.closed}, tokens=${tokens.length}`);
                    return result;
                }
            }
        }
        
        Logger.warning(`   ❌ ${slug} - 无 Up/Down outcomes`);
        return null;
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
        Logger.info('🔄 刷新市场列表...');
        
        // 根据当前时间生成 slug
        const slugs = generateMarketSlugs();
        Logger.info(`📋 生成的 slug: ${slugs.join(', ')}`);
        
        // 并行获取所有市场
        const marketPromises = slugs.map(slug => fetchEventBySlug(slug));
        const results = await Promise.all(marketPromises);
        
        // 过滤有效且未关闭的市场
        Logger.info(`📋 获取到 ${results.filter(r => r !== null).length} 个市场结果`);
        
        cachedMarkets = results.filter((m): m is PolymarketMarket => {
            if (m === null) return false;
            if (m.closed) {
                Logger.warning(`   跳过已关闭: ${m.question}`);
                return false;
            }
            if (m.tokens.length !== 2) {
                Logger.warning(`   跳过 tokens 数量异常: ${m.question}, tokens=${m.tokens.length}`);
                return false;
            }
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
                Logger.info(`   ✅ ${market.question}`);
            }
        }
        
        Logger.success(`📊 找到 ${cachedMarkets.length} 个 BTC/ETH Up/Down 市场`);
        
        // 订阅这些 token 的 WebSocket
        if (tokenIds.length > 0) {
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
 * 扫描套利机会（从 WebSocket 缓存读取，无 API 请求）
 */
export const scanArbitrageOpportunities = async (silent: boolean = false): Promise<ArbitrageOpportunity[]> => {
    // 检查是否需要刷新市场列表
    const now = Date.now();
    if (now - lastMarketFetch > MARKET_CACHE_DURATION) {
        await fetchCryptoMarkets();
    }
    
    const opportunities: ArbitrageOpportunity[] = [];
    
    // 遍历所有市场，从 WebSocket 缓存获取订单簿
    for (const [conditionId, { market, upToken, downToken }] of marketTokenMap) {
        const upBook = orderBookManager.getOrderBook(upToken.token_id);
        const downBook = orderBookManager.getOrderBook(downToken.token_id);
        
        // 跳过没有订单簿数据的市场
        if (!upBook || !downBook) continue;
        
        // 计算套利空间
        const combinedCost = upBook.bestAsk + downBook.bestAsk;
        const profitPercent = (1 - combinedCost) * 100;
        
        // 单边价格阈值判断
        const upIsCheap = upBook.bestAsk <= CONFIG.UP_PRICE_THRESHOLD;
        const downIsCheap = downBook.bestAsk <= CONFIG.DOWN_PRICE_THRESHOLD;
        
        // 有套利空间 或 单边价格足够便宜
        const hasArbitrage = profitPercent >= CONFIG.MIN_ARBITRAGE_PERCENT;
        const hasCheapSide = upIsCheap || downIsCheap;
        
        if (hasArbitrage || hasCheapSide) {
            const maxShares = Math.min(upBook.bestAskSize, downBook.bestAskSize);
            
            // 计算优先级分数
            let priority = profitPercent;
            if (upIsCheap) priority += 5;
            if (downIsCheap) priority += 5;
            if (hasArbitrage && hasCheapSide) priority += 10;
            
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

export default {
    fetchCryptoMarkets,
    initWebSocket,
    scanArbitrageOpportunities,
    printOpportunities,
    getWebSocketStatus,
};
