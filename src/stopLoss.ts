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
import { isHedgeCompleted, isHedging } from './hedging';
import { isBtcVolatilityTooLow, getBtcChangeInfo } from './binance';

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
    eventEndDate: string;        // 当前追踪的事件结束时间（用于检测事件切换）
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
    lastLogTime: number;         // 上次输出日志的时间
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

// 上次日志时间（控制日志频率）
let lastLogTime = 0;

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
 * 记录套利机会（由 scanner 调用）
 * 
 * 简单逻辑：
 * - 每次扫描到套利机会，记录组合价格
 * - 统计低于风险阈值的次数占总次数的比例
 * 
 * @param timeGroup 时间组
 * @param combinedCost 组合价格（Up Ask + Down Ask）
 * @param endDate 事件结束时间
 */
export const recordArbitrageOpportunity = (
    timeGroup: TimeGroup,
    combinedCost: number,
    endDate: string
): void => {
    if (!CONFIG.STOP_LOSS_ENABLED) return;
    
    const now = Date.now();
    const endTime = new Date(endDate).getTime();
    const secondsToEnd = (endTime - now) / 1000;
    
    // 获取或创建 tracker
    let tracker = priceTrackers.get(timeGroup);
    
    // 检测事件切换：如果 endDate 变了，说明是新事件，需要重置
    if (tracker && tracker.eventEndDate !== endDate) {
        Logger.info(`🔄 [${timeGroup}] 检测到事件切换，重置统计`);
        priceTrackers.delete(timeGroup);
        tracker = undefined;
    }
    
    if (!tracker) {
        tracker = {
            timeGroup,
            startTime: now,
            eventEndDate: endDate,
            priceHistory: [],
            totalCheckCount: 0,
            totalBelowThreshold: 0,
            riskCheckCount: 0,
            riskTriggerCount: 0,
            riskWindowStartTime: 0,
            lastLogTime: 0,
        };
        priceTrackers.set(timeGroup, tracker);
    }
    
    // 记录价格历史
    tracker.priceHistory.push({
        time: now,
        combinedBid: combinedCost,  // 存储组合价格
        upBid: 0,
        downBid: 0,
    });
    
    // 限制历史大小
    if (tracker.priceHistory.length > 1000) {
        tracker.priceHistory = tracker.priceHistory.slice(-500);
    }
    
    // 更新整个事件周期统计
    tracker.totalCheckCount++;
    if (combinedCost < CONFIG.STOP_LOSS_COST_THRESHOLD) {
        tracker.totalBelowThreshold++;
    }
    
    // 检查是否进入风险监控窗口
    if (secondsToEnd <= 0 || secondsToEnd > CONFIG.STOP_LOSS_WINDOW_SEC) {
        return;  // 不在风险窗口内
    }
    
    // 进入风险窗口
    if (tracker.riskWindowStartTime === 0) {
        tracker.riskWindowStartTime = now;
        tracker.riskCheckCount = 0;
        tracker.riskTriggerCount = 0;
        const endTimeStr = new Date(endTime).toLocaleTimeString('zh-CN');
        Logger.info(`⏱️ [${timeGroup}] 进入止损监控窗口，距离结束 ${secondsToEnd.toFixed(0)} 秒 (结束时间: ${endTimeStr})`);
    }
    
    // 更新风险窗口统计
    tracker.riskCheckCount++;
    if (combinedCost < CONFIG.STOP_LOSS_COST_THRESHOLD) {
        tracker.riskTriggerCount++;
    }
    
    // 计算风险比例
    const riskRatio = tracker.riskTriggerCount / tracker.riskCheckCount;
    
    // 对冲已完成或正在对冲时，静默等待，不再打印风险日志
    if (isHedgeCompleted(timeGroup) || isHedging(timeGroup)) {
        return;  // 对冲中或已完成，不需要继续打印
    }
    
    // 已触发止损后不再打印风险监控日志
    if (triggeredStopLoss.has(timeGroup)) {
        return;
    }
    
    // 每10秒打印一次日志（避免日志刷屏）
    if (now - tracker.lastLogTime >= 10000) {
        tracker.lastLogTime = now;
        const windowElapsed = Math.floor((now - tracker.riskWindowStartTime) / 1000);
        Logger.info(`📊 [${timeGroup}] 风险监控: ${tracker.riskTriggerCount}/${tracker.riskCheckCount} (${(riskRatio * 100).toFixed(1)}%) | 组合=$${combinedCost.toFixed(2)} | 窗口已过${windowElapsed}秒 | 阈值: <$${CONFIG.STOP_LOSS_COST_THRESHOLD} ≥${(CONFIG.STOP_LOSS_RISK_RATIO * 100).toFixed(0)}%`);
    }
    
    // 如果当前价格低于阈值，输出风险信号
    if (combinedCost < CONFIG.STOP_LOSS_COST_THRESHOLD) {
        Logger.warning(`🚨 [${timeGroup}] 风险信号: 组合=$${combinedCost.toFixed(2)} < $${CONFIG.STOP_LOSS_COST_THRESHOLD} | 累计${tracker.riskTriggerCount}/${tracker.riskCheckCount}`);
    }
    
    // 立即检查是否满足止损条件（不等到 checkStopLossSignals）
    // 这样 shouldPauseTrading 可以立即生效，阻止后续交易
    if (!triggeredStopLoss.has(timeGroup) &&
        riskRatio >= CONFIG.STOP_LOSS_RISK_RATIO && 
        tracker.riskTriggerCount >= CONFIG.STOP_LOSS_MIN_TRIGGER_COUNT) {
        
        // 标记为已触发（让 shouldPauseTrading 立即生效）
        const state: StopLossState = {
            timeGroup,
            triggeredAt: now,
            reason: `风险比例 ${(riskRatio * 100).toFixed(1)}% ≥ ${(CONFIG.STOP_LOSS_RISK_RATIO * 100).toFixed(0)}%，触发 ${tracker.riskTriggerCount} 次 ≥ ${CONFIG.STOP_LOSS_MIN_TRIGGER_COUNT} 次`,
            upBid: 0,
            downBid: 0,
            combinedBid: combinedCost,
        };
        triggeredStopLoss.set(timeGroup, state);
        
        Logger.warning(`🚨 止损条件满足 [${timeGroup}]: ${state.reason}`);
        Logger.warning(`   当前组合价格: $${combinedCost.toFixed(3)}`);
    }
};

