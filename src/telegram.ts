/**
 * Telegram 通知模块
 */

import axios from 'axios';
import CONFIG from './config';
import { ArbitrageOpportunity } from './scanner';
import { SettlementResult } from './positions';

const TELEGRAM_API = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}`;

// 发送频率限制
const MIN_SEND_INTERVAL_MS = 1500;  // 最快1.5秒发一次
let lastSendTime = 0;
let messageQueue: string[] = [];
let isProcessingQueue = false;

/**
 * 发送 Telegram 消息（带频率限制）
 */
export const sendTelegramMessage = async (message: string, priority: boolean = false): Promise<boolean> => {
    if (!CONFIG.TELEGRAM_ENABLED || !CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_GROUP_ID) {
        return false;
    }
    
    const now = Date.now();
    const timeSinceLastSend = now - lastSendTime;
    
    // 如果距离上次发送不足1.5秒，加入队列（除非是高优先级）
    if (timeSinceLastSend < MIN_SEND_INTERVAL_MS && !priority) {
        // 队列最多保留5条消息，避免积压
        if (messageQueue.length < 5) {
            messageQueue.push(message);
        }
        
        // 启动队列处理
        if (!isProcessingQueue) {
            processQueue();
        }
        return true;
    }
    
    return await doSend(message);
};

/**
 * 实际发送消息
 */
const doSend = async (message: string): Promise<boolean> => {
    try {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: CONFIG.TELEGRAM_GROUP_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        }, {
            timeout: 5000,
        });
        lastSendTime = Date.now();
        return true;
    } catch (error) {
        // 静默处理，避免刷屏
        return false;
    }
};

/**
 * 处理消息队列
 */
const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) {
        return;
    }
    
    isProcessingQueue = true;
    
    while (messageQueue.length > 0) {
        const timeSinceLastSend = Date.now() - lastSendTime;
        const waitTime = Math.max(0, MIN_SEND_INTERVAL_MS - timeSinceLastSend);
        
        if (waitTime > 0) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        const message = messageQueue.shift();
        if (message) {
            await doSend(message);
        }
    }
    
    isProcessingQueue = false;
};

/**
 * 发送套利机会通知
 */
export const notifyArbitrageFound = async (opportunity: ArbitrageOpportunity): Promise<void> => {
    const profitUSD = opportunity.maxShares * (1 - opportunity.combinedCost);
    const endTime = new Date(opportunity.endDate).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    
    // 标记便宜的一边
    const upTag = opportunity.upIsCheap ? '💰' : '';
    const downTag = opportunity.downIsCheap ? '💰' : '';
    
    const message = `
🎯 <b>发现套利机会！</b>

📊 <b>市场:</b> ${opportunity.title.slice(0, 50)}...

💰 <b>价格信息:</b>
   • Up:   $${opportunity.upAskPrice.toFixed(3)} ${upTag} (${opportunity.upAskSize.toFixed(1)} 可买)
   • Down: $${opportunity.downAskPrice.toFixed(3)} ${downTag} (${opportunity.downAskSize.toFixed(1)} 可买)
   • 组合成本: $${opportunity.combinedCost.toFixed(4)}

📈 <b>套利空间:</b> ${opportunity.profitPercent.toFixed(2)}%
💵 <b>最大利润:</b> $${profitUSD.toFixed(2)} (${opportunity.maxShares.toFixed(1)} shares)
🏆 <b>优先级:</b> ${opportunity.priority.toFixed(1)}

