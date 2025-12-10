/**
 * 仓位追踪模块 - 追踪每个市场的 Up/Down 持仓
 * 
 * 支持数据持久化，重启后不丢失仓位
 */

import axios from 'axios';
import Logger from './logger';
import CONFIG from './config';
import {
    getStoredPositions,
    savePosition as saveToStorage,
    deletePosition as deleteFromStorage,
    addSettlementRecord,
    getSettlementHistory as getStoredHistory,
} from './storage';

export interface Position {
    conditionId: string;
    slug: string;
    title: string;
    upShares: number;
    downShares: number;
    upCost: number;      // 买入 Up 的总成本
    downCost: number;    // 买入 Down 的总成本
    lastUpdate: number;
    endDate: string;
}

// 事件结算结果
export interface SettlementResult {
    position: Position;
    outcome: 'up' | 'down';  // 实际结果
    payout: number;          // 收到的金额
    totalCost: number;       // 总成本
    profit: number;          // 盈亏
    profitPercent: number;   // 盈亏百分比
}

// 结算回调（用于发送通知）
let onSettlementCallback: ((result: SettlementResult) => void) | null = null;

// 持仓记录（内存缓存，与存储同步）
const positions = new Map<string, Position>();

/**
 * 从存储加载仓位到内存
 */
export const loadPositionsFromStorage = (): void => {
    const stored = getStoredPositions();
    positions.clear();
    
    for (const pos of stored) {
        positions.set(pos.conditionId, pos);
    }
    
    Logger.info(`📂 已加载 ${positions.size} 个仓位`);
};

/**
 * 获取或创建仓位
 */
export const getPosition = (conditionId: string): Position | undefined => {
    return positions.get(conditionId);
};

/**
 * 更新仓位（同时保存到存储）
 */
export const updatePosition = (
    conditionId: string,
    slug: string,
    title: string,
    side: 'up' | 'down',
    shares: number,
    cost: number,
    endDate: string
): void => {
    let pos = positions.get(conditionId);
    
    if (!pos) {
        pos = {
            conditionId,
            slug,
            title,
            upShares: 0,
            downShares: 0,
            upCost: 0,
            downCost: 0,
            lastUpdate: Date.now(),
            endDate,
        };
    }
    
    if (side === 'up') {
        pos.upShares += shares;
        pos.upCost += cost;
    } else {
        pos.downShares += shares;
        pos.downCost += cost;
    }
    
    pos.lastUpdate = Date.now();
    positions.set(conditionId, pos);
    
    // 保存到持久化存储
    saveToStorage(pos);
};

/**
 * 获取仓位不平衡度
 * 返回需要买入的方向和数量
 */
export const getImbalance = (conditionId: string): {
    needBuy: 'up' | 'down' | 'both' | 'none';
    upDeficit: number;   // Up 缺少多少 shares
    downDeficit: number; // Down 缺少多少 shares
} => {
    const pos = positions.get(conditionId);
    
    if (!pos) {
        return { needBuy: 'both', upDeficit: 0, downDeficit: 0 };
    }
    
    const diff = pos.upShares - pos.downShares;
    
    if (Math.abs(diff) < 1) {
        // 基本平衡
        return { needBuy: 'both', upDeficit: 0, downDeficit: 0 };
    }
    
    if (diff > 0) {
        // Up 多，需要买 Down
        return { needBuy: 'down', upDeficit: 0, downDeficit: diff };
    } else {
        // Down 多，需要买 Up
        return { needBuy: 'up', upDeficit: -diff, downDeficit: 0 };
    }
};

/**
 * 获取事件的平均成本分析（事件级套利的核心）
 */