// 币安检查日志控制（每 5 秒打印一次）
const binanceLogTime = new Map<TimeGroup, number>();
const BINANCE_LOG_INTERVAL_MS = 5000;

/**
 * 检查币安波动率风控（同步，数据来自 WebSocket 实时推送）
 * 如果 BTC 涨跌幅过小，触发对冲
 * 在检查窗口内持续检查，一旦触发就立即对冲
 */
export const checkBinanceVolatility = (timeGroup: TimeGroup, endDate: string): void => {
    if (!CONFIG.BINANCE_VOLATILITY_CHECK_ENABLED) return;
    if (triggeredStopLoss.has(timeGroup)) return;
    if (isHedgeCompleted(timeGroup) || isHedging(timeGroup)) return;
    
    const now = Date.now();
    const endTime = new Date(endDate).getTime();
    const secondsToEnd = (endTime - now) / 1000;
    
    // 只在指定时间窗口内检查
    if (secondsToEnd <= 0 || secondsToEnd > CONFIG.BINANCE_CHECK_WINDOW_SEC) {
        return;
    }
    
    // 根据 timeGroup 确定 K 线间隔
    const interval = timeGroup === '15min' ? '15m' : '1h';
    
    // 检查波动率（数据来自 WebSocket 实时缓存）
    const isTooLow = isBtcVolatilityTooLow(interval);
    const btcInfo = getBtcChangeInfo(interval);
    
    // 定期打印检查状态日志（每 5 秒一次）
    const lastLog = binanceLogTime.get(timeGroup) || 0;
    if (now - lastLog >= BINANCE_LOG_INTERVAL_MS) {
        binanceLogTime.set(timeGroup, now);
        const threshold = CONFIG.BINANCE_MIN_VOLATILITY_PERCENT;
        Logger.info(`📊 [币安风控] ${timeGroup} 检查中 | BTC ${interval}: ${btcInfo} | 阈值: ±${threshold}% | 距离结束: ${secondsToEnd.toFixed(0)}秒`);
    }
    
    if (isTooLow) {
        // 触发止损
        const state: StopLossState = {
            timeGroup,
            triggeredAt: now,
            reason: `BTC ${interval} 波动率过低 (${btcInfo})，可能导致双输`,
            upBid: 0,
            downBid: 0,
            combinedBid: 0,
        };
        triggeredStopLoss.set(timeGroup, state);
        
        Logger.warning(`🚨 [币安风控] 止损条件满足 [${timeGroup}]: ${state.reason}`);
        Logger.warning(`   距离结束: ${secondsToEnd.toFixed(0)} 秒`);
        Logger.warning(`   立即启动对冲保本模式！`);
    }
};

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

