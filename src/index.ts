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
import { scanArbitrageOpportunities, ArbitrageOpportunity, initWebSocket, getWebSocketStatus, checkEventSwitch } from './scanner';
import { initClient, getBalance, getUSDCBalance, ensureApprovals, executeArbitrage, isDuplicateOpportunity } from './executor';
import { notifyArbitrageFound, notifyTradeExecuted, notifyBotStarted, notifyDailyStats, notifySettlement, notifyOverallStats, notifyPositionReport, notifyEventSummary } from './telegram';
import { getPositionStats, checkAndSettleExpired, onSettlement, getOverallStats, SettlementResult, loadPositionsFromStorage, getAllPositions } from './positions';
import { initStorage, closeStorage, getStorageStatus } from './storage';

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
    
    Logger.info('📋 当前配置:');
    Logger.info(`   钱包: ${CONFIG.PROXY_WALLET.slice(0, 10)}...${CONFIG.PROXY_WALLET.slice(-8)}`);
    Logger.info(`   模式: ${CONFIG.SIMULATION_MODE ? '🔵 模拟' : '🔴 实盘'}`);
    Logger.divider();
    Logger.info('⚙️ 交易参数:');
    Logger.info(`   最小利润: ${CONFIG.MIN_ARBITRAGE_PERCENT}%`);
    Logger.info(`   订单范围: $${CONFIG.MIN_ORDER_SIZE_USD} - $${CONFIG.MAX_ORDER_SIZE_USD}`);
    Logger.info(`   深度使用: ${CONFIG.DEPTH_USAGE_PERCENT}%`);
    Logger.divider();
    Logger.info('⏱️ 频率控制:');
    Logger.info(`   扫描间隔: ${CONFIG.SCAN_INTERVAL_MS}ms`);
    Logger.info(`   交易冷却: ${CONFIG.TRADE_COOLDOWN_MS}ms`);
    Logger.info(`   并行上限: ${CONFIG.MAX_PARALLEL_TRADES}`);
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
        if (selected.length >= CONFIG.MAX_PARALLEL_TRADES) break;
        
        // ============ 最终验证 ============
        // 1. 价格有效性检查
        if (opp.upAskPrice < 0.01 || opp.downAskPrice < 0.01) {
            continue;  // 跳过异常价格
        }
        
        // 2. 深度检查（必须有至少 1 share 可买）
        if (opp.upAskSize < 1 || opp.downAskSize < 1) {
            continue;  // 跳过深度不足
        }
        
        // 3. buy_both 必须满足合计 < $1.00
        if (opp.tradingAction === 'buy_both' && opp.combinedCost >= 0.995) {
            continue;  // 合计 >= $0.995 不是真正套利
        }
        
        // 4. 冷却检查（跨池子时检查两个市场）
        if (isDuplicateOpportunity(opp.conditionId, opp.upAskPrice, opp.downAskPrice)) {
            continue;
        }
        if (opp.isCrossPool && opp.downConditionId && isDuplicateOpportunity(opp.downConditionId, opp.upAskPrice, opp.downAskPrice)) {
            continue;
        }
        
        selected.push(opp);
        
        // 显示选中的机会（带跨池子和策略信息）
        const actionEmoji = opp.tradingAction === 'buy_both' ? '⚖️' : 
                           opp.tradingAction === 'buy_up_only' ? '📈' : '📉';
        const crossPoolTag = opp.isCrossPool ? '🔀' : '';
        const groupInfo = opp.groupAnalysis?.hasPosition ? 
            `组:U${opp.groupAnalysis.imbalance > 0 ? '+' : ''}${opp.groupAnalysis.imbalance.toFixed(0)}` : '新仓';
        
        // 显示 Up 和 Down 来源
        const upSource = opp.upMarketSlug?.includes('btc') ? 'BTC' : 'ETH';
        const downSource = opp.downMarketSlug?.includes('btc') ? 'BTC' : 'ETH';
        const sourceInfo = opp.isCrossPool ? `${upSource}↑${downSource}↓` : opp.timeGroup;
        
        Logger.success(`${actionEmoji}${crossPoolTag} ${sourceInfo} | Up:$${opp.upAskPrice.toFixed(2)} Down:$${opp.downAskPrice.toFixed(2)} | 合计:$${opp.combinedCost.toFixed(3)} | ${groupInfo} | ${opp.tradingAction}`);
    }
    
    return selected;
};

/**
 * 主循环
 */
const mainLoop = async () => {
    printBanner();
    
    // 初始化数据存储
    try {
        await initStorage();
        loadPositionsFromStorage();  // 加载之前的仓位
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
    
    // 注册结算回调 - 事件结束时发送通知和总结
    onSettlement(async (result: SettlementResult) => {
        const emoji = result.profit >= 0 ? '🎉' : '😢';
        Logger.arbitrage(`${emoji} 事件结算: ${result.position.slug.slice(0, 30)} | ${result.outcome.toUpperCase()} 获胜 | 盈亏: $${result.profit.toFixed(2)}`);
        
        // 获取总体统计
        const overallStats = getOverallStats();
        
        // 发送事件结束总结（包含本次盈亏和累计统计）
        await notifyEventSummary(
            result.position.title,
            {
                outcome: result.outcome,
                profit: result.profit,
                profitPercent: result.profitPercent,
                totalCost: result.totalCost,
                payout: result.payout,
            },
            overallStats
        );
    });
    
    // 发送 Telegram 启动通知
    await notifyBotStarted();
    
    let lastLogTime = Date.now();
    let scansSinceLog = 0;
    let lastPositionReport = Date.now();  // 持仓汇报时间
    let lastPriceLog = Date.now();
    
    // 高速主循环
    while (true) {
        try {
            stats.scans++;
            scansSinceLog++;
            
            // 静默扫描（不输出每次扫描日志）
            const opportunities = await scanArbitrageOpportunities(true);
            
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
                                
                                // 异步发送通知（不阻塞，不等待）
                                notifyTradeExecuted(opp, result).catch(() => {});
                                
                                return { opp, result };
                            } catch (err) {
                                Logger.error(`交易执行错误: ${err}`);
                                return { opp, result: { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 } };
                            }
                        });
                        
                        // 异步发送通知（不阻塞，不等待）
                        if (selected.length > 0) {
                            notifyArbitrageFound(selected[0]).catch(() => {});
                        }
                        
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
                
                Logger.info(`⚡ ${scansPerSecond}/s | WS: ${wsStatus.connected ? '🟢' : '🔴'} ${wsStatus.cachedOrderBooks} books | 仓位: ${posStats.totalPositions} | 已结算: ${overallStats.totalSettled} | 总盈亏: $${overallStats.totalProfit.toFixed(2)}`);
                lastLogTime = now;
                scansSinceLog = 0;
            }
            
            // 每15秒检查：结算到期仓位 + 事件切换
            if (now - lastPriceLog >= 15000) {
                checkAndSettleExpired();
                await checkEventSwitch();  // 检查 15 分钟事件是否切换
                lastPriceLog = now;
            }
            
            // 每2分钟发送一次持仓汇报到 Telegram
            if (now - lastPositionReport >= 2 * 60 * 1000) {
                // 先检查结算，确保不发送已结算的仓位
                checkAndSettleExpired();
                const allPositions = getAllPositions();
                // 只有还有活跃仓位时才发送汇报
                if (allPositions.length > 0) {
                    await notifyPositionReport(allPositions);
                }
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