export const getEventCostAnalysis = (conditionId: string): {
    hasPosition: boolean;
    upShares: number;
    downShares: number;
    upCost: number;
    downCost: number;
    totalCost: number;
    minShares: number;           // 较少的一边
    avgCostPerPair: number;      // 每对 Up+Down 的平均成本
    currentProfit: number;       // 如果现在结算的预期利润
    profitPercent: number;       // 利润率
    imbalance: number;           // 不平衡度 (Up - Down)
    needMoreUp: boolean;         // 是否需要更多 Up
    needMoreDown: boolean;       // 是否需要更多 Down
} => {
    const pos = positions.get(conditionId);
    
    if (!pos || (pos.upShares === 0 && pos.downShares === 0)) {
        return {
            hasPosition: false,
            upShares: 0,
            downShares: 0,
            upCost: 0,
            downCost: 0,
            totalCost: 0,
            minShares: 0,
            avgCostPerPair: 0,
            currentProfit: 0,
            profitPercent: 0,
            imbalance: 0,
            needMoreUp: true,
            needMoreDown: true,
        };
    }
    
    const totalCost = pos.upCost + pos.downCost;
    const minShares = Math.min(pos.upShares, pos.downShares);
    const avgCostPerPair = minShares > 0 ? totalCost / minShares : 0;
    const currentProfit = minShares - totalCost;  // minShares * $1 - totalCost
    const profitPercent = totalCost > 0 ? (currentProfit / totalCost) * 100 : 0;
    const imbalance = pos.upShares - pos.downShares;
    
    return {
        hasPosition: true,
        upShares: pos.upShares,
        downShares: pos.downShares,
        upCost: pos.upCost,
        downCost: pos.downCost,
        totalCost,
        minShares,
        avgCostPerPair,
        currentProfit,
        profitPercent,
        imbalance,
        needMoreUp: imbalance < 0,      // Down 多，需要 Up
        needMoreDown: imbalance > 0,    // Up 多，需要 Down
    };
};

/**
 * 预测买入后的成本分析
 * 用于决定是否值得买入
 */
export const predictCostAfterBuy = (
    conditionId: string,
    buyUp: number,      // 要买的 Up shares
    upPrice: number,    // Up 价格
    buyDown: number,    // 要买的 Down shares
    downPrice: number,  // Down 价格
): {
    newAvgCostPerPair: number;  // 买入后每对平均成本
    newMinShares: number;       // 买入后较少的一边
    newProfit: number;          // 买入后的预期利润
    newProfitPercent: number;   // 买入后的利润率
    worthBuying: boolean;       // 是否值得买入
} => {
    const current = getEventCostAnalysis(conditionId);
    
    const newUpShares = current.upShares + buyUp;
    const newDownShares = current.downShares + buyDown;
    const newUpCost = current.upCost + (buyUp * upPrice);
    const newDownCost = current.downCost + (buyDown * downPrice);
    const newTotalCost = newUpCost + newDownCost;
    const newMinShares = Math.min(newUpShares, newDownShares);
    const newAvgCostPerPair = newMinShares > 0 ? newTotalCost / newMinShares : 0;
    const newProfit = newMinShares - newTotalCost;
    const newProfitPercent = newTotalCost > 0 ? (newProfit / newTotalCost) * 100 : 0;
    
    // 值得买入的条件：
    // 1. 平均成本 < $1.00（确保盈利）
    // 2. 或者能改善不平衡度
    const worthBuying = newAvgCostPerPair < 1.0 || newProfit > current.currentProfit;
    
    return {
        newAvgCostPerPair,
        newMinShares,
        newProfit,
        newProfitPercent,
        worthBuying,
    };
};

/**
 * 获取所有活跃仓位
 */
export const getAllPositions = (): Position[] => {
    return Array.from(positions.values());
};

// ==================== 跨池子套利支持 ====================

/**
 * 时间段类型
 */
export type TimeGroup = '15min' | '1hr';

/**
 * 获取仓位的时间段分组
 */
export const getTimeGroup = (slug: string): TimeGroup => {
    if (slug.includes('15m') || slug.includes('15min')) {
        return '15min';
    }
    return '1hr';
};

/**
 * 获取组合仓位分析（跨池子）
 * 将同一时间段的 BTC 和 ETH 视为一个组合
 */
export const getGroupCostAnalysis = (timeGroup: TimeGroup): {
    hasPosition: boolean;
    totalUpShares: number;      // 组合 Up 总量（BTC Up + ETH Up）
    totalDownShares: number;    // 组合 Down 总量（BTC Down + ETH Down）
    totalUpCost: number;        // 组合 Up 总成本
    totalDownCost: number;      // 组合 Down 总成本
    totalCost: number;          // 组合总成本
    minShares: number;          // 较少的一边
    avgCostPerPair: number;     // 每对平均成本
    currentProfit: number;      // 预期利润
    profitPercent: number;      // 利润率
    imbalance: number;          // 不平衡度 (Up - Down)
    needMoreUp: boolean;
    needMoreDown: boolean;
    positions: Position[];      // 组内的所有仓位
} => {
    const groupPositions: Position[] = [];
    let totalUpShares = 0;
    let totalDownShares = 0;
    let totalUpCost = 0;
    let totalDownCost = 0;
    
    for (const pos of positions.values()) {
        if (getTimeGroup(pos.slug) === timeGroup) {
            groupPositions.push(pos);
            totalUpShares += pos.upShares;
            totalDownShares += pos.downShares;
            totalUpCost += pos.upCost;
            totalDownCost += pos.downCost;
        }
    }
    
    const totalCost = totalUpCost + totalDownCost;
    const minShares = Math.min(totalUpShares, totalDownShares);
    const avgCostPerPair = minShares > 0 ? totalCost / minShares : 0;
    const currentProfit = minShares - totalCost;
    const profitPercent = totalCost > 0 ? (currentProfit / totalCost) * 100 : 0;
    const imbalance = totalUpShares - totalDownShares;
    
    return {
        hasPosition: groupPositions.length > 0 && (totalUpShares > 0 || totalDownShares > 0),
        totalUpShares,
        totalDownShares,
        totalUpCost,
        totalDownCost,
        totalCost,
        minShares,
        avgCostPerPair,
        currentProfit,
        profitPercent,
        imbalance,
        needMoreUp: imbalance < 0,
        needMoreDown: imbalance > 0,
        positions: groupPositions,
    };
};