// 记录已执行止损的 timeGroup（防止重复执行）
const executedStopLoss = new Set<TimeGroup>();

/**
 * 检查是否需要执行止损
 * 
 * 逻辑：
 * - 止损条件由 recordArbitrageOpportunity 检测并标记
 * - 这里返回已标记但还没执行的止损，供主循环执行
 */
export const checkStopLossSignals = (): StopLossState[] => {
    if (!CONFIG.STOP_LOSS_ENABLED) {
        return [];
    }
    
    const signals: StopLossState[] = [];
    
    // 找出已触发但还没执行的止损
    for (const [timeGroup, state] of triggeredStopLoss) {
        if (executedStopLoss.has(timeGroup)) {
            continue;  // 已执行过
        }
        
        // 获取最新的 Bid 价格用于止损执行
        const markets = tokenMapCache.get(timeGroup);
        if (markets?.btc && markets?.eth) {
            const btcUpBook = orderBookManager.getOrderBook(markets.btc.upTokenId);
            const btcDownBook = orderBookManager.getOrderBook(markets.btc.downTokenId);
            const ethUpBook = orderBookManager.getOrderBook(markets.eth.upTokenId);
            const ethDownBook = orderBookManager.getOrderBook(markets.eth.downTokenId);
            
            if (btcUpBook && btcDownBook && ethUpBook && ethDownBook) {
                const combo1Bid = btcUpBook.bestBid + ethDownBook.bestBid;
                const combo2Bid = ethUpBook.bestBid + btcDownBook.bestBid;
                state.combinedBid = Math.min(combo1Bid, combo2Bid);
                state.upBid = combo1Bid <= combo2Bid ? btcUpBook.bestBid : ethUpBook.bestBid;
                state.downBid = combo1Bid <= combo2Bid ? ethDownBook.bestBid : btcDownBook.bestBid;
            }
        }
        
        // 标记为已执行
        executedStopLoss.add(timeGroup);
        signals.push(state);
        
        Logger.warning(`🚨 执行止损 [${timeGroup}]: ${state.reason}`);
        Logger.warning(`   当前 Bid: Up=$${state.upBid.toFixed(3)} Down=$${state.downBid.toFixed(3)} 合计=$${state.combinedBid.toFixed(3)}`);
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
 * 
 * 根据每个仓位的 slug 判断它属于 BTC 还是 ETH，用相应的 tokenId 来卖
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
    
    const markets = tokenMapCache.get(signal.timeGroup);
    if (!markets || !markets.btc || !markets.eth) {
        Logger.error(`[止损] 找不到 ${signal.timeGroup} 的 token 信息`);
        return { success: false, upSold: 0, downSold: 0, totalReceived: 0, totalCost: 0, savedLoss: 0 };
    }
    
    // 根据仓位 slug 分类：BTC 仓位和 ETH 仓位
    let btcUpShares = 0, btcDownShares = 0;
    let ethUpShares = 0, ethDownShares = 0;
    let totalCost = 0;
    
    for (const pos of positions) {
        const isBtc = pos.slug.includes('btc') || pos.slug.includes('bitcoin');
        if (isBtc) {
            btcUpShares += pos.upShares;
            btcDownShares += pos.downShares;
        } else {
            ethUpShares += pos.upShares;
            ethDownShares += pos.downShares;
        }
        totalCost += pos.upCost + pos.downCost;
    }
    
    const totalUpShares = btcUpShares + ethUpShares;
    const totalDownShares = btcDownShares + ethDownShares;
    
    Logger.warning(`🚨 [止损] ${signal.timeGroup}: 准备平仓`);
    Logger.warning(`   BTC: Up=${btcUpShares.toFixed(0)} Down=${btcDownShares.toFixed(0)}`);
    Logger.warning(`   ETH: Up=${ethUpShares.toFixed(0)} Down=${ethDownShares.toFixed(0)}`);
    Logger.warning(`   总成本=$${totalCost.toFixed(2)}`);
    
    // 获取当前 Bid 价格
    const btcUpBook = orderBookManager.getOrderBook(markets.btc.upTokenId);
    const btcDownBook = orderBookManager.getOrderBook(markets.btc.downTokenId);
    const ethUpBook = orderBookManager.getOrderBook(markets.eth.upTokenId);
    const ethDownBook = orderBookManager.getOrderBook(markets.eth.downTokenId);
    
    const btcUpBid = btcUpBook?.bestBid || 0;
    const btcDownBid = btcDownBook?.bestBid || 0;
    const ethUpBid = ethUpBook?.bestBid || 0;
    const ethDownBid = ethDownBook?.bestBid || 0;
    
    // 模拟模式
    if (CONFIG.SIMULATION_MODE) {
        // 计算各部分回收金额
        const btcUpReceived = btcUpShares * btcUpBid;
        const btcDownReceived = btcDownShares * btcDownBid;
        const ethUpReceived = ethUpShares * ethUpBid;
        const ethDownReceived = ethDownShares * ethDownBid;
        const totalReceived = btcUpReceived + btcDownReceived + ethUpReceived + ethDownReceived;
        const savedLoss = totalReceived;
        
        Logger.success(`🔵 [模拟止损] ${signal.timeGroup}:`);
        if (btcUpShares > 0) Logger.success(`   卖出 BTC Up: ${btcUpShares.toFixed(0)} @ $${btcUpBid.toFixed(3)} = $${btcUpReceived.toFixed(2)}`);
        if (btcDownShares > 0) Logger.success(`   卖出 BTC Down: ${btcDownShares.toFixed(0)} @ $${btcDownBid.toFixed(3)} = $${btcDownReceived.toFixed(2)}`);
        if (ethUpShares > 0) Logger.success(`   卖出 ETH Up: ${ethUpShares.toFixed(0)} @ $${ethUpBid.toFixed(3)} = $${ethUpReceived.toFixed(2)}`);
        if (ethDownShares > 0) Logger.success(`   卖出 ETH Down: ${ethDownShares.toFixed(0)} @ $${ethDownBid.toFixed(3)} = $${ethDownReceived.toFixed(2)}`);
        Logger.success(`   回收: $${totalReceived.toFixed(2)} | 成本: $${totalCost.toFixed(2)} | 盈亏: $${(totalReceived - totalCost).toFixed(2)}`);
        
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
    
    // 实盘模式：并行卖出所有持仓
    let totalReceived = 0;
    const promises: Promise<void>[] = [];
    
    if (btcUpShares > 0) {
        promises.push(
            sellFunction(markets.btc.upTokenId, btcUpShares, btcUpBid, `${signal.timeGroup} BTC Up`)
                .then(r => { if (r.success) totalReceived += r.received; })
        );
    }
    if (btcDownShares > 0) {
        promises.push(
            sellFunction(markets.btc.downTokenId, btcDownShares, btcDownBid, `${signal.timeGroup} BTC Down`)
                .then(r => { if (r.success) totalReceived += r.received; })
        );
    }
    if (ethUpShares > 0) {
        promises.push(
            sellFunction(markets.eth.upTokenId, ethUpShares, ethUpBid, `${signal.timeGroup} ETH Up`)
                .then(r => { if (r.success) totalReceived += r.received; })
        );
    }
    if (ethDownShares > 0) {
        promises.push(
            sellFunction(markets.eth.downTokenId, ethDownShares, ethDownBid, `${signal.timeGroup} ETH Down`)
                .then(r => { if (r.success) totalReceived += r.received; })
        );
    }
    
    await Promise.all(promises);
    
    const savedLoss = totalReceived;
    
    Logger.arbitrage(`🚨 [止损完成] ${signal.timeGroup}: 回收 $${totalReceived.toFixed(2)} | 成本 $${totalCost.toFixed(2)} | 盈亏 $${(totalReceived - totalCost).toFixed(2)}`);
    
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
        executedStopLoss.delete(timeGroup);
        priceTrackers.delete(timeGroup);
        tokenMapCache.delete(timeGroup);
        binanceLogTime.delete(timeGroup);
    } else {
        triggeredStopLoss.clear();
        executedStopLoss.clear();
        priceTrackers.clear();
        tokenMapCache.clear();
        binanceLogTime.clear();
    }
};

/**
 * 检查是否应该暂停某个时间组的交易
 * 
 * 只在真正触发止损时才暂停，不做预警暂停
 * 触发条件由用户配置：比例 >= STOP_LOSS_RISK_RATIO 且 次数 >= STOP_LOSS_MIN_TRIGGER_COUNT
 * 
 * 模式说明：
 * - sell 模式：触发后暂停交易，执行平仓
 * - hedge 模式：触发后停止套利，只进行对冲补仓，保本后等待结束
 */
export const shouldPauseTrading = (timeGroup: TimeGroup): { 
    pause: boolean; 
    reason: string;
    shouldHedge: boolean;  // 是否应该进入对冲模式（仅补仓，不套利）
} => {
    if (!CONFIG.STOP_LOSS_ENABLED) {
        return { pause: false, reason: '', shouldHedge: false };
    }
    
    // 对冲模式：检查对冲是否已完成
    if (CONFIG.STOP_LOSS_MODE === 'hedge') {
        // 对冲已完成，暂停所有交易，等待事件结束
        if (isHedgeCompleted(timeGroup)) {
            return { pause: true, reason: '对冲已完成，等待事件结束', shouldHedge: false };
        }
        
        // 正在对冲中，继续对冲（不套利）
        if (isHedging(timeGroup)) {
            return { pause: false, reason: '对冲进行中', shouldHedge: true };
        }
    }
    
    // 检查是否已触发止损
    if (triggeredStopLoss.has(timeGroup)) {
        if (CONFIG.STOP_LOSS_MODE === 'hedge') {
            // 对冲模式：停止套利，开始对冲补仓
            return { pause: false, reason: '风险触发，停止套利，开始对冲', shouldHedge: true };
        } else {
            // 平仓模式：暂停交易
            return { pause: true, reason: '止损已触发，暂停开仓', shouldHedge: false };
        }
    }
    
    return { pause: false, reason: '', shouldHedge: false };
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
 * 获取指定 timeGroup 的止损信号（如果已触发）
 */
export const getTriggeredSignal = (timeGroup: TimeGroup): StopLossState | null => {
    return triggeredStopLoss.get(timeGroup) || null;
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
    getTriggeredSignal,
};

