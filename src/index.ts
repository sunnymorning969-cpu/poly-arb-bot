/**
 * Polymarket 套利机器人 - 主入口
 * 
 * 功能：
 * 1. 持续扫描 BTC/ETH Up/Down 市场
 * 2. 发现套利机会时自动执行
 * 3. 同时买入 Up 和 Down 锁定利润
 */

import CONFIG from './config';
import Logger from './logger';
import { scanArbitrageOpportunities, ArbitrageOpportunity, initWebSocket, getWebSocketStatus, checkEventSwitch, generateHedgeOpportunities, generateSamePoolOpportunities, getMarketEndTime, checkEmergencyBalance, calculateBalancePercent } from './scanner';
import { getAssetAvgPrices } from './positions';
import { initClient, getBalance, getUSDCBalance, ensureApprovals, executeArbitrage, isDuplicateOpportunity } from './executor';
import { notifyBotStarted, notifySingleSettlement, notifyRunningStats } from './telegram';
import { getPositionStats, checkAndSettleExpired, onSettlement, getOverallStats, SettlementResult, loadPositionsFromStorage, getAllPositions, syncPositionsFromAPI } from './positions';
import { initStorage, closeStorage, getStorageStatus, clearStorage } from './storage';
import { checkAndRedeem } from './redeemer';
import { checkStopLossSignals, executeStopLoss, getStopLossStatus, printEventSummary, shouldPauseTrading, checkBinanceVolatility, getTriggeredSignal, recordArbitrageOpportunity, checkExtremeImbalance, executeExtremeImbalanceSell, setEmergencyMode, isInEmergencyMode } from './stopLoss';
import { executeSell } from './executor';
import { getGlobalHedgeStats } from './hedging';
import { initBinanceWs, isBinanceWsConnected } from './binance';

// 统计数据
interface Stats {
    startTime: Date;
    scans: number;
    opportunitiesFound: number;
    tradesExecuted: number;
    tradesSuccessful: number;
    totalProfit: number;
    totalCost: number;
}

const stats: Stats = {
    startTime: new Date(),
    scans: 0,
    opportunitiesFound: 0,
    tradesExecuted: 0,
    tradesSuccessful: 0,
    totalProfit: 0,
    totalCost: 0,
};

/**
 * 打印启动信息
 */
const printBanner = () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║                                                           ║');
    console.log('║      🤖 Polymarket 套利机器人 v3.0                        ║');
    console.log('║                                                           ║');
    console.log('║      ⚡ WebSocket 实时订单簿 - 毫秒级响应                  ║');
    console.log('║      📊 并行下单 + 单边阈值 + 智能仓位                    ║');
    console.log('║                                                           ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
};

/**
 * 打印配置信息
 */
