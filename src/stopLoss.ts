/**
 * 止损模块 - 在结束前检测市场风险信号并提前平仓
 * 
 * 核心逻辑：
 * 追踪整个事件周期的组合价格曲线，正常情况下应该：
 * - 由低变高然后稳定
 * - 或者一直很高且稳定
 * 
 * 异常情况（趋势相反信号）：
 * - 逐渐下降
 * - 震荡下降
 * - 低位震荡
 * - 开始上升后期下降
 * - 高处平稳后突然下降
 * 
 * 止损条件：
 * 从倒数第三分钟开始，统计低于风险阈值的次数占总检查次数的比例
 * 如果比例超过 70% 且绝对次数超过 30 次，触发止损
 */

import CONFIG from './config';
import Logger from './logger';
import { orderBookManager, OrderBookData } from './orderbook-ws';
import { getAllPositions, Position, getTimeGroup, TimeGroup, settleStopLoss } from './positions';
import { notifyStopLoss } from './telegram';

// 止损状态追踪
interface StopLossState {
    timeGroup: TimeGroup;
    triggeredAt: number;
    reason: string;
    upBid: number;
    downBid: number;
    combinedBid: number;
}

// 价格追踪器（追踪整个事件周期）
interface PriceTracker {
    timeGroup: TimeGroup;
    startTime: number;           // 开始追踪时间
    priceHistory: Array<{        // 价格历史
        time: number;
        combinedBid: number;
        upBid: number;
        downBid: number;
    }>;
    // 整个事件周期的统计
    totalCheckCount: number;     // 整个周期的总检查次数
    totalBelowThreshold: number; // 整个周期低于阈值的次数
    // 最后3分钟统计
    riskCheckCount: number;      // 风险窗口内的总检查次数
    riskTriggerCount: number;    // 低于阈值的次数
    riskWindowStartTime: number; // 风险窗口开始时间
}

// 事件统计摘要（事件结束时输出）
export interface EventSummary {
    timeGroup: TimeGroup;
    totalCheckCount: number;       // 整个事件周期的检查次数
    totalBelowThreshold: number;   // 整个事件周期低于阈值的次数
    riskCheckCount: number;        // 最后3分钟的检查次数
    riskTriggerCount: number;      // 最后3分钟低于阈值的次数
    riskRatio: number;             // 最后3分钟的风险比例
    wasStopLossTriggered: boolean; // 是否触发了止损
    avgCombinedBid: number;        // 平均组合价格
    minCombinedBid: number;        // 最低组合价格
    maxCombinedBid: number;        // 最高组合价格
}

// 已触发止损的记录（防止重复触发）
const triggeredStopLoss = new Map<TimeGroup, StopLossState>();

// 价格追踪记录
const priceTrackers = new Map<TimeGroup, PriceTracker>();

// 上次检查时间
let lastCheckTime = 0;

// 单个市场的 Token 信息
interface MarketTokens {
    upTokenId: string;
    downTokenId: string;
    endDate: string;
}

// Token 映射缓存（从 scanner 获取）- 每个 timeGroup 存储 BTC 和 ETH 两个市场
let tokenMapCache: Map<TimeGroup, {
    btc?: MarketTokens;
    eth?: MarketTokens;
}> = new Map();

/**
 * 更新 Token 映射（由 scanner 调用）
 * @param asset 'btc' 或 'eth'
 */
export const updateTokenMap = (
    timeGroup: TimeGroup,
    upTokenId: string,
    downTokenId: string,
    endDate: string,
    asset: 'btc' | 'eth'
): void => {
    let entry = tokenMapCache.get(timeGroup);
    if (!entry) {
        entry = {};
        tokenMapCache.set(timeGroup, entry);
    }
    entry[asset] = { upTokenId, downTokenId, endDate };
};

/**
 * 检查是否需要止损
 * 返回需要止损的时间组列表
 * 
 * 新逻辑：
 * 1. 持续追踪整个事件周期的价格
 * 2. 从倒数第三分钟（180秒）开始统计
 * 3. 统计低于阈值的次数占总检查次数的比例
 * 4. 如果比例 > 70% 且 绝对次数 > 30 次，触发止损
 */
