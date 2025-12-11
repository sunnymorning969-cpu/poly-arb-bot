/**
 * 对冲补仓模块
 * 
 * 当触发风险阈值时，通过补仓减少损失：
 * 
 * 核心公式：
 *   亏损 = (原买入组合价格 - 对冲时组合价格) × shares
 * 
 * 例如：原买入 $0.85，对冲时 $0.65，亏损 = 0.20 × shares = 9.1%
 * 
 * 关键洞察：
 *   1. 在原买入价对冲 = 保本（亏损 0%）
 *   2. 组合价格跌得越多，亏得越多
 *   3. 但对冲亏损 << 双输归零（100%亏损）
 * 
 * 所以对冲的意义是：把最坏情况从 100% 亏损降低到 ~10-20% 亏损
 */

import Logger from './logger';
import CONFIG from './config';
import { TimeGroup, getAllPositions, Position } from './positions';

// 对冲状态
interface HedgeState {
    isHedging: boolean;           // 是否正在对冲
    isCompleted: boolean;         // 对冲是否已完成（已保本）
    startTime: number;            // 开始对冲时间
    totalHedgeCost: number;       // 对冲总成本
    hedgeCount: number;           // 对冲次数
    lastLogTime: number;          // 上次打印日志时间
    // 目标补仓数量（启动时一次性计算）
    targetBtcUp: number;          // 需要补的 BTC Up 总数
    targetBtcDown: number;        // 需要补的 BTC Down 总数
    targetEthUp: number;          // 需要补的 ETH Up 总数
    targetEthDown: number;        // 需要补的 ETH Down 总数
    // 已补数量
    filledBtcUp: number;
    filledBtcDown: number;
    filledEthUp: number;
    filledEthDown: number;
}

const hedgeStates = new Map<TimeGroup, HedgeState>();

// 对冲日志控制
const HEDGE_LOG_INTERVAL_MS = 5000;  // 每5秒最多打印一次对冲日志

// 对冲执行 - 无冷却，尽快完成
const lastHedgeExecution = new Map<TimeGroup, number>();
const HEDGE_COOLDOWN_MS = 0;  // 无冷却

export const shouldPrintHedgeLog = (timeGroup: TimeGroup): boolean => {
    const state = hedgeStates.get(timeGroup);
    if (!state) return true;
    
    const now = Date.now();
    if (now - state.lastLogTime >= HEDGE_LOG_INTERVAL_MS) {
        state.lastLogTime = now;
        return true;
    }
    return false;
};

/**
 * 检查是否可以执行对冲（冷却控制）
 */
export const canExecuteHedge = (timeGroup: TimeGroup): boolean => {
    const lastTime = lastHedgeExecution.get(timeGroup) || 0;
    const now = Date.now();
    
    if (now - lastTime >= HEDGE_COOLDOWN_MS) {
        lastHedgeExecution.set(timeGroup, now);
        return true;
    }
    return false;
};

// 全局对冲统计（累计所有事件）
interface HedgeStats {
    totalHedgeEvents: number;     // 触发对冲的事件总数
    completedHedgeEvents: number; // 成功保本的事件数
    totalHedgeCost: number;       // 累计对冲成本
    totalHedgeTrades: number;     // 累计对冲交易次数
}

const globalHedgeStats: HedgeStats = {
    totalHedgeEvents: 0,
    completedHedgeEvents: 0,
    totalHedgeCost: 0,
    totalHedgeTrades: 0,
};

// 获取时间组的所有仓位汇总
interface GroupPositionSummary {
    btcUpShares: number;
    btcDownShares: number;
    ethUpShares: number;
    ethDownShares: number;
    btcUpCost: number;
    btcDownCost: number;
    ethUpCost: number;
    ethDownCost: number;
    totalCost: number;
}

/**
 * 获取指定时间组的仓位汇总
 */