const printConfig = () => {
    const storageStatus = getStorageStatus();
    const stopLossStatus = getStopLossStatus();
    
    Logger.info('📋 当前配置:');
    Logger.info(`   钱包: ${CONFIG.PROXY_WALLET.slice(0, 10)}...${CONFIG.PROXY_WALLET.slice(-8)}`);
    Logger.info(`   模式: ${CONFIG.SIMULATION_MODE ? '🔵 模拟' : '🔴 实盘'}`);
    Logger.divider();
    Logger.info('⚙️ 交易参数:');
    Logger.info(`   最小利润率: ${CONFIG.MIN_ARBITRAGE_PERCENT}%`);
    Logger.info(`   最小利润额: $${CONFIG.MIN_PROFIT_USD}`);
    Logger.info(`   最大订单: $${CONFIG.MAX_ORDER_SIZE_USD}`);
    Logger.info(`   深度使用: ${CONFIG.DEPTH_USAGE_PERCENT}%`);
    Logger.info(`   敞口限制: ${CONFIG.MAX_ARBITRAGE_PERCENT_INITIAL}% → ${CONFIG.MAX_ARBITRAGE_PERCENT_FINAL}%（${CONFIG.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES}分钟内收紧）`);
    Logger.divider();
    Logger.info('⏱️ 频率控制:');
    Logger.info(`   扫描间隔: ${CONFIG.SCAN_INTERVAL_MS}ms`);
    Logger.info(`   交易冷却: ${CONFIG.TRADE_COOLDOWN_MS}ms`);
    Logger.info(`   并行上限: ${CONFIG.MAX_PARALLEL_TRADES}`);
    Logger.divider();
    Logger.info('🚨 止损配置:');
    Logger.info(`   止损开关: ${stopLossStatus.enabled ? '✅ 开启' : '❌ 关闭'}`);
    Logger.info(`   止损模式: ${CONFIG.STOP_LOSS_MODE === 'sell' ? '📉 平仓' : '🛡️ 对冲'}`);
    if (stopLossStatus.enabled) {
        Logger.info(`   监控窗口: 结束前 ${stopLossStatus.windowSec} 秒`);
        Logger.info(`   组合阈值: $${stopLossStatus.costThreshold.toFixed(2)}`);
        Logger.info(`   风险比例: ≥${(stopLossStatus.riskRatio * 100).toFixed(0)}%`);
        Logger.info(`   最小次数: ≥${stopLossStatus.minTriggerCount} 次`);
    }
    Logger.divider();
    Logger.info('📡 币安风控:');
    if (CONFIG.BINANCE_VOLATILITY_CHECK_ENABLED) {
        Logger.info(`   状态: ✅ 启用`);
        Logger.info(`   检查窗口: 结束前 ${CONFIG.BINANCE_CHECK_WINDOW_SEC} 秒`);
        Logger.info(`   波动阈值: ±${CONFIG.BINANCE_MIN_VOLATILITY_PERCENT}%`);
    } else {
        Logger.info(`   状态: ❌ 未启用`);
    }
    Logger.divider();
    Logger.info('🔄 同池增持:');
    if (CONFIG.SAME_POOL_REBALANCE_ENABLED) {
        Logger.info(`   状态: ✅ 启用`);
        Logger.info(`   策略: 利用平均持仓价在同池内套利，逐步平衡仓位`);
    } else {
        Logger.info(`   状态: ❌ 未启用`);
    }
    Logger.divider();
    Logger.info('💾 数据存储:');
    Logger.info(`   位置: ${storageStatus.positionsCount} 仓位 | ${storageStatus.historyCount} 历史`);
    Logger.divider();
};

/**
 * 打印统计信息
 */
const printStats = () => {
    const runtime = Math.floor((Date.now() - stats.startTime.getTime()) / 1000 / 60);
    const overallStats = getOverallStats();
    
    Logger.info('📊 运行统计:');
    Logger.info(`   运行时间: ${runtime} 分钟`);
    Logger.info(`   扫描次数: ${stats.scans}`);
    Logger.info(`   发现机会: ${stats.opportunitiesFound}`);
    Logger.info(`   执行交易: ${stats.tradesExecuted}`);
    Logger.info(`   成功交易: ${stats.tradesSuccessful}`);
    Logger.divider();
    Logger.info('💰 结算统计:');
    Logger.info(`   已结算事件: ${overallStats.totalSettled}`);
    Logger.info(`   盈利/亏损: ${overallStats.winCount}/${overallStats.lossCount}`);
    Logger.info(`   胜率: ${overallStats.winRate.toFixed(1)}%`);
    Logger.arbitrage(`总盈亏: $${overallStats.totalProfit.toFixed(2)}`);
};

/**
 * 计算动态敞口限制（开盘宽松，逐渐收紧）
 * 
 * 逻辑：
 * - 开盘时敞口宽松（初始值大，如30%，允许组合成本>$0.70）
 * - 随时间推移逐渐收紧（最终值小，如15%，要求组合成本>$0.85）
 * - 在指定时间内线性过渡
 * 
 * @param endDate 事件结束时间
 * @param eventDurationMin 事件总时长（分钟），15分钟场=15，1小时场=60
 */
const getDynamicMaxArbitragePercent = (endDate: string, eventDurationMin: number = 15): number => {
    const now = Date.now();
    const endTime = new Date(endDate).getTime();
    const startTime = endTime - eventDurationMin * 60 * 1000;
    
    // 计算事件已过去的分钟数
    const elapsedMs = now - startTime;
    const elapsedMinutes = Math.max(0, elapsedMs / 60000);  // 精确到小数
    
    // 计算收紧进度（0~1）
    const tightenProgress = Math.min(elapsedMinutes / CONFIG.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES, 1);
    
    // 线性插值：从初始值收紧到最终值
    const initial = CONFIG.MAX_ARBITRAGE_PERCENT_INITIAL;
    const final = CONFIG.MAX_ARBITRAGE_PERCENT_FINAL;
    const currentPercent = initial - (initial - final) * tightenProgress;
    
    return currentPercent;
};