⏰ <b>结算时间:</b> ${endTime}
`.trim();

    await sendTelegramMessage(message);
};

/**
 * 发送交易执行通知
 */
export const notifyTradeExecuted = async (
    opportunity: ArbitrageOpportunity,
    result: {
        success: boolean;
        upFilled: number;
        downFilled: number;
        totalCost: number;
        expectedProfit: number;
    }
): Promise<void> => {
    // 如果没有任何成交，不发送通知（避免发送失败的空消息）
    if (result.upFilled === 0 && result.downFilled === 0) {
        return;
    }
    
    const emoji = result.success ? '✅' : '❌';
    
    // 判断交易类型
    const isBuyBoth = result.upFilled > 0 && result.downFilled > 0;
    const isBuyUpOnly = result.upFilled > 0 && result.downFilled === 0;
    const isBuyDownOnly = result.downFilled > 0 && result.upFilled === 0;
    
    let tradeType = '套利交易';
    let tradeIcon = '⚖️';
    if (isBuyUpOnly) {
        tradeType = '买入 Up (平衡仓位)';
        tradeIcon = '📈';
    } else if (isBuyDownOnly) {
        tradeType = '买入 Down (平衡仓位)';
        tradeIcon = '📉';
    }
    
    const status = result.success ? '成功' : '失败';
    
    // 只显示实际成交的一边
    let detailLines = '';
    if (result.upFilled > 0) {
        const upPrice = result.upFilled > 0 ? (result.totalCost / result.upFilled).toFixed(3) : '0';
        detailLines += `   • Up: ${result.upFilled.toFixed(1)} shares @ $${isBuyUpOnly ? upPrice : opportunity.upAskPrice.toFixed(3)}\n`;
    }
    if (result.downFilled > 0) {
        const downPrice = result.downFilled > 0 && isBuyDownOnly ? (result.totalCost / result.downFilled).toFixed(3) : opportunity.downAskPrice.toFixed(3);
        detailLines += `   • Down: ${result.downFilled.toFixed(1)} shares @ $${downPrice}\n`;
    }
    
    // 跨池子标记
    const crossPoolTag = opportunity.isCrossPool ? '🔀跨池 ' : '';
    const upSource = opportunity.upMarketSlug?.includes('btc') ? 'BTC' : 'ETH';
    const downSource = opportunity.downMarketSlug?.includes('btc') ? 'BTC' : 'ETH';
    const sourceInfo = opportunity.isCrossPool ? `${upSource}↑ + ${downSource}↓` : opportunity.timeGroup;
    
    const message = `
${emoji} ${tradeIcon} <b>${crossPoolTag}${tradeType}${status}</b>

📊 ${sourceInfo} | ${opportunity.slug.slice(0, 25)}

📝 <b>成交:</b>
${detailLines}   • 成本: $${result.totalCost.toFixed(2)}
${isBuyBoth ? `\n💰 <b>套利利润:</b> $${result.expectedProfit.toFixed(2)}` : ''}
`.trim();

    await sendTelegramMessage(message);
};

/**
 * 发送机器人启动通知（高优先级）
 */
export const notifyBotStarted = async (): Promise<void> => {
    const message = `
🤖 <b>套利机器人 v3.0 已启动！</b>

⚡ <b>模式:</b> ${CONFIG.SIMULATION_MODE ? '🔵 模拟' : '🔴 实盘'}

⚙️ <b>交易参数:</b>
   • 最小利润: ${CONFIG.MIN_ARBITRAGE_PERCENT}%
   • 订单范围: $${CONFIG.MIN_ORDER_SIZE_USD}-$${CONFIG.MAX_ORDER_SIZE_USD}
   • 并行上限: ${CONFIG.MAX_PARALLEL_TRADES}

⏱️ <b>频率控制:</b>
   • 扫描: ${CONFIG.SCAN_INTERVAL_MS}ms
   • 冷却: ${CONFIG.TRADE_COOLDOWN_MS}ms

🔍 监控 BTC/ETH Up/Down (15min + 1hr)...
`.trim();

    await sendTelegramMessage(message, true);  // 高优先级，立即发送
};

/**
 * 发送每日统计
 */
export const notifyDailyStats = async (stats: {
    scans: number;
    opportunitiesFound: number;
    tradesExecuted: number;
    tradesSuccessful: number;
    totalProfit: number;
}): Promise<void> => {
    const message = `
📊 <b>运行统计</b>

   • 扫描次数: ${stats.scans}
   • 发现机会: ${stats.opportunitiesFound}
   • 执行交易: ${stats.tradesExecuted}
   • 成功交易: ${stats.tradesSuccessful}
   • 总利润: $${stats.totalProfit.toFixed(2)}
