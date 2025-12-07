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
        
        const response = await axios.get(`${CONFIG.GAMMA_API}/markets`, {
            params: {
                active: true,
                closed: false,
                limit: 500,
            },
            timeout: 10000,
        });

        const markets: PolymarketMarket[] = response.data;
        
        // 调试：打印前 3 个市场的结构
        Logger.info(`📋 API 返回 ${markets.length} 个市场`);
        if (markets.length > 0) {
            Logger.info('🔍 示例市场结构:');
            for (const m of markets.slice(0, 3)) {
                Logger.info(`   slug: ${m.slug || 'undefined'}`);
                Logger.info(`   question: ${(m.question || 'undefined').slice(0, 60)}`);
                Logger.info(`   tokens: ${m.tokens?.length || 0} 个`);
                Logger.info('   ---');
            }
        }
        
        // 查找包含 btc/eth/bitcoin/ethereum 的市场
        const cryptoRelated = markets.filter(m => {
            const s = JSON.stringify(m).toLowerCase();
            return s.includes('btc') || s.includes('eth') || s.includes('bitcoin') || s.includes('ethereum');
        });
        Logger.info(`🔍 包含 BTC/ETH 关键词的市场: ${cryptoRelated.length} 个`);
        if (cryptoRelated.length > 0) {
            for (const m of cryptoRelated.slice(0, 5)) {
                Logger.info(`   - ${m.slug || m.question?.slice(0, 50) || 'unknown'}`);
            }
        }
        
        // 过滤 BTC/ETH Up/Down 15分钟和1小时市场
        cachedMarkets = markets.filter(market => {
            const slug = (market.slug || '').toLowerCase();
            
            // 15 分钟市场：btc-updown-15m-xxx 或 eth-updown-15m-xxx
            const is15Min = (slug.includes('btc-updown-15m') || slug.includes('eth-updown-15m'));
            
            // 1 小时市场：bitcoin-up-or-down-xxx 或 ethereum-up-or-down-xxx（不含 15m）
            const is1Hour = (slug.includes('bitcoin-up-or-down') || slug.includes('ethereum-up-or-down'));
            
            if (!is15Min && !is1Hour) return false;
            
            // 必须有 Up 和 Down 两个选项
            if (!market.tokens || market.tokens.length !== 2) return false;
            
            const outcomes = market.tokens.map(t => t.outcome.toLowerCase());
            return outcomes.includes('up') && outcomes.includes('down');
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
        
        Logger.success(`📊 找到 ${cachedMarkets.length} 个 BTC/ETH 15分钟&1小时 Up/Down 市场`);
        
        // 订阅这些 token 的 WebSocket
        orderBookManager.subscribe(tokenIds);
        
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