/**
 * 选择套利机会（事件级策略）
 * 
 * 增强版：scanner 已经做了机会判断，这里做最终验证和冷却检查
 */
const selectOpportunities = (
    opportunities: ArbitrageOpportunity[]
): ArbitrageOpportunity[] => {
    if (opportunities.length === 0) {
        return [];
    }
    
    const selected: ArbitrageOpportunity[] = [];
    
    for (const opp of opportunities) {
        // 如果是对冲交易，直接执行，不受并行数量限制
        if (opp.isHedge) {
            selected.push(opp);
            continue;
        }
        
        // 普通交易受并行数量限制
        if (selected.length >= CONFIG.MAX_PARALLEL_TRADES) break;
        
        // ============ 止损/对冲检查（最高优先级）============
        const pauseCheck = shouldPauseTrading(opp.timeGroup);
        
        if (pauseCheck.pause) {
            continue;  // 对冲已完成，静默等待
        }
        
        if (pauseCheck.shouldHedge) {
            continue;  // 对冲模式，跳过常规套利
        }
        
        // ============ 以下检查仅适用于常规套利 ============
        // 1. 价格有效性检查（根据交易类型检查相应的价格）
        if (opp.tradingAction === 'buy_both') {
            if (opp.upAskPrice < 0.01 || opp.downAskPrice < 0.01) {
                continue;
            }
        } else if (opp.tradingAction === 'buy_up_only') {
            if (opp.upAskPrice < 0.01) {
                continue;
            }
        } else if (opp.tradingAction === 'buy_down_only') {
            if (opp.downAskPrice < 0.01) {
                continue;
            }
        }
        
        // 2. 深度检查（根据交易类型检查相应的深度）
        if (opp.tradingAction === 'buy_both') {
            if (opp.upAskSize < 1 || opp.downAskSize < 1) {
                continue;
            }
        } else if (opp.tradingAction === 'buy_up_only') {
            if (opp.upAskSize < 1) {
                continue;
            }
        } else if (opp.tradingAction === 'buy_down_only') {
            if (opp.downAskSize < 1) {
                continue;
            }
        }
        
        // 3. buy_both 必须满足合计 < $1.00
        if (opp.tradingAction === 'buy_both' && opp.combinedCost >= 0.995) {
            continue;  // 合计 >= $0.995 不是真正套利
        }
        
        // 4. 套利敞口不能太大（市场分歧大时风险高）
        // 动态计算：开盘时敞口限制较紧，随时间逐渐放宽
        const eventDuration = opp.timeGroup === '15min' ? 15 : 60;
        const currentMaxArbitragePercent = getDynamicMaxArbitragePercent(opp.endDate, eventDuration);
        const minCombinedCost = 1 - (currentMaxArbitragePercent / 100);
        if (opp.tradingAction === 'buy_both' && opp.combinedCost < minCombinedCost) {
            // 显示时间场和市场组合信息
            const isBtcUp = opp.upMarketSlug?.includes('btc') || opp.upMarketSlug?.includes('bitcoin');
            const isBtcDown = opp.downMarketSlug?.includes('btc') || opp.downMarketSlug?.includes('bitcoin');
            const upSource = isBtcUp ? 'BTC' : 'ETH';
            const downSource = isBtcDown ? 'BTC' : 'ETH';
            const pairInfo = opp.isCrossPool ? `${upSource}↑${downSource}↓` : `${upSource}`;
            Logger.warning(`⚠️ ${opp.timeGroup} ${pairInfo} 敞口过大: 组合$${opp.combinedCost.toFixed(2)} (Up$${opp.upAskPrice.toFixed(2)}+Down$${opp.downAskPrice.toFixed(2)}) < $${minCombinedCost.toFixed(2)}，跳过`);
            // 记录到风险统计（跳过的也算套利机会）
            if (opp.timeGroup) {
                recordArbitrageOpportunity(opp.timeGroup, opp.combinedCost, opp.endDate);
            }
            continue;
        }
        
        // 5. 冷却检查（同池增持完全跳过冷却，以最快速度平衡仓位）
        if (!opp.isSamePoolRebalance) {
            if (isDuplicateOpportunity(opp.conditionId, opp.upAskPrice, opp.downAskPrice)) {
                continue;
            }
            if (opp.isCrossPool && opp.downConditionId && isDuplicateOpportunity(opp.downConditionId, opp.upAskPrice, opp.downAskPrice)) {
                continue;
            }
        }
        
        selected.push(opp);
        
        // 记录到风险统计（选中执行的套利机会）
        if (opp.timeGroup) {
            recordArbitrageOpportunity(opp.timeGroup, opp.combinedCost, opp.endDate);
        }
        
        // 显示选中的机会（带跨池子和策略信息）
        const actionEmoji = opp.tradingAction === 'buy_both' ? '⚖️' : 
                           opp.tradingAction === 'buy_up_only' ? '📈' : '📉';
        const poolTag = opp.isCrossPool ? '🔀' : (opp.isSamePoolRebalance ? '🔄' : '');
        const groupInfo = opp.groupAnalysis?.hasPosition ? 
            `组:U${opp.groupAnalysis.imbalance > 0 ? '+' : ''}${opp.groupAnalysis.imbalance.toFixed(0)}` : '新仓';
        
        // 显示 Up 和 Down 来源（兼容 btc/bitcoin 和 eth/ethereum）
        const isBtcUp = opp.upMarketSlug?.includes('btc') || opp.upMarketSlug?.includes('bitcoin');
        const isBtcDown = opp.downMarketSlug?.includes('btc') || opp.downMarketSlug?.includes('bitcoin');
        const upSource = isBtcUp ? 'BTC' : 'ETH';
        const downSource = isBtcDown ? 'BTC' : 'ETH';
        
        // 同池增持显示不同的格式
        if (opp.isSamePoolRebalance) {
            const asset = opp.rebalanceAsset?.toUpperCase() || upSource;
            const side = opp.rebalanceSide === 'up' ? '↑' : '↓';
            Logger.success(`${actionEmoji}${poolTag} ${opp.timeGroup} ${asset}${side}同池增持 | 组合:$${opp.combinedCost.toFixed(3)} | ${groupInfo} | ${opp.tradingAction}`);
        } else {
            const pairInfo = opp.isCrossPool ? `${upSource}↑${downSource}↓` : `${upSource}`;
            // 始终显示时间场 + 组合信息
            Logger.success(`${actionEmoji}${poolTag} ${opp.timeGroup} ${pairInfo} | Up:$${opp.upAskPrice.toFixed(2)} Down:$${opp.downAskPrice.toFixed(2)} | 合计:$${opp.combinedCost.toFixed(3)} | ${groupInfo} | ${opp.tradingAction}`);
        }
    }
    
    return selected;
};

