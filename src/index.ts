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
import { scanArbitrageOpportunities, printOpportunities, ArbitrageOpportunity, initWebSocket, getWebSocketStatus, getCurrentPrices, getDebugInfo } from './scanner';
import { initClient, getBalance, getUSDCBalance, ensureApprovals, executeArbitrage, isDuplicateOpportunity } from './executor';
import { notifyArbitrageFound, notifyTradeExecuted, notifyBotStarted, notifyDailyStats, notifySettlement, notifyOverallStats } from './telegram';
import { getPositionStats, checkAndSettleExpired, onSettlement, getOverallStats, SettlementResult, loadPositionsFromStorage } from './positions';
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
    Logger.info(`   钱包地址: ${CONFIG.PROXY_WALLET.slice(0, 10)}...${CONFIG.PROXY_WALLET.slice(-8)}`);
    Logger.info(`   RPC: ${CONFIG.RPC_URL.slice(0, 40)}...`);
    Logger.info(`   数据源: ⚡ WebSocket 实时推送`);
    Logger.info(`   最小套利空间: ${CONFIG.MIN_ARBITRAGE_PERCENT}%`);
    Logger.info(`   下单范围: $${CONFIG.MIN_ORDER_SIZE_USD} - $${CONFIG.MAX_ORDER_SIZE_USD}`);
    Logger.info(`   并行下单: 最多 ${CONFIG.MAX_PARALLEL_TRADES} 个市场`);
    Logger.divider();
    Logger.info('💰 单边价格阈值:');
    Logger.info(`   Up < $${CONFIG.UP_PRICE_THRESHOLD} → 优先买入`);
    Logger.info(`   Down < $${CONFIG.DOWN_PRICE_THRESHOLD} → 优先买入`);
    Logger.divider();
    Logger.info('💾 数据存储:');
    Logger.info(`   存储位置: ${storageStatus.dataFile}`);
    Logger.info(`   已有仓位: ${storageStatus.positionsCount} | 结算历史: ${storageStatus.historyCount}`);
    Logger.divider();
    Logger.info(`   模拟模式: ${CONFIG.SIMULATION_MODE ? '✅ 开启' : '❌ 关闭'}`);
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
 * 选择多个套利机会（并行下单）
 */
const selectOpportunities = (
    opportunities: ArbitrageOpportunity[]
): ArbitrageOpportunity[] => {
    if (opportunities.length === 0) {
        return [];
    }
    
    // 按优先级排序后，选择前 N 个有足够深度的
    const selected: ArbitrageOpportunity[] = [];
    
    for (const opp of opportunities) {
        if (selected.length >= CONFIG.MAX_PARALLEL_TRADES) break;
        
        // 跳过重复机会（同一价格已经下过单）
        if (isDuplicateOpportunity(opp.conditionId, opp.upAskPrice, opp.downAskPrice)) {
            continue;
        }
        
        // 检查是否有足够深度
        const maxTradeUSD = opp.maxShares * opp.combinedCost;
        if (maxTradeUSD >= CONFIG.MIN_ORDER_SIZE_USD) {
            selected.push(opp);
        }
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
    
    // 注册结算回调 - 事件结束时发送通知
    onSettlement(async (result: SettlementResult) => {
        const emoji = result.profit >= 0 ? '🎉' : '😢';
        Logger.arbitrage(`${emoji} 事件结算: ${result.position.slug.slice(0, 30)} | ${result.outcome.toUpperCase()} 获胜 | 盈亏: $${result.profit.toFixed(2)}`);
        
        // 发送 Telegram 通知
        await notifySettlement(result);
        
        // 每次结算后发送总体统计
        const overallStats = getOverallStats();
        if (overallStats.totalSettled > 0 && overallStats.totalSettled % 5 === 0) {
            // 每 5 次结算发送一次总体统计
            await notifyOverallStats(overallStats);
        }
    });
    
    // 发送 Telegram 启动通知
    await notifyBotStarted();
    
    let lastLogTime = Date.now();
    let scansSinceLog = 0;
    let lastStatsNotify = Date.now();
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
                        // 显示发现的机会
                        Logger.arbitrage(`🎯 发现 ${selected.length} 个机会，并行下单...`);
                        
                        // 并行执行多个市场的套利
                        const tradePromises = selected.map(async (opp) => {
                            Logger.info(`   📊 ${opp.slug.slice(0, 35)} | Up:$${opp.upAskPrice.toFixed(2)} Down:$${opp.downAskPrice.toFixed(2)} | ${opp.profitPercent.toFixed(1)}%`);
                            
                            stats.tradesExecuted++;
                            const result = await executeArbitrage(opp, 0);
                            
                            // 异步发送通知（不阻塞）
                            notifyTradeExecuted(opp, result);
                            
                            return { opp, result };
                        });
                        
                        // 只发送第一个机会的通知（避免刷屏）
                        if (selected.length > 0) {
                            notifyArbitrageFound(selected[0]);
                        }
                        
                        const results = await Promise.all(tradePromises);
                        
                        // 统计结果
                        for (const { result } of results) {
                            if (result.success) {
                                stats.tradesSuccessful++;
                                stats.totalCost += result.totalCost;
                                stats.totalProfit += result.expectedProfit;
                            }
                        }
                    }
                }
            }
            
            // 每5秒打印一次状态
            const now = Date.now();
            if (now - lastLogTime >= 5000) {
                const scansPerSecond = (scansSinceLog / ((now - lastLogTime) / 1000)).toFixed(1);
                const posStats = getPositionStats();
                const wsStatus = getWebSocketStatus();
                const overallStats = getOverallStats();
                
                Logger.info(`⚡ ${scansPerSecond}/s | WS: ${wsStatus.connected ? '🟢' : '🔴'} ${wsStatus.cachedOrderBooks} books | 仓位: ${posStats.totalPositions} | 已结算: ${overallStats.totalSettled} | 总盈亏: $${overallStats.totalProfit.toFixed(2)}`);
                lastLogTime = now;
                scansSinceLog = 0;
                
                // 检查并结算已到期仓位
                checkAndSettleExpired();
            }
            
            // 每15秒打印一次市场价格和调试信息
            if (now - lastPriceLog >= 15000) {
                Logger.info(`🔍 调试: ${getDebugInfo()}`);
                
                const prices = getCurrentPrices();
                if (prices.length > 0) {
                    Logger.info('📊 当前市场价格:');
                    for (const p of prices) {
                        const upStr = p.upAsk !== null ? `$${p.upAsk.toFixed(3)}` : '无数据';
                        const downStr = p.downAsk !== null ? `$${p.downAsk.toFixed(3)}` : '无数据';
                        const combStr = p.combined !== null ? `$${p.combined.toFixed(3)}` : '-';
                        Logger.info(`   ${p.market} | Up: ${upStr} | Down: ${downStr} | 合计: ${combStr}`);
                    }
                }
                lastPriceLog = now;
            }
            
            // 每5分钟发送一次 Telegram 统计
            if (now - lastStatsNotify >= 5 * 60 * 1000) {
                await notifyDailyStats(stats);
                lastStatsNotify = now;
            }
            
        } catch (error) {
            // 静默处理错误，避免刷屏
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