export const getGroupPositionSummary = (timeGroup: TimeGroup): GroupPositionSummary => {
    const positions = getAllPositions();
    
    let summary: GroupPositionSummary = {
        btcUpShares: 0,
        btcDownShares: 0,
        ethUpShares: 0,
        ethDownShares: 0,
        btcUpCost: 0,
        btcDownCost: 0,
        ethUpCost: 0,
        ethDownCost: 0,
        totalCost: 0,
    };
    
    for (const pos of positions) {
        // 检查是否属于这个时间组
        const is15min = pos.slug.includes('15m') || pos.slug.includes('15min');
        const posTimeGroup: TimeGroup = is15min ? '15min' : '1hr';
        
        if (posTimeGroup !== timeGroup) continue;
        
        // 判断是 BTC 还是 ETH
        const isBtc = pos.slug.toLowerCase().includes('btc') || pos.slug.toLowerCase().includes('bitcoin');
        
        if (isBtc) {
            summary.btcUpShares += pos.upShares;
            summary.btcDownShares += pos.downShares;
            summary.btcUpCost += pos.upCost;
            summary.btcDownCost += pos.downCost;
        } else {
            summary.ethUpShares += pos.upShares;
            summary.ethDownShares += pos.downShares;
            summary.ethUpCost += pos.upCost;
            summary.ethDownCost += pos.downCost;
        }
    }
    
    summary.totalCost = summary.btcUpCost + summary.btcDownCost + 
                        summary.ethUpCost + summary.ethDownCost;
    
    return summary;
};

/**
 * 计算每个池子的收回情况（同池对冲）
 * 
 * 每个池子独立计算：
 * - BTC 池：BTC 涨时收 BTC Up，BTC 跌时收 BTC Down
 * - ETH 池：ETH 涨时收 ETH Up，ETH 跌时收 ETH Down
 */
export const calculatePoolPayouts = (summary: GroupPositionSummary): {
    // BTC 池
    btcUpPayout: number;      // BTC 涨时收回
    btcDownPayout: number;    // BTC 跌时收回
    btcMinPayout: number;     // BTC 池最小收回
    btcCost: number;          // BTC 池成本
    btcBreakEven: boolean;    // BTC 池是否保本
    // ETH 池
    ethUpPayout: number;      // ETH 涨时收回
    ethDownPayout: number;    // ETH 跌时收回
    ethMinPayout: number;     // ETH 池最小收回
    ethCost: number;          // ETH 池成本
    ethBreakEven: boolean;    // ETH 池是否保本
    // 总体
    totalMinPayout: number;
    totalCost: number;
    isBreakEven: boolean;
} => {
    // BTC 池
    const btcUpPayout = summary.btcUpShares;      // BTC 涨时，Up shares 各值 $1
    const btcDownPayout = summary.btcDownShares;  // BTC 跌时，Down shares 各值 $1
    const btcMinPayout = Math.min(btcUpPayout, btcDownPayout);
    const btcCost = summary.btcUpCost + summary.btcDownCost;
    const btcBreakEven = btcMinPayout >= btcCost;
    
    // ETH 池
    const ethUpPayout = summary.ethUpShares;      // ETH 涨时，Up shares 各值 $1
    const ethDownPayout = summary.ethDownShares;  // ETH 跌时，Down shares 各值 $1
    const ethMinPayout = Math.min(ethUpPayout, ethDownPayout);
    const ethCost = summary.ethUpCost + summary.ethDownCost;
    const ethBreakEven = ethMinPayout >= ethCost;
    
    // 总体
    const totalMinPayout = btcMinPayout + ethMinPayout;
    const totalCost = btcCost + ethCost;
    const isBreakEven = btcBreakEven && ethBreakEven;
    
    return {
        btcUpPayout,
        btcDownPayout,
        btcMinPayout,
        btcCost,
        btcBreakEven,
        ethUpPayout,
        ethDownPayout,
        ethMinPayout,
        ethCost,
        ethBreakEven,
        totalMinPayout,
        totalCost,
        isBreakEven,
    };
};

/**
 * 计算每个池子需要补仓多少（同池对冲）
 * 
 * 核心公式：亏损 = (原买入组合价格 - 对冲时组合价格) × shares
 * 
 * 例如：
 *   - 原买入组合价格 $0.85，累计 1000 shares
 *   - 对冲时组合价格 $0.65
 *   - 亏损 = (0.85 - 0.65) × 1000 = $200 (9.1%)
 * 
 * 对冲意义：把双输 100% 亏损降低到 ~10-20% 亏损
 */
