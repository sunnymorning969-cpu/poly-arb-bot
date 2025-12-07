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
    const emoji = result.success ? '✅' : '❌';
    const status = result.success ? '成功' : '失败';
    
    const message = `
${emoji} <b>套利交易${status}！</b>

📊 <b>市场:</b> ${opportunity.title.slice(0, 50)}...

📝 <b>执行详情:</b>
   • Up 成交: ${result.upFilled.toFixed(2)} shares
   • Down 成交: ${result.downFilled.toFixed(2)} shares
   • 总成本: $${result.totalCost.toFixed(2)}

💰 <b>预期利润:</b> $${result.expectedProfit.toFixed(2)}
`.trim();

    await sendTelegramMessage(message);
};

/**
 * 发送机器人启动通知（高优先级）
 */
export const notifyBotStarted = async (): Promise<void> => {
    const message = `
🤖 <b>套利机器人 v3.0 已启动！</b>

⚡ <b>架构:</b> WebSocket 实时订单簿

⚙️ <b>配置信息:</b>
   • 最小套利空间: ${CONFIG.MIN_ARBITRAGE_PERCENT}%
   • 下单范围: $${CONFIG.MIN_ORDER_SIZE_USD}-$${CONFIG.MAX_ORDER_SIZE_USD}
   • 并行下单: 最多 ${CONFIG.MAX_PARALLEL_TRADES} 个市场

💰 <b>单边阈值:</b>
   • Up < $${CONFIG.UP_PRICE_THRESHOLD} 优先买入
   • Down < $${CONFIG.DOWN_PRICE_THRESHOLD} 优先买入

   • 模拟模式: ${CONFIG.SIMULATION_MODE ? '✅ 开启' : '❌ 关闭'}

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

export default {
    sendTelegramMessage,
    notifyArbitrageFound,
    notifyTradeExecuted,
    notifyBotStarted,
    notifyDailyStats,
    notifySettlement,
    notifyOverallStats,
};
