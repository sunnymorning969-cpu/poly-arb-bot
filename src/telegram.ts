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

// 追踪每种事件类型的结算次数
const settlementCounters: Map<string, number> = new Map();  // key: "15min" 或 "1hr"

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
    } catch (error: any) {
        // 启动通知失败时输出错误
        if (message.includes('机器人') && message.includes('启动')) {
            console.error(`[Telegram] 启动通知发送失败:`, error.message || error);
        }
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
    
    // 跨池子标记（兼容 btc/bitcoin 和 eth/ethereum）
    const crossPoolTag = opportunity.isCrossPool ? '🔀跨池 ' : '';
    const isBtcUp = opportunity.upMarketSlug?.includes('btc') || opportunity.upMarketSlug?.includes('bitcoin');
    const isBtcDown = opportunity.downMarketSlug?.includes('btc') || opportunity.downMarketSlug?.includes('bitcoin');
    const upSource = isBtcUp ? 'BTC' : 'ETH';
    const downSource = isBtcDown ? 'BTC' : 'ETH';
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
    if (!CONFIG.TELEGRAM_ENABLED) {
        console.log('[Telegram] 启动通知跳过：TELEGRAM_ENABLED=false');
        return;
    }
    
    const message = `
🤖 <b>套利机器人 v3.0 已启动！</b>

⚡ <b>模式:</b> ${CONFIG.SIMULATION_MODE ? '🔵 模拟' : '🔴 实盘'}

⚙️ <b>交易参数:</b>
   • 最小利润率: ${CONFIG.MIN_ARBITRAGE_PERCENT}%
   • 最小利润额: $${CONFIG.MIN_PROFIT_USD}
   • 最大订单: $${CONFIG.MAX_ORDER_SIZE_USD}
   • 并行上限: ${CONFIG.MAX_PARALLEL_TRADES}

⏱️ <b>频率控制:</b>
   • 扫描: ${CONFIG.SCAN_INTERVAL_MS}ms
   • 冷却: ${CONFIG.TRADE_COOLDOWN_MS}ms

🔍 监控 BTC/ETH Up/Down (15min + 1hr)...
`.trim();

    const success = await sendTelegramMessage(message, true);  // 高优先级，立即发送
    if (success) {
        console.log('[Telegram] ✅ 启动通知已发送');
    }
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
 * 按时间组（15min/1hr）显示跨池套利效果
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
    
    // 按时间组分组（跨池套利的核心视角）
    const groups: Map<string, {
        positions: typeof positions;
        totalUp: number;
        totalDown: number;
        totalCost: number;
        endDate: string;
    }> = new Map();
    
    for (const pos of positions) {
        // 判断时间组
        const is15min = pos.slug.includes('15m') || pos.slug.includes('15min');
        const timeGroup = is15min ? '15min' : '1hr';
        
        if (!groups.has(timeGroup)) {
            groups.set(timeGroup, {
                positions: [],
                totalUp: 0,
                totalDown: 0,
                totalCost: 0,
                endDate: pos.endDate,
            });
        }
        
        const group = groups.get(timeGroup)!;
        group.positions.push(pos);
        group.totalUp += pos.upShares;
        group.totalDown += pos.downShares;
        group.totalCost += pos.upCost + pos.downCost;
    }
    
    // 构建消息
    const groupLines: string[] = [];
    let grandTotalUp = 0;
    let grandTotalDown = 0;
    let grandTotalCost = 0;
    
    for (const [timeGroup, group] of groups) {
        const minShares = Math.min(group.totalUp, group.totalDown);
        const profit = minShares - group.totalCost;
        const profitPercent = group.totalCost > 0 ? (profit / group.totalCost) * 100 : 0;
        const profitEmoji = profit >= 0 ? '✅' : '❌';
        const balanceIcon = Math.abs(group.totalUp - group.totalDown) < 10 ? '⚖️' : 
                          (group.totalUp > group.totalDown ? '⬆️' : '⬇️');
        
        // 格式化结束时间
        const endTime = new Date(group.endDate);
        const timeStr = endTime.toLocaleTimeString('zh-CN', { 
            hour: '2-digit', 
            minute: '2-digit',
            timeZone: 'Asia/Shanghai'
        });
        
        // 显示组内各市场明细
        const details = group.positions.map(pos => {
            const isBtc = pos.slug.includes('btc') || pos.slug.includes('bitcoin');
            const asset = isBtc ? 'BTC' : 'ETH';
            const upMore = pos.upShares > pos.downShares;
            return `${asset}: U${pos.upShares.toFixed(0)}${upMore ? '↑' : ''} D${pos.downShares.toFixed(0)}${!upMore ? '↑' : ''}`;
        }).join(' | ');
        
        groupLines.push(
            `${balanceIcon} <b>${timeGroup === '15min' ? '⏱️15分钟组' : '⏰1小时组'}</b> (截止${timeStr})\n` +
            `   ${details}\n` +
            `   🔀跨池合计: U${group.totalUp.toFixed(0)} + D${group.totalDown.toFixed(0)} = ${minShares.toFixed(0)}对\n` +
            `   💰成本: $${group.totalCost.toFixed(2)} | ${profitEmoji}利润: $${profit.toFixed(2)} (${profitPercent >= 0 ? '+' : ''}${profitPercent.toFixed(1)}%)`
        );
        
        grandTotalUp += group.totalUp;
        grandTotalDown += group.totalDown;
        grandTotalCost += group.totalCost;
    }
    
    // 计算总预期利润
    const grandMinShares = Math.min(grandTotalUp, grandTotalDown);
    const grandProfit = grandMinShares - grandTotalCost;
    const grandProfitPercent = grandTotalCost > 0 ? (grandProfit / grandTotalCost) * 100 : 0;
    const grandProfitEmoji = grandProfit >= 0 ? '📈' : '📉';
    
    const message = `
📋 <b>持仓汇报</b> (${new Date().toLocaleTimeString('zh-CN')})

${groupLines.join('\n\n')}

━━━━━━━━━━━━━━━
<b>📊 总计:</b>
   • 总 Up: ${grandTotalUp.toFixed(0)} | 总 Down: ${grandTotalDown.toFixed(0)}
   • 总成本: $${grandTotalCost.toFixed(2)}
   • ${grandProfitEmoji} <b>预期盈亏: ${grandProfit >= 0 ? '+' : ''}$${grandProfit.toFixed(2)} (${grandProfitPercent >= 0 ? '+' : ''}${grandProfitPercent.toFixed(1)}%)</b>

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

/**
 * 发送单个事件结算通知
 * 每个事件单独发送，并标记是该事件类型的第几次结算
 */
export const notifySingleSettlement = async (
    result: SettlementResult,
    overallStats: {
        totalSettled: number;
        totalProfit: number;
        winCount: number;
        lossCount: number;
        winRate: number;
    }
): Promise<void> => {
    // 判断时间组
    const is15min = result.position.slug.includes('15m') || result.position.slug.includes('15min');
    const timeGroup = is15min ? '15min' : '1hr';
    const timeGroupLabel = is15min ? '15分钟' : '1小时';
    const groupIcon = is15min ? '⏱️' : '⏰';
    
    // 增加并获取该类型的结算次数
    const currentCount = (settlementCounters.get(timeGroup) || 0) + 1;
    settlementCounters.set(timeGroup, currentCount);
    
    // 判断资产类型
    const isBtcUp = result.position.slug.includes('btc') || result.position.slug.includes('bitcoin');
    const isEthUp = result.position.slug.includes('eth') || result.position.slug.includes('ethereum');
    const asset = isBtcUp ? 'BTC' : (isEthUp ? 'ETH' : 'Unknown');
    
    // 结果信息
    const outcomeEmoji = result.outcome === 'up' ? '⬆️' : '⬇️';
    const outcomeLabel = result.outcome === 'up' ? 'UP' : 'DOWN';
    const profitEmoji = result.profit >= 0 ? '🎉' : '😢';
    const profitSign = result.profit >= 0 ? '+' : '';
    const profitPercent = result.totalCost > 0 ? (result.profit / result.totalCost) * 100 : 0;
    
    // 累计统计
    const overallProfitEmoji = overallStats.totalProfit >= 0 ? '📈' : '📉';
    
    // 平衡度信息
    let balanceInfoStr = '';
    if (result.balanceInfo) {
        const bi = result.balanceInfo;
        balanceInfoStr = `
🛡️ <b>仓位平衡度:</b>
   • BTC: Up=${bi.btcUp.toFixed(0)} Down=${bi.btcDown.toFixed(0)} (${bi.btcBalancePercent.toFixed(1)}%)
   • ETH: Up=${bi.ethUp.toFixed(0)} Down=${bi.ethDown.toFixed(0)} (${bi.ethBalancePercent.toFixed(1)}%)
`;
    }

    const message = `
${profitEmoji} <b>${timeGroupLabel}场 第${currentCount}次结算</b>

${groupIcon} <b>${asset} ${timeGroupLabel}</b>
   结果: ${outcomeEmoji} <b>${outcomeLabel} 获胜</b>

💰 <b>本次盈亏:</b>
   • 成本: $${result.totalCost.toFixed(2)}
   • 收回: $${result.payout.toFixed(2)}
   • 盈亏: <b>${profitSign}$${result.profit.toFixed(2)}</b> (${profitSign}${profitPercent.toFixed(1)}%)
${balanceInfoStr}
━━━━━━━━━━━━━━━
<b>📊 累计统计:</b>
   • 已结算: ${overallStats.totalSettled} 个事件
   • 胜率: ${overallStats.winRate.toFixed(1)}% (${overallStats.winCount}胜/${overallStats.lossCount}负)
   • ${overallProfitEmoji} <b>累计盈亏: ${overallStats.totalProfit >= 0 ? '+' : ''}$${overallStats.totalProfit.toFixed(2)}</b>

${CONFIG.SIMULATION_MODE ? '⚠️ <i>模拟模式</i>' : ''}
`.trim();

    await sendTelegramMessage(message, true);  // 高优先级
};

/**
 * 重置结算计数器（可选，用于新一天开始时重置）
 */
export const resetSettlementCounters = (): void => {
    settlementCounters.clear();
};

/**
 * 发送批量结算通知（合并同时结算的多个事件）
 * 避免消息顺序混乱
 */
export const notifyBatchSettlement = async (
    results: Array<SettlementResult>,
    overallStats: {
        totalSettled: number;
        totalProfit: number;
        winCount: number;
        lossCount: number;
        winRate: number;
    }
): Promise<void> => {
    if (results.length === 0) return;
    
    // 按时间组分组
    const groups: Map<string, SettlementResult[]> = new Map();
    for (const result of results) {
        const is15min = result.position.slug.includes('15m') || result.position.slug.includes('15min');
        const timeGroup = is15min ? '15min' : '1hr';
        if (!groups.has(timeGroup)) {
            groups.set(timeGroup, []);
        }
        groups.get(timeGroup)!.push(result);
    }
    
    // 构建消息
    const groupLines: string[] = [];
    let batchTotalCost = 0;
    let batchTotalPayout = 0;
    let batchTotalProfit = 0;
    
    for (const [timeGroup, groupResults] of groups) {
        const outcomeEmoji = groupResults[0].outcome === 'up' ? '⬆️' : '⬇️';
        const groupIcon = timeGroup === '15min' ? '⏱️' : '⏰';
        
        let groupCost = 0;
        let groupPayout = 0;
        let groupProfit = 0;
        
        const details: string[] = [];
        for (const r of groupResults) {
            const isBtc = r.position.slug.includes('btc') || r.position.slug.includes('bitcoin');
            const asset = isBtc ? 'BTC' : 'ETH';
            const profitEmoji = r.profit >= 0 ? '✅' : '❌';
            details.push(`${asset}: ${profitEmoji}$${r.profit.toFixed(2)}`);
            
            groupCost += r.totalCost;
            groupPayout += r.payout;
            groupProfit += r.profit;
        }
        
        batchTotalCost += groupCost;
        batchTotalPayout += groupPayout;
        batchTotalProfit += groupProfit;
        
        const groupProfitEmoji = groupProfit >= 0 ? '✅' : '❌';
        const groupProfitPercent = groupCost > 0 ? (groupProfit / groupCost) * 100 : 0;
        
        groupLines.push(
            `${groupIcon} <b>${timeGroup === '15min' ? '15分钟组' : '1小时组'}</b> ${outcomeEmoji}${groupResults[0].outcome.toUpperCase()}获胜\n` +
            `   ${details.join(' | ')}\n` +
            `   💰 组合计: 成本$${groupCost.toFixed(2)} → 收回$${groupPayout.toFixed(2)} | ${groupProfitEmoji}${groupProfit >= 0 ? '+' : ''}$${groupProfit.toFixed(2)} (${groupProfitPercent >= 0 ? '+' : ''}${groupProfitPercent.toFixed(1)}%)`
        );
    }
    
    const batchProfitEmoji = batchTotalProfit >= 0 ? '🎉' : '😢';
    const batchProfitPercent = batchTotalCost > 0 ? (batchTotalProfit / batchTotalCost) * 100 : 0;
    const overallProfitEmoji = overallStats.totalProfit >= 0 ? '📈' : '📉';
    
    const message = `
${batchProfitEmoji} <b>事件结算通知</b> (${results.length}个事件)

${groupLines.join('\n\n')}

━━━━━━━━━━━━━━━
<b>📊 本批次合计:</b>
   • 成本: $${batchTotalCost.toFixed(2)} → 收回: $${batchTotalPayout.toFixed(2)}
   • 盈亏: ${batchTotalProfit >= 0 ? '+' : ''}$${batchTotalProfit.toFixed(2)} (${batchProfitPercent >= 0 ? '+' : ''}${batchProfitPercent.toFixed(1)}%)

<b>📊 累计统计:</b>
   • 已结算: ${overallStats.totalSettled} 个事件
   • 胜率: ${overallStats.winRate.toFixed(1)}% (${overallStats.winCount}胜/${overallStats.lossCount}负)
   • ${overallProfitEmoji} <b>累计盈亏: ${overallStats.totalProfit >= 0 ? '+' : ''}$${overallStats.totalProfit.toFixed(2)}</b>

${CONFIG.SIMULATION_MODE ? '⚠️ <i>模拟模式</i>' : ''}
`.trim();

    await sendTelegramMessage(message, true);  // 高优先级
};

/**
 * 发送运行统计（每10分钟）
 * 显示自启动以来的累计盈亏
 */
export const notifyRunningStats = async (stats: {
    runtime: number;           // 运行时间（分钟）
    totalSettled: number;      // 已结算事件数
    totalProfit: number;       // 累计盈亏
    winCount: number;          // 盈利次数
    lossCount: number;         // 亏损次数
    winRate: number;           // 胜率
    activePositions: number;   // 活跃仓位数
    pendingProfit: number;     // 待结算预期利润
    // 对冲统计（可选）
    hedgeEvents?: number;      // 触发对冲的事件数
    hedgeCompleted?: number;   // 成功保本的事件数
    hedgeCost?: number;        // 对冲总成本
}): Promise<void> => {
    const profitEmoji = stats.totalProfit >= 0 ? '📈' : '📉';
    const pendingEmoji = stats.pendingProfit >= 0 ? '✅' : '❌';
    
    const hours = Math.floor(stats.runtime / 60);
    const mins = stats.runtime % 60;
    const runtimeStr = hours > 0 ? `${hours}小时${mins}分钟` : `${mins}分钟`;
    
    // 对冲统计部分
    let hedgeSection = '';
    if (stats.hedgeEvents !== undefined && stats.hedgeEvents > 0) {
        const hedgeSuccessRate = stats.hedgeCompleted !== undefined && stats.hedgeEvents > 0
            ? ((stats.hedgeCompleted / stats.hedgeEvents) * 100).toFixed(0)
            : '0';
        hedgeSection = `

🛡️ <b>对冲保本:</b>
   • 触发: ${stats.hedgeEvents} 次
   • 成功保本: ${stats.hedgeCompleted || 0} 次 (${hedgeSuccessRate}%)
   • 对冲成本: $${(stats.hedgeCost || 0).toFixed(2)}`;
    }
    
    const message = `
📊 <b>运行统计</b> (${new Date().toLocaleTimeString('zh-CN')})

⏱️ <b>运行时间:</b> ${runtimeStr}

💰 <b>已结算:</b>
   • 事件数: ${stats.totalSettled}
   • 胜率: ${stats.winRate.toFixed(1)}% (${stats.winCount}胜/${stats.lossCount}负)
   • ${profitEmoji} <b>累计盈亏: ${stats.totalProfit >= 0 ? '+' : ''}$${stats.totalProfit.toFixed(2)}</b>

📋 <b>待结算:</b>
   • 活跃仓位: ${stats.activePositions} 个
   • ${pendingEmoji} 预期利润: ${stats.pendingProfit >= 0 ? '+' : ''}$${stats.pendingProfit.toFixed(2)}${hedgeSection}

${CONFIG.SIMULATION_MODE ? '⚠️ <i>模拟模式</i>' : '🔴 <i>实盘模式</i>'}
`.trim();

    await sendTelegramMessage(message);
};

/**
 * 发送止损通知（高优先级）
 */
export const notifyStopLoss = async (data: {
    timeGroup: string;
    reason: string;
    upShares: number;
    downShares: number;
    upBid: number;
    downBid: number;
    totalReceived: number;
    totalCost: number;
    savedLoss: number;
    isSimulation: boolean;
}): Promise<void> => {
    const actualLoss = data.totalCost - data.totalReceived;
    const worstCaseLoss = data.totalCost;  // 如果双输，亏损全部成本
    const savedAmount = worstCaseLoss - actualLoss;
    
    const message = `
🚨 <b>止损平仓通知</b>

⏱️ <b>时间组:</b> ${data.timeGroup}
⚠️ <b>触发原因:</b> ${data.reason}

📊 <b>平仓详情:</b>
   • 卖出 Up: ${data.upShares.toFixed(0)} shares @ $${data.upBid.toFixed(3)}
   • 卖出 Down: ${data.downShares.toFixed(0)} shares @ $${data.downBid.toFixed(3)}

💰 <b>收益情况:</b>
   • 成本: $${data.totalCost.toFixed(2)}
   • 回收: $${data.totalReceived.toFixed(2)}
   • 本次亏损: $${actualLoss.toFixed(2)}

💡 <b>止损效果:</b>
   • 如果不止损（双输）亏损: $${worstCaseLoss.toFixed(2)}
   • 止损减少亏损: <b>$${savedAmount.toFixed(2)}</b>

${data.isSimulation ? '⚠️ <i>模拟模式</i>' : '🔴 <i>实盘模式</i>'}
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
    notifyBatchSettlement,
    notifySingleSettlement,
    resetSettlementCounters,
    notifyRunningStats,
    notifyStopLoss,
};