export const checkStopLossSignals = (): StopLossState[] => {
    if (!CONFIG.STOP_LOSS_ENABLED) {
        return [];
    }
    
    const now = Date.now();
    
    // 控制检查频率
    if (now - lastCheckTime < CONFIG.STOP_LOSS_CHECK_INTERVAL_MS) {
        return [];
    }
    lastCheckTime = now;
    
    const signals: StopLossState[] = [];
    
    // 止损参数
    const RISK_WINDOW_SEC = CONFIG.STOP_LOSS_WINDOW_SEC;           // 风险监控窗口（默认180秒=3分钟）
    const RISK_RATIO_THRESHOLD = CONFIG.STOP_LOSS_RISK_RATIO;     // 风险比例阈值（默认0.7=70%）
    const MIN_TRIGGER_COUNT = CONFIG.STOP_LOSS_MIN_TRIGGER_COUNT; // 最小触发次数（默认30次）
    
    // 检查每个时间组
    for (const [timeGroup, markets] of tokenMapCache) {
        // 跳过已触发的
        if (triggeredStopLoss.has(timeGroup)) {
            continue;
        }
        
        // 需要两个市场都有数据才能计算跨池子组合
        if (!markets.btc || !markets.eth) {
            continue;
        }
        
        const endTime = new Date(markets.btc.endDate).getTime();
        const secondsToEnd = (endTime - now) / 1000;
        
        // 获取当前价格（bid 价格，即可卖出价格）
        // 两种跨池子组合：
        // 1. BTC Up + ETH Down
        // 2. ETH Up + BTC Down
        const btcUpBook = orderBookManager.getOrderBook(markets.btc.upTokenId);
        const btcDownBook = orderBookManager.getOrderBook(markets.btc.downTokenId);
        const ethUpBook = orderBookManager.getOrderBook(markets.eth.upTokenId);
        const ethDownBook = orderBookManager.getOrderBook(markets.eth.downTokenId);
        
        if (!btcUpBook || !btcDownBook || !ethUpBook || !ethDownBook) {
            continue;  // 没有价格数据
        }
        
        // 计算两种跨池子组合的价格
        const combo1Bid = btcUpBook.bestBid + ethDownBook.bestBid;  // BTC↑ETH↓
        const combo2Bid = ethUpBook.bestBid + btcDownBook.bestBid;  // ETH↑BTC↓
        
        // 使用两者中较低的价格作为风险指标（更保守）
        const combinedBid = Math.min(combo1Bid, combo2Bid);
        const upBid = combo1Bid <= combo2Bid ? btcUpBook.bestBid : ethUpBook.bestBid;
        const downBid = combo1Bid <= combo2Bid ? ethDownBook.bestBid : btcDownBook.bestBid;
        
        // 获取或创建价格追踪器
        let tracker = priceTrackers.get(timeGroup);
        if (!tracker) {
            tracker = {
                timeGroup,
                startTime: now,
                priceHistory: [],
                totalCheckCount: 0,
                totalBelowThreshold: 0,
                riskCheckCount: 0,
                riskTriggerCount: 0,
                riskWindowStartTime: 0,
            };
            priceTrackers.set(timeGroup, tracker);
        }
        
        // 确保 tracker 非空（TypeScript 类型保护）
        const currentTracker = tracker;
        
        // 记录价格历史
        currentTracker.priceHistory.push({
            time: now,
            combinedBid,
            upBid,
            downBid,
        });
        
        // 更新整个事件周期的统计
        currentTracker.totalCheckCount++;
        if (combinedBid < CONFIG.STOP_LOSS_COST_THRESHOLD) {
            currentTracker.totalBelowThreshold++;
        }
        
        // 限制历史记录大小（保留最近1000条）
        if (currentTracker.priceHistory.length > 1000) {
            currentTracker.priceHistory = currentTracker.priceHistory.slice(-500);
        }
        
        // 如果事件已结束，清除追踪器
        if (secondsToEnd <= 0) {
            priceTrackers.delete(timeGroup);
            continue;
        }
        
        // 检查是否进入风险监控窗口（倒数第 RISK_WINDOW_SEC 秒）
        if (secondsToEnd > RISK_WINDOW_SEC) {
            // 还没进入风险窗口，只记录价格，不做止损判断
            continue;
        }
        
        // 进入风险窗口，开始统计
        if (currentTracker.riskWindowStartTime === 0) {
            currentTracker.riskWindowStartTime = now;
            currentTracker.riskCheckCount = 0;
            currentTracker.riskTriggerCount = 0;
            Logger.info(`⏱️ [${timeGroup}] 进入止损监控窗口，距离结束 ${secondsToEnd.toFixed(0)} 秒`);
        }
        
        // 更新风险窗口统计
        currentTracker.riskCheckCount++;
        
        // 只检查组合成本阈值（移除单边阈值判断）
        const isRiskSignal = combinedBid < CONFIG.STOP_LOSS_COST_THRESHOLD;
        
        if (isRiskSignal) {
            currentTracker.riskTriggerCount++;
        }
        
        // 计算风险比例
        const riskRatio = currentTracker.riskCheckCount > 0 
            ? currentTracker.riskTriggerCount / currentTracker.riskCheckCount 
            : 0;
        
        // 每10次检查打印一次状态
        if (currentTracker.riskCheckCount % 10 === 0) {
            Logger.info(`📊 [${timeGroup}] 风险监控: ${currentTracker.riskTriggerCount}/${currentTracker.riskCheckCount} (${(riskRatio * 100).toFixed(1)}%) | 阈值: ${(RISK_RATIO_THRESHOLD * 100).toFixed(0)}% & ${MIN_TRIGGER_COUNT}次`);
        }
        
        // 检查是否触发止损条件
        // 条件1：风险比例超过阈值
        // 条件2：绝对次数超过最小值
        if (riskRatio >= RISK_RATIO_THRESHOLD && currentTracker.riskTriggerCount >= MIN_TRIGGER_COUNT) {
            // 分析价格趋势
            const trendAnalysis = analyzePriceTrend(currentTracker.priceHistory);
            
            const state: StopLossState = {
                timeGroup,
                triggeredAt: now,
                reason: `风险比例 ${(riskRatio * 100).toFixed(1)}% ≥ ${(RISK_RATIO_THRESHOLD * 100).toFixed(0)}%，触发 ${currentTracker.riskTriggerCount} 次 ≥ ${MIN_TRIGGER_COUNT} 次。趋势: ${trendAnalysis}`,
                upBid,
                downBid,
                combinedBid,
            };
            
            signals.push(state);
            triggeredStopLoss.set(timeGroup, state);
            
            Logger.warning(`🚨 止损触发 [${timeGroup}]: ${state.reason}`);
            Logger.warning(`   当前价格: Up=$${upBid.toFixed(3)} Down=$${downBid.toFixed(3)} 合计=$${combinedBid.toFixed(3)}`);
            Logger.warning(`   距离结束: ${secondsToEnd.toFixed(0)} 秒`);
        }
    }
    
    return signals;
};