export const calculateHedgeNeeded = (
    summary: GroupPositionSummary,
    btcUpPrice: number,
    btcDownPrice: number,
    ethUpPrice: number,
    ethDownPrice: number
): {
    needHedge: boolean;
    btcUpNeeded: number;      // BTC 池需要补的 BTC Up
    btcDownNeeded: number;    // BTC 池需要补的 BTC Down
    ethUpNeeded: number;      // ETH 池需要补的 ETH Up
    ethDownNeeded: number;    // ETH 池需要补的 ETH Down
    hedgeCost: number;
    canBreakEven: boolean;    // 是否可以保本
    breakEvenReason: string;  // 保本计算说明
    expectedLoss: number;     // 预期亏损金额
    expectedLossPercent: number; // 预期亏损百分比
} => {
    // ========== 第一步：简单平衡策略（让两边 shares 相等）==========
    let btcUpNeeded = 0;
    let btcDownNeeded = 0;
    let ethUpNeeded = 0;
    let ethDownNeeded = 0;
    
    // BTC 池平衡
    if (summary.btcUpShares > summary.btcDownShares) {
        btcDownNeeded = Math.ceil(summary.btcUpShares - summary.btcDownShares);
    } else if (summary.btcDownShares > summary.btcUpShares) {
        btcUpNeeded = Math.ceil(summary.btcDownShares - summary.btcUpShares);
    }
    
    // ETH 池平衡
    if (summary.ethUpShares > summary.ethDownShares) {
        ethDownNeeded = Math.ceil(summary.ethUpShares - summary.ethDownShares);
    } else if (summary.ethDownShares > summary.ethUpShares) {
        ethUpNeeded = Math.ceil(summary.ethDownShares - summary.ethUpShares);
    }
    
    const needHedge = btcUpNeeded > 0 || btcDownNeeded > 0 || ethUpNeeded > 0 || ethDownNeeded > 0;
    const hedgeCost = btcUpNeeded * btcUpPrice + btcDownNeeded * btcDownPrice + 
                      ethUpNeeded * ethUpPrice + ethDownNeeded * ethDownPrice;
    
    // ========== 第二步：计算预期亏损 ==========
    // 对冲后的 shares 数量
    const btcFinalShares = Math.max(summary.btcUpShares + btcUpNeeded, summary.btcDownShares + btcDownNeeded);
    const ethFinalShares = Math.max(summary.ethUpShares + ethUpNeeded, summary.ethDownShares + ethDownNeeded);
    
    // 总成本（原成本 + 对冲成本）
    const totalCost = summary.totalCost + hedgeCost;
    
    // 无论结果如何，收回 = btcFinalShares + ethFinalShares
    const minReturn = btcFinalShares + ethFinalShares;
    
    // 预期亏损
    const expectedLoss = Math.max(0, totalCost - minReturn);
    const expectedLossPercent = totalCost > 0 ? (expectedLoss / totalCost * 100) : 0;
    
    let canBreakEven = expectedLoss <= 0;
    let breakEvenReason = '';
    
    // 计算当前组合价格（用于参考）
    const currentComboPrice = btcDownPrice + ethUpPrice;  // 原仓位组合
    const hedgeComboPrice = btcUpPrice + ethDownPrice;    // 对冲组合
    
    // 计算原买入平均组合价格
    const totalShares = Math.max(summary.btcDownShares, summary.ethUpShares);
    const avgOrigPrice = totalShares > 0 ? summary.totalCost / totalShares : 0;
    
    if (canBreakEven) {
        breakEvenReason = `✅ 可保本 | 总成本 $${totalCost.toFixed(0)} | 收回 $${minReturn.toFixed(0)}`;
    } else {
        // 使用简化公式解释
        breakEvenReason = `⚠️ 亏损 $${expectedLoss.toFixed(0)} (${expectedLossPercent.toFixed(1)}%) | `;
        breakEvenReason += `原组合价 ~$${avgOrigPrice.toFixed(2)} → 现组合价 $${currentComboPrice.toFixed(2)}`;
        breakEvenReason += ` | 但对冲后亏损远小于双输 100%`;
    }
    
    return {
        needHedge,
        btcUpNeeded,
        btcDownNeeded,
        ethUpNeeded,
        ethDownNeeded,
        hedgeCost,
        canBreakEven,
        breakEvenReason,
        expectedLoss,
        expectedLossPercent,
    };
};

/**
 * 开始对冲模式（一次性计算目标补仓数量）
 */