/**
 * 预测跨池买入后的组合成本
 */
export const predictGroupCostAfterBuy = (
    timeGroup: TimeGroup,
    buyUp: number,      // 要买的 Up（不管是 BTC 还是 ETH）
    upPrice: number,
    buyDown: number,    // 要买的 Down
    downPrice: number,
): {
    newAvgCostPerPair: number;
    newMinShares: number;
    newProfit: number;
    newProfitPercent: number;
    worthBuying: boolean;
} => {
    const current = getGroupCostAnalysis(timeGroup);
    
    const newUpShares = current.totalUpShares + buyUp;
    const newDownShares = current.totalDownShares + buyDown;
    const newUpCost = current.totalUpCost + (buyUp * upPrice);
    const newDownCost = current.totalDownCost + (buyDown * downPrice);
    const newTotalCost = newUpCost + newDownCost;
    const newMinShares = Math.min(newUpShares, newDownShares);
    const newAvgCostPerPair = newMinShares > 0 ? newTotalCost / newMinShares : 0;
    const newProfit = newMinShares - newTotalCost;
    const newProfitPercent = newTotalCost > 0 ? (newProfit / newTotalCost) * 100 : 0;
    
    const worthBuying = newAvgCostPerPair < 1.0 || newProfit > current.currentProfit;
    
    return {
        newAvgCostPerPair,
        newMinShares,
        newProfit,
        newProfitPercent,
        worthBuying,
    };
};

/**
 * 获取仓位统计
 */
export const getPositionStats = (): {
    totalPositions: number;
    totalUpShares: number;
    totalDownShares: number;
    totalCost: number;
    expectedProfit: number;
} => {
    let totalUpShares = 0;
    let totalDownShares = 0;
    let totalCost = 0;
    
    for (const pos of positions.values()) {
        totalUpShares += pos.upShares;
        totalDownShares += pos.downShares;
        totalCost += pos.upCost + pos.downCost;
    }
    
    // 预期利润 = 最小持仓 * $1 - 总成本
    const minShares = Math.min(totalUpShares, totalDownShares);
    const expectedProfit = minShares - totalCost;
    
    return {
        totalPositions: positions.size,
        totalUpShares,
        totalDownShares,
        totalCost,
        expectedProfit,
    };
};

/**
 * 设置结算回调（用于发送通知）
 */
export const onSettlement = (callback: (result: SettlementResult) => void): void => {
    onSettlementCallback = callback;
};

/**
 * 从 Polymarket API 获取事件的真实结算结果
 * 返回 'up' | 'down' | null（如果无法获取）
 */