`.trim();

    await sendTelegramMessage(message);
};

/**
 * 发送事件结算通知（高优先级）
 */
export const notifySettlement = async (result: SettlementResult): Promise<void> => {
    const pos = result.position;
    const isProfit = result.profit >= 0;
    const emoji = isProfit ? '🎉' : '😢';
    const profitEmoji = isProfit ? '📈' : '📉';
    const outcomeText = result.outcome === 'up' ? '⬆️ UP' : '⬇️ DOWN';
    
    const message = `
${emoji} <b>事件结算通知</b>

📊 <b>市场:</b> ${pos.title.slice(0, 50)}...

🎲 <b>结果:</b> ${outcomeText} 获胜

📝 <b>持仓详情:</b>
   • Up 持仓: ${pos.upShares.toFixed(2)} shares (成本 $${pos.upCost.toFixed(2)})
   • Down 持仓: ${pos.downShares.toFixed(2)} shares (成本 $${pos.downCost.toFixed(2)})
   • 总成本: $${result.totalCost.toFixed(2)}

💰 <b>结算:</b>
   • 收回: $${result.payout.toFixed(2)}
   • ${profitEmoji} <b>盈亏: ${isProfit ? '+' : ''}$${result.profit.toFixed(2)} (${result.profitPercent >= 0 ? '+' : ''}${result.profitPercent.toFixed(1)}%)</b>

${CONFIG.SIMULATION_MODE ? '⚠️ <i>模拟模式 - 结果随机生成</i>' : ''}
`.trim();

    await sendTelegramMessage(message, true);  // 高优先级
};

/**
 * 发送总体结算统计
 */
export const notifyOverallStats = async (stats: {
    totalSettled: number;
    totalProfit: number;
    winCount: number;
    lossCount: number;
    winRate: number;
}): Promise<void> => {
    const isProfit = stats.totalProfit >= 0;
    const profitEmoji = isProfit ? '📈' : '📉';
    
    const message = `
📊 <b>总体结算统计</b>

   • 已结算事件: ${stats.totalSettled}
   • 盈利次数: ${stats.winCount} ✅
   • 亏损次数: ${stats.lossCount} ❌
   • 胜率: ${stats.winRate.toFixed(1)}%

${profitEmoji} <b>总盈亏: ${isProfit ? '+' : ''}$${stats.totalProfit.toFixed(2)}</b>
`.trim();

    await sendTelegramMessage(message);
};

/**
 * 发送持仓汇报（每2分钟）
 * 显示各事件的总持仓情况和预期盈亏
 */
export const notifyPositionReport = async (positions: Array<{
    slug: string;
    title: string;
    upShares: number;
    downShares: number;
    upCost: number;
    downCost: number;
    endDate: string;
}>): Promise<void> => {
    if (positions.length === 0) {
        const message = `
📋 <b>持仓汇报</b> (${new Date().toLocaleTimeString('zh-CN')})