export const startHedging = (
    timeGroup: TimeGroup,
    targets: {
        btcUp: number;
        btcDown: number;
        ethUp: number;
        ethDown: number;
    }
): void => {
    const existing = hedgeStates.get(timeGroup);
    if (existing && existing.isHedging) {
        return; // 已经在对冲
    }
    
    hedgeStates.set(timeGroup, {
        isHedging: true,
        isCompleted: false,
        startTime: Date.now(),
        totalHedgeCost: 0,
        hedgeCount: 0,
        lastLogTime: Date.now(),
        // 目标补仓数量（一次性计算，不再改变）
        targetBtcUp: targets.btcUp,
        targetBtcDown: targets.btcDown,
        targetEthUp: targets.ethUp,
        targetEthDown: targets.ethDown,
        // 已补数量
        filledBtcUp: 0,
        filledBtcDown: 0,
        filledEthUp: 0,
        filledEthDown: 0,
    });
    
    // 更新全局统计
    globalHedgeStats.totalHedgeEvents++;
    
    Logger.warning(`🛡️ [${timeGroup}] 启动对冲保本模式，停止套利 (累计第 ${globalHedgeStats.totalHedgeEvents} 次)`);
    Logger.warning(`   目标: BTC Up +${targets.btcUp} Down +${targets.btcDown} | ETH Up +${targets.ethUp} Down +${targets.ethDown}`);
};

/**
 * 标记对冲完成（已保本）
 */
export const completeHedging = (timeGroup: TimeGroup): void => {
    const state = hedgeStates.get(timeGroup);
    if (state && !state.isCompleted) {
        state.isCompleted = true;
        
        // 更新全局统计
        globalHedgeStats.completedHedgeEvents++;
        globalHedgeStats.totalHedgeCost += state.totalHedgeCost;
        globalHedgeStats.totalHedgeTrades += state.hedgeCount;
        
        Logger.success(`🛡️ [${timeGroup}] 对冲完成！已保本，等待事件结束`);
        Logger.info(`   本次: 补仓 ${state.hedgeCount} 次，成本 $${state.totalHedgeCost.toFixed(2)}`);
        Logger.info(`   累计: ${globalHedgeStats.completedHedgeEvents}/${globalHedgeStats.totalHedgeEvents} 次保本成功`);
    }
};

/**
 * 停止对冲模式（事件结束时调用）
 */
export const stopHedging = (timeGroup: TimeGroup): void => {
    const state = hedgeStates.get(timeGroup);
    if (state) {
        if (state.isHedging && !state.isCompleted) {
            Logger.warning(`🛡️ [${timeGroup}] 对冲未完成，事件已结束`);
        }
    }
    hedgeStates.delete(timeGroup);
};

/**
 * 检查是否正在对冲
 */
export const isHedging = (timeGroup: TimeGroup): boolean => {
    const state = hedgeStates.get(timeGroup);
    return state?.isHedging ?? false;
};

/**
 * 检查对冲是否已完成（已保本）
 */
export const isHedgeCompleted = (timeGroup: TimeGroup): boolean => {
    const state = hedgeStates.get(timeGroup);
    return state?.isCompleted ?? false;
};

/**
 * 记录对冲成本和已补数量
 */
export const recordHedgeFill = (
    timeGroup: TimeGroup,
    side: 'btcUp' | 'btcDown' | 'ethUp' | 'ethDown',
    shares: number,
    cost: number
): void => {
    const state = hedgeStates.get(timeGroup);
    if (!state) return;
    
    state.totalHedgeCost += cost;
    state.hedgeCount++;
    
    // 更新已补数量
    switch (side) {
        case 'btcUp': state.filledBtcUp += shares; break;
        case 'btcDown': state.filledBtcDown += shares; break;
        case 'ethUp': state.filledEthUp += shares; break;
        case 'ethDown': state.filledEthDown += shares; break;
    }
    
    // 检查是否全部补完
    const btcUpDone = state.filledBtcUp >= state.targetBtcUp;
    const btcDownDone = state.filledBtcDown >= state.targetBtcDown;
    const ethUpDone = state.filledEthUp >= state.targetEthUp;
    const ethDownDone = state.filledEthDown >= state.targetEthDown;
    
    if (btcUpDone && btcDownDone && ethUpDone && ethDownDone) {
        completeHedging(timeGroup);
    }
};