export const fetchRealOutcome = async (slug: string): Promise<'up' | 'down' | null> => {
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
        
        // 找到 Up/Down 市场
        for (const market of markets) {
            let outcomes = market.outcomes;
            if (typeof outcomes === 'string') {
                try { outcomes = JSON.parse(outcomes); } catch { continue; }
            }
            
            if (!outcomes || !Array.isArray(outcomes)) continue;
            
            const outcomeNames = outcomes.map((o: string) => o.toLowerCase());
            if (!outcomeNames.includes('up') || !outcomeNames.includes('down')) continue;
            
            // 调试日志：显示市场信息
            Logger.info(`🔍 [调试] 市场: ${market.slug || market.question || 'unknown'}`);
            Logger.info(`🔍 [调试] outcomes: ${JSON.stringify(outcomes)}`);
            
            // 检查市场是否已结算
            // Polymarket 通常用 outcomePrices 来表示结果：获胜方价格 = 1，失败方价格 = 0
            let outcomePrices = market.outcomePrices;
            if (typeof outcomePrices === 'string') {
                try { outcomePrices = JSON.parse(outcomePrices); } catch { continue; }
            }
            
            Logger.info(`🔍 [调试] outcomePrices: ${JSON.stringify(outcomePrices)}`);
            
            if (outcomePrices && Array.isArray(outcomePrices) && outcomePrices.length >= 2) {
                const upIndex = outcomeNames.indexOf('up');
                const downIndex = outcomeNames.indexOf('down');
                
                const upPrice = parseFloat(outcomePrices[upIndex]) || 0;
                const downPrice = parseFloat(outcomePrices[downIndex]) || 0;
                
                Logger.info(`🔍 [调试] upIndex=${upIndex}, downIndex=${downIndex}, upPrice=${upPrice}, downPrice=${downPrice}`);
                
                // 如果价格是 1 或 0，说明已结算
                if (upPrice >= 0.99) {
                    Logger.info(`📊 ${slug} 真实结果: UP 获胜 (价格: ${upPrice})`);
                    return 'up';
                } else if (downPrice >= 0.99) {
                    Logger.info(`📊 ${slug} 真实结果: DOWN 获胜 (价格: ${downPrice})`);
                    return 'down';
                }
            }
            
            // 也检查 winningOutcome 字段（如果有）
            if (market.winningOutcome) {
                const winner = market.winningOutcome.toLowerCase();
                Logger.info(`🔍 [调试] winningOutcome: ${market.winningOutcome}`);
                if (winner === 'up' || winner === 'down') {
                    Logger.info(`📊 ${slug} 真实结果: ${winner.toUpperCase()} 获胜 (winningOutcome)`);
                    return winner as 'up' | 'down';
                }
            }
        }
        
        return null;
    } catch (error) {
        Logger.warning(`⚠️ 获取 ${slug} 结算结果失败: ${error}`);
        return null;
    }
};

/**
 * 结算一个仓位
 */
export const settlePosition = (pos: Position, outcome: 'up' | 'down'): SettlementResult => {
    // outcome 必须传入（真实结果或模拟结果）
    
    const totalCost = pos.upCost + pos.downCost;
    
    // 计算收益
    // 如果 Up 赢，Up shares 每个值 $1，Down shares 值 $0
    // 如果 Down 赢，Down shares 每个值 $1，Up shares 值 $0
    let payout: number;
    if (outcome === 'up') {
        payout = pos.upShares;  // Up 赢，收到 Up shares 数量的 $
    } else {
        payout = pos.downShares;  // Down 赢，收到 Down shares 数量的 $
    }
    
    const profit = payout - totalCost;
    const profitPercent = totalCost > 0 ? (profit / totalCost) * 100 : 0;
    
    const result: SettlementResult = {
        position: { ...pos },
        outcome,
        payout,
        totalCost,
        profit,
        profitPercent,
    };
    
    // 保存到持久化存储
    addSettlementRecord({
        conditionId: pos.conditionId,
        slug: pos.slug,
        title: pos.title,
        outcome,
        payout,
        totalCost,
        profit,
        profitPercent,
        settledAt: Date.now(),
    });
    
    // 调用回调
    if (onSettlementCallback) {
        onSettlementCallback(result);
    }
    
    return result;
};

/**
 * 止损结算 - 记录止损操作的盈亏
 * 
 * @param timeGroup 时间组（15min/1hr）
 * @param totalReceived 止损卖出收回的金额
 * @param totalCost 原始成本
 */
export const settleStopLoss = (
    timeGroup: TimeGroup,
    totalReceived: number,
    totalCost: number
): SettlementResult[] => {
    const results: SettlementResult[] = [];
    
    // 找到该时间组的所有仓位
    const positionsToSettle: Position[] = [];
    for (const [conditionId, pos] of positions) {
        if (getTimeGroup(pos.slug) === timeGroup) {
            positionsToSettle.push(pos);
        }
    }
    
    if (positionsToSettle.length === 0) {
        return results;
    }
    
    // 计算每个仓位的止损结果（按比例分配收回金额）
    const totalOriginalCost = positionsToSettle.reduce((sum, p) => sum + p.upCost + p.downCost, 0);
    
    for (const pos of positionsToSettle) {
        const posCost = pos.upCost + pos.downCost;
        const costRatio = totalOriginalCost > 0 ? posCost / totalOriginalCost : 0;
        const posReceived = totalReceived * costRatio;
        const profit = posReceived - posCost;
        const profitPercent = posCost > 0 ? (profit / posCost) * 100 : 0;
        
        const result: SettlementResult = {
            position: { ...pos },
            outcome: 'down',  // 止损视为 down 结果（因为是提前卖出）
            payout: posReceived,
            totalCost: posCost,
            profit,
            profitPercent,
        };
        
        // 保存到持久化存储（标记为止损）
        addSettlementRecord({
            conditionId: pos.conditionId,
            slug: pos.slug + ' [止损]',
            title: pos.title + ' [止损]',
            outcome: 'stop_loss' as any,
            payout: posReceived,
            totalCost: posCost,
            profit,
            profitPercent,
            settledAt: Date.now(),
        });
        
        // 从内存和存储中删除仓位
        positions.delete(pos.conditionId);
        deleteFromStorage(pos.conditionId);
        
        results.push(result);
        
        Logger.info(`🚨 [止损结算] ${pos.slug}: 成本 $${posCost.toFixed(2)} → 收回 $${posReceived.toFixed(2)} = 盈亏 $${profit.toFixed(2)}`);
    }
    
    return results;
};

