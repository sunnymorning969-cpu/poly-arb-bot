/**
 * 对冲补仓模块
 * 
 * 当触发风险阈值时，通过补仓实现保本：
 * - 原有仓位：BTC Up + ETH Down
 * - 补仓：BTC Down + ETH Up
 * - 目标：无论结果如何，收回 >= 总成本
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
}

const hedgeStates = new Map<TimeGroup, HedgeState>();

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
 * 计算每个池子需要补仓多少才能保本（同池对冲）
 * 
 * BTC 池：补 BTC Down 使得 min(BTC Up, BTC Down) >= BTC 成本
 * ETH 池：补 ETH Up 使得 min(ETH Up, ETH Down) >= ETH 成本
 */
export const calculateHedgeNeeded = (
    summary: GroupPositionSummary,
    btcDownPrice: number,
    ethUpPrice: number
): {
    needHedge: boolean;
    btcDownNeeded: number;    // BTC 池需要补的 BTC Down
    ethUpNeeded: number;      // ETH 池需要补的 ETH Up
    hedgeCost: number;
    btcDeficit: number;       // BTC 池缺口
    ethDeficit: number;       // ETH 池缺口
} => {
    const poolPayouts = calculatePoolPayouts(summary);
    
    let btcDownNeeded = 0;
    let ethUpNeeded = 0;
    
    // ========== BTC 池对冲计算 ==========
    // 持有 BTC Up shares，需要补 BTC Down 使得保本
    // 
    // 设补 x shares BTC Down @ 价格 p
    // 新成本 = btcCost + x * p
    // BTC 涨收回 = btcUpShares
    // BTC 跌收回 = btcDownShares + x
    // 
    // 要保本：min(btcUpShares, btcDownShares + x) >= btcCost + x * p
    // 
    // 情况1：btcUpShares <= btcDownShares + x（Up 是瓶颈）
    //   btcUpShares >= btcCost + x * p
    //   x <= (btcUpShares - btcCost) / p
    // 
    // 情况2：btcDownShares + x < btcUpShares（Down 是瓶颈）
    //   btcDownShares + x >= btcCost + x * p
    //   btcDownShares - btcCost >= x * (p - 1)
    //   x >= (btcCost - btcDownShares) / (1 - p)  （当 p < 1 时）
    
    if (!poolPayouts.btcBreakEven && poolPayouts.btcCost > 0) {
        // BTC 池需要对冲
        const btcDeficit = poolPayouts.btcCost - poolPayouts.btcMinPayout;
        
        if (btcDownPrice < 1) {
            // 公式：x >= (成本 - 当前 Down shares) / (1 - Down 价格)
            // 但我们要确保补仓后，min(Up, Down+x) >= 成本 + x*价格
            // 
            // 简化：让 Down + x = Up（平衡），然后确保这个值 >= 新成本
            // x = Up - Down
            // 新成本 = 旧成本 + x * p = 旧成本 + (Up - Down) * p
            // 需要 Up >= 新成本
            // Up >= 旧成本 + (Up - Down) * p
            // Up - Up * p >= 旧成本 - Down * p
            // Up * (1 - p) >= 旧成本 - Down * p
            // 
            // 如果 Up * (1-p) + Down * p >= 旧成本，则补到平衡就够了
            // 否则需要更多
            
            const balanceShares = Math.max(0, summary.btcUpShares - summary.btcDownShares);
            const balanceCost = balanceShares * btcDownPrice;
            const newCost = poolPayouts.btcCost + balanceCost;
            const newMinPayout = Math.min(summary.btcUpShares, summary.btcDownShares + balanceShares);
            
            if (newMinPayout >= newCost) {
                btcDownNeeded = Math.ceil(balanceShares);
            } else {
                // 需要补更多，使用更精确的公式
                // 设补 x shares，要 min(Up, Down+x) >= Cost + x*p
                // 假设 Down + x 是瓶颈（通常如此）
                // Down + x >= Cost + x*p
                // x * (1-p) >= Cost - Down
                // x >= (Cost - Down) / (1-p)
                const neededFromDeficit = (poolPayouts.btcCost - summary.btcDownShares) / (1 - btcDownPrice);
                btcDownNeeded = Math.ceil(Math.max(0, neededFromDeficit)) + 1;
            }
        }
    }
    
    // ========== ETH 池对冲计算 ==========
    // 持有 ETH Down shares，需要补 ETH Up 使得保本
    if (!poolPayouts.ethBreakEven && poolPayouts.ethCost > 0) {
        // ETH 池需要对冲
        if (ethUpPrice < 1) {
            const balanceShares = Math.max(0, summary.ethDownShares - summary.ethUpShares);
            const balanceCost = balanceShares * ethUpPrice;
            const newCost = poolPayouts.ethCost + balanceCost;
            const newMinPayout = Math.min(summary.ethUpShares + balanceShares, summary.ethDownShares);
            
            if (newMinPayout >= newCost) {
                ethUpNeeded = Math.ceil(balanceShares);
            } else {
                const neededFromDeficit = (poolPayouts.ethCost - summary.ethUpShares) / (1 - ethUpPrice);
                ethUpNeeded = Math.ceil(Math.max(0, neededFromDeficit)) + 1;
            }
        }
    }
    
    const needHedge = btcDownNeeded > 0 || ethUpNeeded > 0;
    const hedgeCost = btcDownNeeded * btcDownPrice + ethUpNeeded * ethUpPrice;
    
    return {
        needHedge,
        btcDownNeeded,
        ethUpNeeded,
        hedgeCost,
        btcDeficit: Math.max(0, poolPayouts.btcCost - poolPayouts.btcMinPayout),
        ethDeficit: Math.max(0, poolPayouts.ethCost - poolPayouts.ethMinPayout),
    };
};

/**
 * 开始对冲模式
 */
export const startHedging = (timeGroup: TimeGroup): void => {
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
    });
    
    // 更新全局统计
    globalHedgeStats.totalHedgeEvents++;
    
    Logger.warning(`🛡️ [${timeGroup}] 启动对冲保本模式，停止套利 (累计第 ${globalHedgeStats.totalHedgeEvents} 次)`);
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
 * 记录对冲成本
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
    getHedgeSummary,
    printHedgeStatus,
    getGlobalHedgeStats,
};