暂无活跃仓位
`.trim();
        await sendTelegramMessage(message);
        return;
    }
    
    // 计算总体统计
    let totalUpShares = 0;
    let totalDownShares = 0;
    let totalCost = 0;
    
    const positionLines: string[] = [];
    
    for (const pos of positions) {
        const cost = pos.upCost + pos.downCost;
        const minShares = Math.min(pos.upShares, pos.downShares);
        const expectedProfit = minShares - cost;
        const profitPercent = cost > 0 ? (expectedProfit / cost) * 100 : 0;
        const imbalance = pos.upShares - pos.downShares;
        
        totalUpShares += pos.upShares;
        totalDownShares += pos.downShares;
        totalCost += cost;
        
        // 格式化结束时间
        const endTime = new Date(pos.endDate);
        const timeStr = endTime.toLocaleTimeString('zh-CN', { 
            hour: '2-digit', 
            minute: '2-digit',
            timeZone: 'Asia/Shanghai'
        });
        
        // 简短显示每个仓位
        const profitEmoji = expectedProfit >= 0 ? '✅' : '❌';
        const balanceIcon = Math.abs(imbalance) < 1 ? '⚖️' : (imbalance > 0 ? '⬆️' : '⬇️');
        
        positionLines.push(
            `${balanceIcon} <b>${pos.slug.slice(0, 25)}</b>\n` +
            `   U:${pos.upShares.toFixed(1)} D:${pos.downShares.toFixed(1)} | 成本:$${cost.toFixed(2)} | ${profitEmoji}$${expectedProfit.toFixed(2)} (${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(1)}%) | 截止:${timeStr}`
        );
    }
    
    // 计算总预期利润
    const totalMinShares = Math.min(totalUpShares, totalDownShares);
    const totalExpectedProfit = totalMinShares - totalCost;
    const totalProfitPercent = totalCost > 0 ? (totalExpectedProfit / totalCost) * 100 : 0;
    const totalProfitEmoji = totalExpectedProfit >= 0 ? '📈' : '📉';
    
    const message = `
📋 <b>持仓汇报</b> (${new Date().toLocaleTimeString('zh-CN')})

${positionLines.join('\n\n')}

━━━━━━━━━━━━━━━
<b>📊 汇总:</b>
   • 活跃仓位: ${positions.length} 个
   • 总 Up: ${totalUpShares.toFixed(1)} | 总 Down: ${totalDownShares.toFixed(1)}
   • 总成本: $${totalCost.toFixed(2)}
   • ${totalProfitEmoji} <b>预期盈亏: ${totalExpectedProfit >= 0 ? '+' : ''}$${totalExpectedProfit.toFixed(2)} (${totalProfitPercent >= 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}%)</b>

${CONFIG.SIMULATION_MODE ? '⚠️ <i>模拟模式</i>' : ''}
`.trim();

    await sendTelegramMessage(message);
};

/**
 * 发送事件结束总结
 */
export const notifyEventSummary = async (
    eventName: string,
    result: {
        outcome: 'up' | 'down';
        profit: number;
        profitPercent: number;
        totalCost: number;
        payout: number;
    },
    overallStats: {
        totalSettled: number;
        totalProfit: number;
        winCount: number;
        lossCount: number;
        winRate: number;
    }
): Promise<void> => {
    const outcomeEmoji = result.outcome === 'up' ? '⬆️' : '⬇️';
    const profitEmoji = result.profit >= 0 ? '🎉' : '😢';
    const overallProfitEmoji = overallStats.totalProfit >= 0 ? '📈' : '📉';
    
    const message = `
${profitEmoji} <b>事件结束总结</b>

📊 <b>事件:</b> ${eventName.slice(0, 50)}...
🎲 <b>结果:</b> ${outcomeEmoji} ${result.outcome.toUpperCase()} 获胜

💰 <b>本次盈亏:</b>
   • 成本: $${result.totalCost.toFixed(2)}
   • 收回: $${result.payout.toFixed(2)}
   • 盈亏: ${result.profit >= 0 ? '+' : ''}$${result.profit.toFixed(2)} (${result.profitPercent >= 0 ? '+' : ''}${result.profitPercent.toFixed(1)}%)

━━━━━━━━━━━━━━━
📊 <b>累计统计:</b>
   • 已结算: ${overallStats.totalSettled} 个事件
   • 胜率: ${overallStats.winRate.toFixed(1)}% (${overallStats.winCount}胜/${overallStats.lossCount}负)
   • ${overallProfitEmoji} <b>累计盈亏: ${overallStats.totalProfit >= 0 ? '+' : ''}$${overallStats.totalProfit.toFixed(2)}</b>
`.trim();

    await sendTelegramMessage(message, true);  // 高优先级
};

export default {
    sendTelegramMessage,
    notifyArbitrageFound,
    notifyTradeExecuted,
    notifyBotStarted,
    notifyDailyStats,
    notifySettlement,
    notifyOverallStats,
    notifyPositionReport,
    notifyEventSummary,
};