/**
 * 检查并结算已到期的仓位
 * 
 * 无论模拟模式还是实盘模式，都从 API 获取真实结算结果
 * 这样才能准确评估策略效果
 */
export const checkAndSettleExpired = async (): Promise<SettlementResult[]> => {
    const now = Date.now();
    const settled: SettlementResult[] = [];
    
    // 收集到期的仓位
    const expiredPositions: Array<{ conditionId: string; pos: Position; endTime: number }> = [];
    
    for (const [conditionId, pos] of positions) {
        // 解析结束时间
        const endTime = new Date(pos.endDate).getTime();
        
        // 检查日期是否有效
        if (isNaN(endTime)) {
            Logger.warning(`⚠️ 无效的 endDate: ${pos.endDate} for ${pos.slug}`);
            continue;
        }
        
        // 事件已结束（加 2 分钟缓冲，确保 API 已更新结果）
        const bufferMs = 2 * 60 * 1000;  // 2 分钟
        if (endTime + bufferMs < now) {
            Logger.info(`⏰ 事件已结束: ${pos.slug} (结束于 ${new Date(endTime).toLocaleString()})`);
            expiredPositions.push({ conditionId, pos, endTime });
        }
    }
    
    if (expiredPositions.length === 0) {
        return settled;
    }
    
    // ========== 从 API 获取真实结果（无论模拟还是实盘） ==========
    const modeTag = CONFIG.SIMULATION_MODE ? '[模拟]' : '[实盘]';
    
    for (const { conditionId, pos } of expiredPositions) {
        // 从 API 获取真实结果
        const realOutcome = await fetchRealOutcome(pos.slug);
        
        if (realOutcome) {
            Logger.info(`${modeTag} 📊 ${pos.slug.slice(0, 25)} → ${realOutcome.toUpperCase()} 获胜`);
            const result = settlePosition(pos, realOutcome);
            settled.push(result);
            
            // 从内存和存储中删除仓位
            positions.delete(conditionId);
            deleteFromStorage(conditionId);
        } else {
            Logger.warning(`⚠️ 无法获取 ${pos.slug} 的真实结果，延迟结算`);
            // 不删除，下次再尝试
        }
    }
    
    return settled;
};

/**
 * 清理已结算的仓位（保留向后兼容）
 */
export const cleanExpiredPositions = async (): Promise<SettlementResult[]> => {
    return checkAndSettleExpired();
};

/**
 * 获取结算历史
 */
export const getSettlementHistory = () => {
    return getStoredHistory();
};

/**
 * 获取总体结算统计（从持久化存储读取）
 */
export const getOverallStats = (): {
    totalSettled: number;
    totalProfit: number;
    winCount: number;
    lossCount: number;
    winRate: number;
} => {
    const history = getStoredHistory();
    
    let totalProfit = 0;
    let winCount = 0;
    let lossCount = 0;
    
    for (const record of history) {
        totalProfit += record.profit;
        if (record.profit > 0) {
            winCount++;
        } else if (record.profit < 0) {
            lossCount++;
        }
    }
    
    const totalSettled = history.length;
    const winRate = totalSettled > 0 ? (winCount / totalSettled) * 100 : 0;
    
    return {
        totalSettled,
        totalProfit,
        winCount,
        lossCount,
        winRate,
    };
};

export default {
    loadPositionsFromStorage,
    getPosition,
    updatePosition,
    getImbalance,
    getAllPositions,
    getPositionStats,
    cleanExpiredPositions,
    checkAndSettleExpired,
    settlePosition,
    onSettlement,
    getOverallStats,
};