/**
 * 分析价格趋势
 */
const analyzePriceTrend = (history: PriceTracker['priceHistory']): string => {
    if (history.length < 10) return '数据不足';
    
    // 取最近的价格数据，分成前半段和后半段
    const recent = history.slice(-Math.min(100, history.length));
    const mid = Math.floor(recent.length / 2);
    const firstHalf = recent.slice(0, mid);
    const secondHalf = recent.slice(mid);
    
    // 计算平均价格
    const firstAvg = firstHalf.reduce((sum, p) => sum + p.combinedBid, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, p) => sum + p.combinedBid, 0) / secondHalf.length;
    
    // 计算最高点和最低点
    const allPrices = recent.map(p => p.combinedBid);
    const maxPrice = Math.max(...allPrices);
    const minPrice = Math.min(...allPrices);
    const currentPrice = allPrices[allPrices.length - 1];
    
    // 判断趋势
    const priceDiff = secondAvg - firstAvg;
    const priceRange = maxPrice - minPrice;
    
    if (priceDiff < -0.05) {
        return `持续下跌 (前半均值$${firstAvg.toFixed(2)}→后半$${secondAvg.toFixed(2)})`;
    } else if (currentPrice < firstAvg - 0.1 && maxPrice > firstAvg + 0.1) {
        return `先涨后跌 (最高$${maxPrice.toFixed(2)}→当前$${currentPrice.toFixed(2)})`;
    } else if (priceRange < 0.1 && currentPrice < 0.6) {
        return `低位震荡 (范围$${minPrice.toFixed(2)}-$${maxPrice.toFixed(2)})`;
    } else if (priceDiff > 0.05) {
        return `上升趋势但仍有风险`;
    } else {
        return `震荡 (当前$${currentPrice.toFixed(2)})`;
    }
};