/**
 * 主循环
 */
const mainLoop = async () => {
    printBanner();
    
    // 检查启动参数或配置项
    const args = process.argv.slice(2);
    const shouldReset = args.includes('--reset') || args.includes('-r') || CONFIG.CLEAR_DATA_ON_START;
    
    // 初始化数据存储
    try {
        await initStorage();
        
        // 如果配置了清除数据或有 --reset 参数，清除历史数据
        if (shouldReset) {
            clearStorage();
            Logger.success('🧹 已清除历史数据，从零开始');
        } else {
            loadPositionsFromStorage();  // 加载之前的仓位
            // 启动时从 API 同步真实仓位
            Logger.info('🔄 从 API 同步仓位...');
            await syncPositionsFromAPI();
        }
    } catch (error) {
        Logger.error(`存储初始化失败: ${error}`);
        return;
    }
    
    // 初始化交易客户端
    try {
        await initClient();
    } catch (error) {
        Logger.error(`交易客户端初始化失败: ${error}`);
        return;
    }
    
    // 检查并执行 USDC 授权
    try {
        await ensureApprovals();
    } catch (error) {
        Logger.warning(`授权检查失败: ${error}`);
        // 不中断启动，可能只是 RPC 问题
    }
    
    // 初始化 WebSocket 订单簿
    try {
        await initWebSocket();
    } catch (error) {
        Logger.error(`WebSocket 初始化失败: ${error}`);
        return;
    }
    
    // 初始化币安 WebSocket（用于波动率监控）
    initBinanceWs();
    
    // 获取初始余额
    const clobBalance = await getBalance();
    const usdcBalance = await getUSDCBalance();
    Logger.success(`💰 CLOB 余额: $${clobBalance.toFixed(2)} | 钱包 USDC.e: $${usdcBalance.toFixed(2)}`);
    Logger.divider();
    
    printConfig();
    
    Logger.success('🚀 机器人启动！等待 WebSocket 数据...');
    
    // 等待 WebSocket 返回真实数据（最多 10 秒）
    let waitCount = 0;
    while (waitCount < 20) {
        const wsStatus = getWebSocketStatus();
        if (wsStatus.cachedOrderBooks >= 4) {  // 至少要有 4 个订单簿（2个市场 x 2个token）
            break;
        }
        await new Promise(r => setTimeout(r, 500));
        waitCount++;
    }
    
    Logger.success('📊 WebSocket 数据就绪，开始监控...');
    Logger.divider();
    
    // 结算回调：打印日志并发送 Telegram 通知
    onSettlement(async (result: SettlementResult) => {
        const emoji = result.profit >= 0 ? '🎉' : '😢';
        Logger.arbitrage(`${emoji} 事件结算: ${result.position.slug.slice(0, 30)} | ${result.outcome.toUpperCase()} 获胜 | 盈亏: $${result.profit.toFixed(2)}`);
        
        // 发送 Telegram 通知
        const overallStats = getOverallStats();
        await notifySingleSettlement(result, overallStats);
    });
    
    // 发送 Telegram 启动通知
    await notifyBotStarted();
    
    let lastLogTime = Date.now();
    let scansSinceLog = 0;
    let lastPositionReport = Date.now();  // 持仓汇报时间
    let lastPriceLog = Date.now();
    let lastApiSyncTime = Date.now();  // API 仓位同步时间
    const API_SYNC_INTERVAL = 30000;   // 30 秒同步一次
    
    // 高速主循环
    while (true) {
        try {
            stats.scans++;
            scansSinceLog++;
            
            // 🔄 定期从 API 同步仓位（实盘模式）
            const currentTime = Date.now();
            if (!CONFIG.SIMULATION_MODE && currentTime - lastApiSyncTime >= API_SYNC_INTERVAL) {
                lastApiSyncTime = currentTime;
                await syncPositionsFromAPI();
            }
            
            // 检查对冲/止损状态（优先于套利）
            let opportunities: ArbitrageOpportunity[] = [];
            let shouldSkipArbitrage = false;
            
            // 币安波动率检查（无论什么模式都要检查）
            for (const timeGroup of ['15min', '1hr'] as const) {
                const endTime = getMarketEndTime(timeGroup);
                if (endTime) {
                    checkBinanceVolatility(timeGroup, endTime);
                }
            }
            
            if (CONFIG.STOP_LOSS_MODE === 'hedge') {
                for (const timeGroup of ['15min', '1hr'] as const) {
                    const pauseCheck = shouldPauseTrading(timeGroup);
                    
                    // 对冲已完成，等待事件结束，停止所有交易
                    if (pauseCheck.pause) {
                        shouldSkipArbitrage = true;
                        continue;
                    }
                    
                    // 需要对冲，停止套利，只执行对冲
                    if (pauseCheck.shouldHedge) {
                        shouldSkipArbitrage = true;
                        const hedgeOpps = generateHedgeOpportunities(timeGroup);
                        if (hedgeOpps.length > 0) {
                            opportunities = hedgeOpps;
                        }
                    }
                }
            } else if (CONFIG.STOP_LOSS_MODE === 'sell') {
                // sell 模式下，如果触发止损，执行平仓
                for (const timeGroup of ['15min', '1hr'] as const) {
                    const pauseCheck = shouldPauseTrading(timeGroup);
                    if (pauseCheck.pause || pauseCheck.shouldHedge) {
                        shouldSkipArbitrage = true;
                        // 获取止损信号并执行平仓
                        const signal = getTriggeredSignal(timeGroup);
                        if (signal) {
                            await executeStopLoss(executeSell, signal);
                        }
                    }
                }
            }
            
            // 只有在没有对冲需求时才进行常规套利
            if (!shouldSkipArbitrage && opportunities.length === 0) {
                // 检测紧急平衡和极端不平衡条件
                const emergencyBalanceGroups = new Set<string>();  // 紧急平衡：停跨池，继续同池
                const extremeImbalanceGroups = new Set<string>();  // 极端不平衡：停所有，执行卖出
                
                for (const timeGroup of ['15min', '1hr'] as const) {
                    const endTime = getMarketEndTime(timeGroup);
                    const avgPrices = getAssetAvgPrices(timeGroup);
                    
                    if (endTime && avgPrices.btc && avgPrices.eth) {
                        const btcBalance = calculateBalancePercent(avgPrices.btc.upShares, avgPrices.btc.downShares);
                        const ethBalance = calculateBalancePercent(avgPrices.eth.upShares, avgPrices.eth.downShares);
                        
                        // 检测紧急平衡（最后 20 秒 + 平衡度 < 60%）
                        const emergency = checkEmergencyBalance(timeGroup, btcBalance, ethBalance, endTime);
                        if (emergency.isEmergency) {
                            emergencyBalanceGroups.add(timeGroup);
                        }
                    }
                    
                    // 检测极端不平衡（由 checkExtremeImbalance 处理，已触发则在 isInEmergencyMode 中）
                    if (isInEmergencyMode(timeGroup)) {
                        extremeImbalanceGroups.add(timeGroup);
                    }
                }
                
                // 如果有极端不平衡，停止所有套利
                if (extremeImbalanceGroups.size > 0) {
                    // 不做任何套利，等待卖出完成
                } else {
                    // 如果有紧急平衡，只停止跨池，继续同池
                    if (emergencyBalanceGroups.size === 0) {
                        // 正常模式：扫描跨池套利机会
                        opportunities = await scanArbitrageOpportunities(true);
                    }
                    
                    // 同池增持机会（紧急平衡模式下继续，会放宽限制）
                    if (CONFIG.SAME_POOL_REBALANCE_ENABLED) {
                        for (const timeGroup of ['15min', '1hr'] as const) {
                            // 极端不平衡模式下不做同池
                            if (!extremeImbalanceGroups.has(timeGroup)) {
                                const samePoolOpps = generateSamePoolOpportunities(timeGroup);
                                opportunities.push(...samePoolOpps);
                            }
                        }
                    }
                }
            }
            
            if (opportunities.length > 0) {
                stats.opportunitiesFound += opportunities.length;
                
                // 选择多个机会（并行下单）
                const selected = selectOpportunities(opportunities);
                
                if (selected.length > 0) {
                    // 检查每日限制
                    if (stats.tradesExecuted >= CONFIG.MAX_DAILY_TRADES) {
                        Logger.warning('已达到每日交易限制，跳过');
                    } else {
                        // 并行执行（带超时保护）
                        const tradePromises = selected.map(async (opp) => {
                            try {
                                stats.tradesExecuted++;
                                const result = await executeArbitrage(opp, 0);
                                return { opp, result };
                            } catch (err) {
                                Logger.error(`交易执行错误: ${err}`);
                                return { opp, result: { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 } };
                            }
                        });
                        
                        // 带超时的等待（最多 10 秒）
                        const timeoutPromise = new Promise<never>((_, reject) => 
                            setTimeout(() => reject(new Error('交易超时')), 10000)
                        );
                        
                        try {
                            const results = await Promise.race([
                                Promise.all(tradePromises),
                                timeoutPromise
                            ]) as { opp: any; result: any }[];
                            
                            // 统计结果
                            for (const { result } of results) {
                                if (result.success) {
                                    stats.tradesSuccessful++;
                                    stats.totalCost += result.totalCost;
                                    stats.totalProfit += result.expectedProfit;
                                }
                            }
                        } catch (timeoutErr) {
                            Logger.warning('交易执行超时，继续扫描');
                        }
                    }
                }
            }
            
            // 每30秒打印一次状态（减少 I/O）
            const now = Date.now();
            if (now - lastLogTime >= 30000) {
                const scansPerSecond = (scansSinceLog / ((now - lastLogTime) / 1000)).toFixed(1);
                const posStats = getPositionStats();
                const wsStatus = getWebSocketStatus();
                const overallStats = getOverallStats();
                
                const binanceStatus = isBinanceWsConnected() ? '🟢' : '🔴';
                Logger.info(`⚡ ${scansPerSecond}/s | WS: ${wsStatus.connected ? '🟢' : '🔴'} ${wsStatus.cachedOrderBooks} books | 币安: ${binanceStatus} | 仓位: ${posStats.totalPositions} | 已结算: ${overallStats.totalSettled} | 总盈亏: $${overallStats.totalProfit.toFixed(2)}`);
                lastLogTime = now;
                scansSinceLog = 0;
            }
            
            // 每15秒检查：结算到期仓位 + 事件切换
            if (now - lastPriceLog >= 15000) {
                // 异步获取真实结果（通知由 onSettlement 回调统一发送，避免重复）
                await checkAndSettleExpired();
                
                await checkEventSwitch();  // 检查 15 分钟事件是否切换
                lastPriceLog = now;
            }
            
            // 止损检查（高频，由止损模块内部控制频率）
            // 注意：hedge 模式下不执行平仓，只依赖对冲逻辑
            if (CONFIG.STOP_LOSS_MODE === 'sell') {
                const stopLossSignals = checkStopLossSignals();
                if (stopLossSignals.length > 0) {
                    for (const signal of stopLossSignals) {
                        Logger.warning(`🚨 触发止损: ${signal.timeGroup} - ${signal.reason}`);
                        await executeStopLoss(executeSell, signal);
                    }
                }
            }
            
            // 极端不平衡检测（最后 90 秒，平衡度 < 30% 时提前平仓不平衡部分）
            for (const timeGroup of ['15min', '1hr'] as const) {
                const extremeSignal = checkExtremeImbalance(timeGroup);
                if (extremeSignal) {
                    Logger.warning(`🚨 极端不平衡触发: ${timeGroup}`);
                    await executeExtremeImbalanceSell(executeSell, extremeSignal);
                }
            }
            
            // 自动赎回检查（内部控制5秒间隔）
            checkAndRedeem().catch(() => {});
            
            // 每10分钟发送一次累计盈亏统计到 Telegram
            if (now - lastPositionReport >= 10 * 60 * 1000) {
                // 先检查结算（通知由 onSettlement 回调统一发送）
                await checkAndSettleExpired();
                
                // 发送运行统计
                const overallStats = getOverallStats();
                const posStats = getPositionStats();
                const hedgeStats = getGlobalHedgeStats();
                const runtime = Math.floor((Date.now() - stats.startTime.getTime()) / 1000 / 60);
                await notifyRunningStats({
                    runtime,
                    totalSettled: overallStats.totalSettled,
                    totalProfit: overallStats.totalProfit,
                    winCount: overallStats.winCount,
                    lossCount: overallStats.lossCount,
                    winRate: overallStats.winRate,
                    activePositions: posStats.totalPositions,
                    pendingProfit: posStats.expectedProfit,
                    // 对冲统计
                    hedgeEvents: hedgeStats.totalHedgeEvents,
                    hedgeCompleted: hedgeStats.completedHedgeEvents,
                    hedgeCost: hedgeStats.totalHedgeCost,
                });
                
                lastPositionReport = now;
            }
            
        } catch (error) {
            // 记录错误但不中断循环
            if (stats.scans % 1000 === 0) {  // 每 1000 次扫描才打印一次错误
                Logger.error(`扫描错误: ${error}`);
            }
        }
        
        // 毫秒级间隔
        await new Promise(resolve => setTimeout(resolve, CONFIG.SCAN_INTERVAL_MS));
    }
};

// 优雅退出
process.on('SIGINT', async () => {
    Logger.divider();
    Logger.info('收到退出信号，正在关闭...');
    
    // 保存数据
    await closeStorage();
    
    printStats();
    process.exit(0);
});

// 启动
mainLoop().catch(error => {
    Logger.error(`机器人崩溃: ${error}`);
    process.exit(1);
});



