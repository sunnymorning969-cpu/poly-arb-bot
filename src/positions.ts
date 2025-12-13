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
import { getUserPositions, UserPosition } from './redeemer';

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
    // 仓位平衡度（结算时的快照）
    balanceInfo?: {
        btcUp: number;
        btcDown: number;
        btcBalancePercent: number;
        ethUp: number;
        ethDown: number;
        ethBalancePercent: number;
    };
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
 * 删除仓位（同时删除内存和持久化存储）
 * 用于赎回后清除仓位
 */
export const deletePosition = (conditionId: string): void => {
    positions.delete(conditionId);
    deleteFromStorage(conditionId);
};

// 提前平仓收回的总金额（用于计入总收益）
let totalEarlySellReceived = 0;

/**
 * 记录卖出（减少仓位）
 * 用于极端不平衡时提前平仓
 */
export const recordSell = (
    conditionId: string,
    side: 'up' | 'down',
    shares: number,
    received: number
): void => {
    const pos = positions.get(conditionId);
    if (!pos) {
        Logger.warning(`[recordSell] 仓位不存在: ${conditionId}`);
        return;
    }
    
    if (side === 'up') {
        // 按比例减少成本
        const costRatio = pos.upShares > 0 ? shares / pos.upShares : 0;
        const costReduction = pos.upCost * costRatio;
        pos.upShares = Math.max(0, pos.upShares - shares);
        pos.upCost = Math.max(0, pos.upCost - costReduction);
    } else {
        const costRatio = pos.downShares > 0 ? shares / pos.downShares : 0;
        const costReduction = pos.downCost * costRatio;
        pos.downShares = Math.max(0, pos.downShares - shares);
        pos.downCost = Math.max(0, pos.downCost - costReduction);
    }
    
    pos.lastUpdate = Date.now();
    positions.set(conditionId, pos);
    
    // 累计提前平仓收回的金额
    totalEarlySellReceived += received;
    
    // 保存到持久化存储
    saveToStorage(pos);
    
    Logger.info(`📉 [卖出记录] ${side.toUpperCase()} ${shares.toFixed(2)} shares, 收回 $${received.toFixed(2)}`);
};

/**
 * 获取提前平仓收回的总金额
 */
export const getEarlySellReceived = (): number => {
    return totalEarlySellReceived;
};

/**
 * 重置提前平仓收回金额（新事件开始时）
 */