/**
 * 获取需要止损的仓位
 */
export const getPositionsToStopLoss = (timeGroup: TimeGroup): Position[] => {
    const allPositions = getAllPositions();
    return allPositions.filter(pos => getTimeGroup(pos.slug) === timeGroup);
};

/**
 * 执行止损卖出
 */
export const executeStopLoss = async (
    sellFunction: (tokenId: string, shares: number, price: number, label: string) => Promise<{ success: boolean; received: number }>,
    signal: StopLossState
): Promise<{
    success: boolean;
    upSold: number;
    downSold: number;
    totalReceived: number;
    totalCost: number;
    savedLoss: number;
}> => {
    const positions = getPositionsToStopLoss(signal.timeGroup);
    
    if (positions.length === 0) {
        Logger.info(`[止损] ${signal.timeGroup}: 无持仓需要平仓`);
        return { success: true, upSold: 0, downSold: 0, totalReceived: 0, totalCost: 0, savedLoss: 0 };
    }
    
    let totalUpShares = 0;
    let totalDownShares = 0;
    let totalCost = 0;
    
    for (const pos of positions) {
        totalUpShares += pos.upShares;
        totalDownShares += pos.downShares;
        totalCost += pos.upCost + pos.downCost;
    }
    
    Logger.warning(`🚨 [止损] ${signal.timeGroup}: 准备平仓 Up=${totalUpShares.toFixed(0)} Down=${totalDownShares.toFixed(0)} 成本=$${totalCost.toFixed(2)}`);
    
    // 模拟模式
    if (CONFIG.SIMULATION_MODE) {
        const upReceived = totalUpShares * signal.upBid;
        const downReceived = totalDownShares * signal.downBid;
        const totalReceived = upReceived + downReceived;
        const savedLoss = totalReceived;  // 如果不止损，双输时收回0
        
        Logger.success(`🔵 [模拟止损] ${signal.timeGroup}:`);
        Logger.success(`   卖出 Up: ${totalUpShares.toFixed(0)} @ $${signal.upBid.toFixed(3)} = $${upReceived.toFixed(2)}`);
        Logger.success(`   卖出 Down: ${totalDownShares.toFixed(0)} @ $${signal.downBid.toFixed(3)} = $${downReceived.toFixed(2)}`);
        Logger.success(`   回收: $${totalReceived.toFixed(2)} | 成本: $${totalCost.toFixed(2)} | 亏损: $${(totalCost - totalReceived).toFixed(2)}`);
        Logger.success(`   💡 如果不止损双输时亏损: $${totalCost.toFixed(2)} → 止损减少亏损: $${savedLoss.toFixed(2)}`);
        
        // 发送 Telegram 通知
        await notifyStopLoss({
            timeGroup: signal.timeGroup,
            reason: signal.reason,
            upShares: totalUpShares,
            downShares: totalDownShares,
            upBid: signal.upBid,
            downBid: signal.downBid,
            totalReceived,
            totalCost,
            savedLoss,
            isSimulation: true,
        });
        
        // 记录止损盈亏并清除仓位
        settleStopLoss(signal.timeGroup, totalReceived, totalCost);
        
        return {
            success: true,
            upSold: totalUpShares,
            downSold: totalDownShares,
            totalReceived,
            totalCost,
            savedLoss,
        };
    }
    
    // 实盘模式：执行卖出
    const markets = tokenMapCache.get(signal.timeGroup);
    if (!markets || !markets.btc || !markets.eth) {
        Logger.error(`[止损] 找不到 ${signal.timeGroup} 的 token 信息`);
        return { success: false, upSold: 0, downSold: 0, totalReceived: 0, totalCost: 0, savedLoss: 0 };
    }
    
    let upReceived = 0;
    let downReceived = 0;
    
    // 并行卖出（跨池子：BTC Up + ETH Down）
    const promises: Promise<void>[] = [];
    
    if (totalUpShares > 0) {
        promises.push(
            sellFunction(markets.btc.upTokenId, totalUpShares, signal.upBid, `${signal.timeGroup} BTC Up`)
                .then(r => { if (r.success) upReceived = r.received; })
        );
    }
    
    if (totalDownShares > 0) {
        promises.push(
            sellFunction(markets.eth.downTokenId, totalDownShares, signal.downBid, `${signal.timeGroup} ETH Down`)
                .then(r => { if (r.success) downReceived = r.received; })
        );
    }
    
    await Promise.all(promises);
    
    const totalReceived = upReceived + downReceived;
    const savedLoss = totalReceived;  // 如果双输，这些钱就保住了
    
    Logger.arbitrage(`🚨 [止损完成] ${signal.timeGroup}: 回收 $${totalReceived.toFixed(2)} | 成本 $${totalCost.toFixed(2)} | 减少亏损 $${savedLoss.toFixed(2)}`);
    
    // 发送 Telegram 通知
    await notifyStopLoss({
        timeGroup: signal.timeGroup,
        reason: signal.reason,
        upShares: totalUpShares,
        downShares: totalDownShares,
        upBid: signal.upBid,
        downBid: signal.downBid,
        totalReceived,
        totalCost,
        savedLoss,
        isSimulation: false,
    });
    
    // 记录止损盈亏并清除仓位
    settleStopLoss(signal.timeGroup, totalReceived, totalCost);
    
    return {
        success: true,
        upSold: totalUpShares,
        downSold: totalDownShares,
        totalReceived,
        totalCost,
        savedLoss,
    };
};