/**
 * 获取剩余需要补的数量
 */
export const getRemainingHedge = (timeGroup: TimeGroup): {
    btcUp: number;
    btcDown: number;
    ethUp: number;
    ethDown: number;
} | null => {
    const state = hedgeStates.get(timeGroup);
    if (!state || !state.isHedging || state.isCompleted) return null;
    
    return {
        btcUp: Math.max(0, state.targetBtcUp - state.filledBtcUp),
        btcDown: Math.max(0, state.targetBtcDown - state.filledBtcDown),
        ethUp: Math.max(0, state.targetEthUp - state.filledEthUp),
        ethDown: Math.max(0, state.targetEthDown - state.filledEthDown),
    };
};

/**
 * 记录对冲成本（旧接口，保持兼容）
 */
export const recordHedgeCost = (timeGroup: TimeGroup, cost: number): void => {
    const state = hedgeStates.get(timeGroup);
    if (state) {
        state.totalHedgeCost += cost;
        state.hedgeCount++;
    }
};

/**
 * 获取对冲状态摘要
 */
export const getHedgeSummary = (timeGroup: TimeGroup): {
    isHedging: boolean;
    summary: GroupPositionSummary;
    poolPayouts: ReturnType<typeof calculatePoolPayouts>;
    isBreakEven: boolean;
} => {
    const summary = getGroupPositionSummary(timeGroup);
    const poolPayouts = calculatePoolPayouts(summary);
    
    return {
        isHedging: isHedging(timeGroup),
        summary,
        poolPayouts,
        isBreakEven: poolPayouts.isBreakEven,
    };
};

/**
 * 打印对冲状态（同池对冲视角）
 */
export const printHedgeStatus = (timeGroup: TimeGroup): void => {
    const { summary, poolPayouts, isBreakEven } = getHedgeSummary(timeGroup);
    
    if (summary.totalCost === 0) return;
    
    const btcEmoji = poolPayouts.btcBreakEven ? '✅' : '⚠️';
    const ethEmoji = poolPayouts.ethBreakEven ? '✅' : '⚠️';
    const totalEmoji = isBreakEven ? '✅' : '⚠️';
    
    Logger.info(`🛡️ [${timeGroup}] 对冲状态（同池对冲）:`);
    Logger.info(`   BTC池: U${summary.btcUpShares.toFixed(0)}/D${summary.btcDownShares.toFixed(0)} | 成本$${poolPayouts.btcCost.toFixed(2)} | 收回$${poolPayouts.btcMinPayout.toFixed(0)} ${btcEmoji}`);
    Logger.info(`   ETH池: U${summary.ethUpShares.toFixed(0)}/D${summary.ethDownShares.toFixed(0)} | 成本$${poolPayouts.ethCost.toFixed(2)} | 收回$${poolPayouts.ethMinPayout.toFixed(0)} ${ethEmoji}`);
    Logger.info(`   ${totalEmoji} 总计: 成本$${poolPayouts.totalCost.toFixed(2)} | 最小收回$${poolPayouts.totalMinPayout.toFixed(0)} ${isBreakEven ? '≥ 保本' : '< 待补仓'}`);
};

/**
 * 获取全局对冲统计
 */
export const getGlobalHedgeStats = (): {
    totalHedgeEvents: number;      // 触发对冲的事件总数
    completedHedgeEvents: number;  // 成功保本的事件数
    totalHedgeCost: number;        // 累计对冲成本
    totalHedgeTrades: number;      // 累计对冲交易次数
    successRate: number;           // 保本成功率
} => {
    const successRate = globalHedgeStats.totalHedgeEvents > 0 
        ? (globalHedgeStats.completedHedgeEvents / globalHedgeStats.totalHedgeEvents) * 100 
        : 0;
    
    return {
        ...globalHedgeStats,
        successRate,
    };
};

export default {
    getGroupPositionSummary,
    calculatePoolPayouts,
    calculateHedgeNeeded,
    startHedging,
    completeHedging,
    stopHedging,
    isHedging,
    isHedgeCompleted,
    recordHedgeCost,
    recordHedgeFill,
    getRemainingHedge,
    getHedgeSummary,
    printHedgeStatus,
    getGlobalHedgeStats,
    canExecuteHedge,
};