export const resetEarlySellReceived = (): void => {
    totalEarlySellReceived = 0;
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
export const getTimeGroup = (slug: string, title?: string): TimeGroup => {
    const combined = (slug + ' ' + (title || '')).toLowerCase();
    
    // 检查明确的 15min 标记
    if (combined.includes('15m') || combined.includes('15min') || combined.includes('15-min')) {
        return '15min';
    }
    
    // 检查 title 中的时间格式（如 5:45PM-6:00PM = 15分钟间隔）
    if (title) {
        const timeMatch = title.match(/(\d{1,2}):(\d{2}).*?-.*?(\d{1,2}):(\d{2})/);
        if (timeMatch) {
            const startHour = parseInt(timeMatch[1]);
            const startMin = parseInt(timeMatch[2]);
            const endHour = parseInt(timeMatch[3]);
            const endMin = parseInt(timeMatch[4]);
            const durationMin = (endHour * 60 + endMin) - (startHour * 60 + startMin);
            if (durationMin === 15 || durationMin === -45) {
                return '15min';
            }
        }
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
        if (getTimeGroup(pos.slug, pos.title) === timeGroup) {
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
 * 获取指定 timeGroup 的资产平均持仓价信息
 * 用于同池增持策略
 */
export interface AssetAvgPrice {
    asset: 'btc' | 'eth';
    upShares: number;
    downShares: number;
    upCost: number;
    downCost: number;
    upAvgPrice: number;    // 平均买入价
    downAvgPrice: number;  // 平均买入价
    imbalance: number;     // Up - Down，正数表示 Up 多
}

export const getAssetAvgPrices = (timeGroup: TimeGroup): {
    btc: AssetAvgPrice | null;
    eth: AssetAvgPrice | null;
} => {
    const btcStats = { upShares: 0, downShares: 0, upCost: 0, downCost: 0 };
    const ethStats = { upShares: 0, downShares: 0, upCost: 0, downCost: 0 };
    
    const now = Date.now();
    
    for (const pos of positions.values()) {
        // 🔧 修复：只用 slug 判断资产类型（title 可能同时包含 BTC 和 ETH）
        const slugLower = pos.slug.toLowerCase();
        const titleLower = pos.title.toLowerCase();
        const combined = slugLower + ' ' + titleLower;
        
        // 🔧 关键修复：检查事件是否已过期（slug 中的时间戳）
        // slug 格式：eth-updown-15m-1765622700，最后的数字是结束时间戳（秒）
        const timestampMatch = slugLower.match(/(\d{10})$/);
        if (timestampMatch) {
            const endTimestamp = parseInt(timestampMatch[1]) * 1000;  // 转换为毫秒
            // 如果事件已经结束超过 2 分钟，跳过（等待结算清理）
            if (endTimestamp < now - 2 * 60 * 1000) {
                continue;  // 跳过已过期的事件
            }
        }
        
        // 判断是否属于指定 timeGroup
        // 15min 事件通常在 title 中有 "5:45PM-6:00PM" 等 15 分钟间隔
        // 或 slug/title 中有 '15m', '15min', '15-min'
        const has15minMarker = combined.includes('15m') || combined.includes('15min') || combined.includes('15-min');
        // 如果没有明确标记，检查 title 中的时间格式（如 5:45-6:00 = 15分钟间隔）
        const timeMatch = pos.title.match(/(\d{1,2}):(\d{2}).*?-.*?(\d{1,2}):(\d{2})/);
        let is15minByTime = false;
        if (timeMatch) {
            const startHour = parseInt(timeMatch[1]);
            const startMin = parseInt(timeMatch[2]);
            const endHour = parseInt(timeMatch[3]);
            const endMin = parseInt(timeMatch[4]);
            const durationMin = (endHour * 60 + endMin) - (startHour * 60 + startMin);
            is15minByTime = durationMin === 15 || durationMin === -45; // 处理跨小时
        }
        
        const is15min = has15minMarker || is15minByTime;
        const posTimeGroup: TimeGroup = is15min ? '15min' : '1hr';
        if (posTimeGroup !== timeGroup) continue;
        
        // 🔧 修复：只用 slug 判断 BTC/ETH（不用 title，避免跨池 title 同时含 BTC+ETH）
        const isBtc = slugLower.includes('btc') || slugLower.includes('bitcoin');
        const isEth = slugLower.includes('eth') || slugLower.includes('ethereum');
        
        if (isBtc) {
            btcStats.upShares += pos.upShares;
            btcStats.downShares += pos.downShares;
            btcStats.upCost += pos.upCost;
            btcStats.downCost += pos.downCost;
        } else if (isEth) {
            ethStats.upShares += pos.upShares;
            ethStats.downShares += pos.downShares;
            ethStats.upCost += pos.upCost;
            ethStats.downCost += pos.downCost;
        }
    }
    
    const buildResult = (stats: typeof btcStats, asset: 'btc' | 'eth'): AssetAvgPrice | null => {
        if (stats.upShares === 0 && stats.downShares === 0) return null;
        
        return {
            asset,
            upShares: stats.upShares,
            downShares: stats.downShares,
            upCost: stats.upCost,
            downCost: stats.downCost,
            upAvgPrice: stats.upShares > 0 ? stats.upCost / stats.upShares : 0,
            downAvgPrice: stats.downShares > 0 ? stats.downCost / stats.downShares : 0,
            imbalance: stats.upShares - stats.downShares,
        };
    };
    
    return {
        btc: buildResult(btcStats, 'btc'),
        eth: buildResult(ethStats, 'eth'),
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
            
            const upIndex = outcomeNames.indexOf('up');
            const downIndex = outcomeNames.indexOf('down');
            
            // 方法1: 检查 closed/resolved 状态 + 价格
            const isClosed = market.closed === true || market.resolved === true;
            
            // 方法2: 检查 winningOutcome 字段
            if (market.winningOutcome) {
                const winner = market.winningOutcome.toLowerCase();
                if (winner === 'up' || winner === 'down') {
                    Logger.info(`📊 ${slug.slice(0, 25)} → ${winner.toUpperCase()} 获胜 (winningOutcome)`);
                    return winner as 'up' | 'down';
                }
            }
            
            // 方法3: 检查 outcomePrices（价格为 1 或 0 表示已结算）
            let outcomePrices = market.outcomePrices;
            if (typeof outcomePrices === 'string') {
                try { outcomePrices = JSON.parse(outcomePrices); } catch { continue; }
            }
            
            if (outcomePrices && Array.isArray(outcomePrices) && outcomePrices.length >= 2) {
                const upPrice = parseFloat(outcomePrices[upIndex]) || 0;
                const downPrice = parseFloat(outcomePrices[downIndex]) || 0;
                
                // 如果价格是 1 或 0，说明已结算
                if (upPrice >= 0.99) {
                    Logger.info(`📊 ${slug.slice(0, 25)} → UP 获胜 (价格: ${upPrice.toFixed(2)})`);
                    return 'up';
                } else if (downPrice >= 0.99) {
                    Logger.info(`📊 ${slug.slice(0, 25)} → DOWN 获胜 (价格: ${downPrice.toFixed(2)})`);
                    return 'down';
                }
                
                // 如果市场已关闭但价格还没更新到 1/0，用接近的价格判断
                if (isClosed && (upPrice > 0.9 || downPrice > 0.9)) {
                    const winner = upPrice > downPrice ? 'up' : 'down';
                    Logger.info(`📊 ${slug.slice(0, 25)} → ${winner.toUpperCase()} 获胜 (closed + 价格推断)`);
                    return winner;
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
 * @param pos 仓位信息
 * @param outcome 结算结果
 * @param balanceSnapshot 可选的仓位平衡度快照（后台结算时使用）
 */
export const settlePosition = (
    pos: Position, 
    outcome: 'up' | 'down',
    balanceSnapshot?: BalanceSnapshot
): SettlementResult => {
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
    
    // 获取仓位平衡度（优先使用快照，否则获取当前仓位）
    let btcUp: number, btcDown: number, btcBalancePercent: number;
    let ethUp: number, ethDown: number, ethBalancePercent: number;
    
    if (balanceSnapshot) {
        // 使用传入的快照
        btcUp = balanceSnapshot.btcUp;
        btcDown = balanceSnapshot.btcDown;
        btcBalancePercent = balanceSnapshot.btcBalancePercent;
        ethUp = balanceSnapshot.ethUp;
        ethDown = balanceSnapshot.ethDown;
        ethBalancePercent = balanceSnapshot.ethBalancePercent;
    } else {
        // 获取当前仓位
        const timeGroup = getTimeGroup(pos.slug, pos.title);
        const avgPrices = getAssetAvgPrices(timeGroup);
        
        btcUp = avgPrices.btc?.upShares || 0;
        btcDown = avgPrices.btc?.downShares || 0;
        ethUp = avgPrices.eth?.upShares || 0;
        ethDown = avgPrices.eth?.downShares || 0;
        
        btcBalancePercent = (btcUp > 0 || btcDown > 0) 
            ? Math.min(btcUp, btcDown) / Math.max(btcUp, btcDown) * 100 
            : 0;
        ethBalancePercent = (ethUp > 0 || ethDown > 0) 
            ? Math.min(ethUp, ethDown) / Math.max(ethUp, ethDown) * 100 
            : 0;
    }
    
    const result: SettlementResult = {
        position: { ...pos },
        outcome,
        payout,
        totalCost,
        profit,
        profitPercent,
        balanceInfo: {
            btcUp,
            btcDown,
            btcBalancePercent,
            ethUp,
            ethDown,
            ethBalancePercent,
        },
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
        if (getTimeGroup(pos.slug, pos.title) === timeGroup) {
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

// 仓位平衡度快照
interface BalanceSnapshot {
    btcUp: number;
    btcDown: number;
    btcBalancePercent: number;
    ethUp: number;
    ethDown: number;
    ethBalancePercent: number;
}

// 待结算队列（后台异步处理，不阻塞新事件）
interface PendingSettlement {
    conditionId: string;
    pos: Position;
    timeGroup: TimeGroup;
    addedAt: number;
    balanceSnapshot: BalanceSnapshot;  // 加入队列时的仓位快照
}
const pendingSettlements: PendingSettlement[] = [];
let settlementTaskRunning = false;

/**
 * 后台结算任务：并行处理所有待结算仓位
 */
const runSettlementTask = async (): Promise<void> => {
    if (settlementTaskRunning) return;
    settlementTaskRunning = true;
    
    const modeTag = CONFIG.SIMULATION_MODE ? '[模拟]' : '[实盘]';
    const RETRY_DELAY_MS = 3000;  // 每 3 秒重试一次
    
    while (pendingSettlements.length > 0) {
        // 并行尝试获取所有待结算仓位的结果
        const settledIndices: number[] = [];
        
        await Promise.all(pendingSettlements.map(async (item, index) => {
            const { pos, balanceSnapshot } = item;
            
            // 尝试获取真实结果
            const realOutcome = await fetchRealOutcome(pos.slug);
            
            if (realOutcome) {
                // 获取到结果，结算（传入仓位快照）
                Logger.info(`${modeTag} 📊 ${pos.slug.slice(0, 25)} → ${realOutcome.toUpperCase()} 获胜`);
                settlePosition(pos, realOutcome, balanceSnapshot);
                settledIndices.push(index);
            } else {
                // 打印等待日志（每 15 秒一次）
                const waitingTime = Math.floor((Date.now() - item.addedAt) / 1000);
                if (waitingTime % 15 === 0) {
                    Logger.info(`   ⏳ [后台] ${pos.slug.slice(0, 25)} - 等待结算结果 (已等待 ${waitingTime}s)...`);
                }
            }
        }));
        
        // 从后往前删除已结算的项（避免索引错位）
        settledIndices.sort((a, b) => b - a);
        for (const index of settledIndices) {
            pendingSettlements.splice(index, 1);
        }
        
        // 如果还有未结算的，等待后继续
        if (pendingSettlements.length > 0) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }
    
    settlementTaskRunning = false;
};

/**
 * 强制结算指定 timeGroup 的所有仓位（事件切换时使用）
 * 
 * 策略：
 * 1. 立即从活跃仓位中移除（不影响新事件）
 * 2. 加入后台结算队列，持续重试直到获取结果
 * 3. 获取结果后结算并发送通知
 */
export const forceSettleByTimeGroup = async (timeGroup: TimeGroup): Promise<SettlementResult[]> => {
    // 收集需要结算的仓位
    const positionsToSettle: Array<{conditionId: string, pos: Position}> = [];
    
    for (const [conditionId, pos] of positions.entries()) {
        const posTimeGroup = getTimeGroup(pos.slug, pos.title);
        
        if (posTimeGroup !== timeGroup) continue;
        positionsToSettle.push({ conditionId, pos: { ...pos } });  // 复制一份
    }
    
    if (positionsToSettle.length === 0) return [];
    
    Logger.info(`🔄 [${timeGroup}] 检测到 ${positionsToSettle.length} 个仓位需要结算`);
    
    // ⚠️ 在删除仓位之前，先获取仓位平衡度快照
    const avgPrices = getAssetAvgPrices(timeGroup);
    const btcUp = avgPrices.btc?.upShares || 0;
    const btcDown = avgPrices.btc?.downShares || 0;
    const ethUp = avgPrices.eth?.upShares || 0;
    const ethDown = avgPrices.eth?.downShares || 0;
    
    const balanceSnapshot: BalanceSnapshot = {
        btcUp,
        btcDown,
        btcBalancePercent: (btcUp > 0 || btcDown > 0) 
            ? Math.min(btcUp, btcDown) / Math.max(btcUp, btcDown) * 100 
            : 0,
        ethUp,
        ethDown,
        ethBalancePercent: (ethUp > 0 || ethDown > 0) 
            ? Math.min(ethUp, ethDown) / Math.max(ethUp, ethDown) * 100 
            : 0,
    };
    
    Logger.info(`   📊 仓位快照: BTC(Up=${btcUp.toFixed(0)} Down=${btcDown.toFixed(0)}) ETH(Up=${ethUp.toFixed(0)} Down=${ethDown.toFixed(0)})`);
    
    // 立即从活跃仓位中移除（不影响新事件）
    for (const { conditionId } of positionsToSettle) {
        positions.delete(conditionId);
        deleteFromStorage(conditionId);
    }
    
    // 加入后台结算队列（带仓位快照）
    const now = Date.now();
    for (const { conditionId, pos } of positionsToSettle) {
        pendingSettlements.push({
            conditionId,
            pos,
            timeGroup,
            addedAt: now,
            balanceSnapshot,  // 保存仓位快照
        });
    }
    
    Logger.info(`   📋 已加入后台结算队列，新事件可正常开始`);
    
    // 启动后台结算任务（不等待完成）
    runSettlementTask().catch(err => {
        Logger.error(`后台结算任务出错: ${err}`);
    });
    
    // 立即返回，不阻塞主流程
    return [];
};

/**
 * 从 Polymarket API 同步真实仓位
 * 每次订单成交后调用，确保仓位数据准确
 * 
 * ⚠️ 仅在实盘模式下有效，模拟模式下跳过
 */
export const syncPositionsFromAPI = async (): Promise<void> => {
    // 模拟模式下不同步（本地仓位是虚拟的，API 返回的是真实仓位）
    if (CONFIG.SIMULATION_MODE) {
        return;
    }
    
    Logger.info(`🔄 开始同步仓位...`);
    
    try {
        const apiPositions = await getUserPositions(0);  // 获取所有仓位
        
        Logger.info(`🔄 API返回 ${apiPositions?.length || 0} 个仓位`);
        
        if (!apiPositions || apiPositions.length === 0) {
            return;
        }
        
        // 🔍 调试：打印第一个仓位的所有字段
        if (apiPositions.length > 0) {
            const sample = apiPositions[0] as any;
            Logger.info(`🔍 API仓位字段: ${Object.keys(sample).join(', ')}`);
            Logger.info(`🔍 示例: market="${sample.market}" slug="${sample.slug}" title="${sample.title?.slice(0,30)}"`);
        }
        
        // 按 conditionId 分组 API 仓位
        const positionsByConditionId = new Map<string, UserPosition[]>();
        for (const pos of apiPositions) {
            const condId = pos.conditionId || '';
            if (!condId) continue;
            const existing = positionsByConditionId.get(condId) || [];
            existing.push(pos);
            positionsByConditionId.set(condId, existing);
        }
        
        // 打印调试信息
        const localCondIds = Array.from(positions.values()).map(p => p.conditionId?.slice(0, 12));
        const apiCondIds = Array.from(positionsByConditionId.keys()).slice(0, 5).map(id => id?.slice(0, 12));
        Logger.info(`🔄 本地condId: ${localCondIds.join(', ')}`);
        Logger.info(`🔄 API condId: ${apiCondIds.join(', ')}${positionsByConditionId.size > 5 ? '...' : ''}`);
        
        // 🔄 改进：遍历 API 返回的仓位，而不是本地仓位
        // 这样可以创建本地不存在的仓位
        let synced = 0;
        let created = 0;
        
        for (const [conditionId, apiPosGroup] of positionsByConditionId.entries()) {
            const firstPos = apiPosGroup[0] as any;
            // 兼容多种字段名
            const slug = firstPos?.market || firstPos?.slug || firstPos?.proxyTicker || '';
            const title = firstPos?.title || firstPos?.eventTitle || firstPos?.question || '';
            
            // 🔧 修复：主要依赖 title 字段过滤（API 的 market 字段可能为空）
            const titleLower = title.toLowerCase();
            const slugLower = slug.toLowerCase();
            const combined = titleLower + ' ' + slugLower;
            
            const hasBtcOrEth = combined.includes('btc') || combined.includes('bitcoin') || 
                                combined.includes('eth') || combined.includes('ethereum');
            const hasUpDown = combined.includes('up') || combined.includes('down');
            const isRelevant = hasBtcOrEth && hasUpDown;
            
            if (!isRelevant) {
                // 只打印有意义的跳过
                if (apiPosGroup.some(p => (p.size || 0) > 5)) {
                    Logger.info(`   ⏭️ 跳过: "${title.slice(0, 35)}" size=${apiPosGroup.map(p => p.size?.toFixed(1)).join('/')}`);
                }
                continue;
            }
            
            // 🔧 关键修复：跳过已过期的事件，避免重新创建已赎回的仓位
            // slug 格式：eth-updown-15m-1765622700，最后的数字是结束时间戳（秒）
            const timestampMatch = slugLower.match(/(\d{10})$/);
            if (timestampMatch) {
                const endTimestamp = parseInt(timestampMatch[1]) * 1000;  // 转换为毫秒
                const now = Date.now();
                // 如果事件已经结束超过 2 分钟，跳过（已赎回，API 返回有延迟）
                if (endTimestamp < now - 2 * 60 * 1000) {
                    continue;
                }
            }
            
            // 从 API 数据提取 Up/Down shares 和 avgPrice
            let apiUpShares = 0;
            let apiDownShares = 0;
            let apiUpAvgPrice = 0;
            let apiDownAvgPrice = 0;
            
            for (const apiPos of apiPosGroup) {
                const outcomeUpper = (apiPos.outcome || '').toUpperCase();
                const isUp = outcomeUpper === 'YES' || outcomeUpper === 'UP';
                const isDown = outcomeUpper === 'NO' || outcomeUpper === 'DOWN';
                
                if (isUp) {
                    apiUpShares = apiPos.size || 0;
                    apiUpAvgPrice = apiPos.avgPrice || 0;
                } else if (isDown) {
                    apiDownShares = apiPos.size || 0;
                    apiDownAvgPrice = apiPos.avgPrice || 0;
                }
            }
            
            // 跳过空仓位
            if (apiUpShares < 0.1 && apiDownShares < 0.1) continue;
            
            // 查找本地仓位
            let localPos = positions.get(conditionId);
            
            if (!localPos) {
                // 本地不存在，创建新仓位
                // 如果 slug 为空，用 title 生成一个简化的 slug
                const effectiveSlug = slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
                localPos = {
                    conditionId,
                    slug: effectiveSlug,
                    title,
                    upShares: apiUpShares,
                    downShares: apiDownShares,
                    upCost: apiUpShares * apiUpAvgPrice,
                    downCost: apiDownShares * apiDownAvgPrice,
                    lastUpdate: Date.now(),
                    endDate: '',  // API 没有返回 endDate，后续会通过市场数据补充
                };
                positions.set(conditionId, localPos);
                saveToStorage(localPos);
                created++;
                // 显示 title 更直观
                const displayName = title.slice(0, 35) || effectiveSlug.slice(0, 30);
                Logger.success(`🔄 创建仓位 ${displayName}: Up=${apiUpShares.toFixed(1)}@$${apiUpAvgPrice.toFixed(3)} Down=${apiDownShares.toFixed(1)}@$${apiDownAvgPrice.toFixed(3)}`);
            } else {
                // 本地存在，检查是否需要校正
                const upDiff = Math.abs(localPos.upShares - apiUpShares);
                const downDiff = Math.abs(localPos.downShares - apiDownShares);
                
                if (upDiff > 0.5 || downDiff > 0.5) {
                    Logger.warning(`🔄 仓位校正 ${localPos.slug.slice(0, 25)}: Up ${localPos.upShares.toFixed(1)}→${apiUpShares.toFixed(1)} Down ${localPos.downShares.toFixed(1)}→${apiDownShares.toFixed(1)}`);
                    
                    localPos.upShares = apiUpShares;
                    localPos.downShares = apiDownShares;
                    localPos.upCost = apiUpShares * apiUpAvgPrice;
                    localPos.downCost = apiDownShares * apiDownAvgPrice;
                    localPos.lastUpdate = Date.now();
                    
                    saveToStorage(localPos);
                    synced++;
                }
            }
        }
        
        // 🗑️ 删除 API 中不存在的本地仓位（已赎回/结算的仓位）
        let deleted = 0;
        const localConditionIds = Array.from(positions.keys());
        for (const localCondId of localConditionIds) {
            // 检查这个 conditionId 是否在 API 返回的仓位中
            if (!positionsByConditionId.has(localCondId)) {
                const localPos = positions.get(localCondId);
                if (localPos) {
                    Logger.warning(`🗑️ 删除已结算仓位: ${localPos.slug.slice(0, 30)}`);
                    positions.delete(localCondId);
                    deleteFromStorage(localCondId);
                    deleted++;
                }
            }
        }
        
        // 始终显示同步结果
        Logger.info(`🔄 API同步完成: 扫描 ${positionsByConditionId.size} 个, 创建 ${created} 个, 校正 ${synced} 个, 删除 ${deleted} 个仓位`);
        
        // 显示当前本地仓位状态
        const localCount = positions.size;
        if (localCount > 0) {
            for (const pos of positions.values()) {
                if (pos.upShares > 0.1 || pos.downShares > 0.1) {
                    Logger.info(`   📦 ${pos.slug.slice(0, 25)}: Up=${pos.upShares.toFixed(1)} Down=${pos.downShares.toFixed(1)}`);
                }
            }
        } else {
            Logger.warning(`   ⚠️ 本地仓位为空`);
        }
    } catch (error: any) {
        Logger.error(`❌ API 同步失败: ${error.message || error}`);
    }
};

export default {
    loadPositionsFromStorage,
    getPosition,
    updatePosition,
    deletePosition,
    recordSell,
    getEarlySellReceived,
    resetEarlySellReceived,
    getImbalance,
    getAllPositions,
    getPositionStats,
    getAssetAvgPrices,
    cleanExpiredPositions,
    checkAndSettleExpired,
    settlePosition,
    onSettlement,
    getOverallStats,
    forceSettleByTimeGroup,
    syncPositionsFromAPI,
};