/**
 * 清除已触发的止损记录（事件切换时调用）
 */
export const clearTriggeredStopLoss = (timeGroup?: TimeGroup): void => {
    if (timeGroup) {
        triggeredStopLoss.delete(timeGroup);
        priceTrackers.delete(timeGroup);
        tokenMapCache.delete(timeGroup);
    } else {
        triggeredStopLoss.clear();
        priceTrackers.clear();
        tokenMapCache.clear();
    }
};

/**
 * 获取止损状态
 */
export const getStopLossStatus = (): {
    enabled: boolean;
    windowSec: number;
    costThreshold: number;
    riskRatio: number;
    minTriggerCount: number;
    triggeredCount: number;
    trackingCount: number;
} => {
    return {
        enabled: CONFIG.STOP_LOSS_ENABLED,
        windowSec: CONFIG.STOP_LOSS_WINDOW_SEC,
        costThreshold: CONFIG.STOP_LOSS_COST_THRESHOLD,
        riskRatio: CONFIG.STOP_LOSS_RISK_RATIO,
        minTriggerCount: CONFIG.STOP_LOSS_MIN_TRIGGER_COUNT,
        triggeredCount: triggeredStopLoss.size,
        trackingCount: priceTrackers.size,
    };
};

/**
 * 获取事件统计摘要（事件结束时调用）
 */
export const getEventSummary = (timeGroup: TimeGroup): EventSummary | null => {
    const tracker = priceTrackers.get(timeGroup);
    if (!tracker) return null;
    
    const prices = tracker.priceHistory.map(p => p.combinedBid);
    const avgPrice = prices.length > 0 
        ? prices.reduce((a, b) => a + b, 0) / prices.length 
        : 0;
    const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
    const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
    
    const riskRatio = tracker.riskCheckCount > 0 
        ? tracker.riskTriggerCount / tracker.riskCheckCount 
        : 0;
    
    return {
        timeGroup,
        totalCheckCount: tracker.totalCheckCount,
        totalBelowThreshold: tracker.totalBelowThreshold,
        riskCheckCount: tracker.riskCheckCount,
        riskTriggerCount: tracker.riskTriggerCount,
        riskRatio,
        wasStopLossTriggered: triggeredStopLoss.has(timeGroup),
        avgCombinedBid: avgPrice,
        minCombinedBid: minPrice,
        maxCombinedBid: maxPrice,
    };
};

/**
 * 打印事件统计摘要
 */
export const printEventSummary = (timeGroup: TimeGroup): void => {
    const summary = getEventSummary(timeGroup);
    if (!summary) {
        Logger.info(`📊 [${timeGroup}] 事件统计: 无数据`);
        return;
    }
    
    const totalRatio = summary.totalCheckCount > 0 
        ? (summary.totalBelowThreshold / summary.totalCheckCount * 100).toFixed(1) 
        : '0.0';
    
    Logger.info(`\n${'═'.repeat(60)}`);
    Logger.info(`📊 [${timeGroup}] 事件统计摘要`);
    Logger.info(`${'─'.repeat(60)}`);
    Logger.info(`   📈 整个事件周期:`);
    Logger.info(`      检查次数: ${summary.totalCheckCount} 次`);
    Logger.info(`      低于 $${CONFIG.STOP_LOSS_COST_THRESHOLD} 阈值: ${summary.totalBelowThreshold} 次 (${totalRatio}%)`);
    Logger.info(`   ⏱️ 最后 ${CONFIG.STOP_LOSS_WINDOW_SEC} 秒:`);
    Logger.info(`      检查次数: ${summary.riskCheckCount} 次`);
    Logger.info(`      低于阈值: ${summary.riskTriggerCount} 次 (${(summary.riskRatio * 100).toFixed(1)}%)`);
    Logger.info(`   💰 价格统计:`);
    Logger.info(`      平均: $${summary.avgCombinedBid.toFixed(3)} | 最低: $${summary.minCombinedBid.toFixed(3)} | 最高: $${summary.maxCombinedBid.toFixed(3)}`);
    Logger.info(`   🚨 止损状态: ${summary.wasStopLossTriggered ? '✅ 已触发' : '❌ 未触发'}`);
    Logger.info(`${'═'.repeat(60)}\n`);
};

/**
 * 获取当前追踪状态（用于调试）
 */
export const getTrackingStatus = (): Array<{
    timeGroup: TimeGroup;
    priceCount: number;
    riskCheckCount: number;
    riskTriggerCount: number;
    riskRatio: number;
    currentPrice: number;
    inRiskWindow: boolean;
}> => {
    const result: Array<{
        timeGroup: TimeGroup;
        priceCount: number;
        riskCheckCount: number;
        riskTriggerCount: number;
        riskRatio: number;
        currentPrice: number;
        inRiskWindow: boolean;
    }> = [];
    
    for (const [timeGroup, tracker] of priceTrackers) {
        const lastPrice = tracker.priceHistory.length > 0 
            ? tracker.priceHistory[tracker.priceHistory.length - 1].combinedBid 
            : 0;
        
        result.push({
            timeGroup,
            priceCount: tracker.priceHistory.length,
            riskCheckCount: tracker.riskCheckCount,
            riskTriggerCount: tracker.riskTriggerCount,
            riskRatio: tracker.riskCheckCount > 0 
                ? tracker.riskTriggerCount / tracker.riskCheckCount 
                : 0,
            currentPrice: lastPrice,
            inRiskWindow: tracker.riskWindowStartTime > 0,
        });
    }
    
    return result;
};

export default {
    updateTokenMap,
    checkStopLossSignals,
    getPositionsToStopLoss,
    executeStopLoss,
    clearTriggeredStopLoss,
    getStopLossStatus,
};
