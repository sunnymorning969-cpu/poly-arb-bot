/**
 * 配置文件 - 套利机器人参数
 */

import * as dotenv from 'dotenv';
dotenv.config();

// 判断是否模拟模式（在验证前先读取）
const isSimulation = process.env.SIMULATION_MODE === 'true';

// 验证必要的环境变量
// 模拟模式下不需要私钥和钱包地址
if (!isSimulation) {
    const requiredEnvVars = ['PRIVATE_KEY', 'PROXY_WALLET'];
    for (const envVar of requiredEnvVars) {
        if (!process.env[envVar]) {
            console.error(`❌ 缺少必要的环境变量: ${envVar}`);
            console.error('请复制 env-example.txt 为 .env 并填入配置');
            console.error('提示：如果只想测试，可以设置 SIMULATION_MODE=true 跳过此检查');
            process.exit(1);
        }
    }
}

export const CONFIG = {
    // ========== 必填配置（模拟模式可选）==========
    PRIVATE_KEY: process.env.PRIVATE_KEY || '',
    PROXY_WALLET: process.env.PROXY_WALLET || '',
    
    // ========== API 配置 ==========
    CLOB_HTTP_URL: process.env.CLOB_HTTP_URL || 'https://clob.polymarket.com',
    RPC_URL: process.env.RPC_URL || 'https://polygon-rpc.com',
    GAMMA_API: 'https://gamma-api.polymarket.com',
    
    // ========== Telegram 通知 ==========
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '7698365045:AAGaPd7zLHdb4Ky7Tw0NobpcRCpNKWk-648',
    TELEGRAM_GROUP_ID: process.env.TELEGRAM_GROUP_ID || '@rickyhutest',
    TELEGRAM_ENABLED: process.env.TELEGRAM_ENABLED !== 'false',
    
    // ========== 市场开关 ==========
    // 15分钟场开关（0=关闭，1=开启）
    ENABLE_15MIN: process.env.ENABLE_15MIN !== '0',
    // 1小时场开关（0=关闭，1=开启）
    ENABLE_1HR: process.env.ENABLE_1HR !== '0',
    
    // ========== 交易参数 ==========
    // Polymarket 最小订单金额（平台硬性要求，不可修改）
    MIN_ORDER_AMOUNT_USD: 1.0,
    
    // 出价容忍度（%）：实际出价比扫描价格高多少，提高成交率
    // 例如：扫描到 $0.60，容忍度 1%，实际出价 $0.606
    PRICE_TOLERANCE_PERCENT: parseFloat(process.env.PRICE_TOLERANCE_PERCENT || '0.5'),
    
    // 最小套利利润率（低于此值不交易）
    MIN_ARBITRAGE_PERCENT: parseFloat(process.env.MIN_ARBITRAGE_PERCENT || '0.1'),
    
    // 最大套利敞口 - 动态计算（开盘宽松，逐渐收紧）
    // 初始值（开盘第一分钟使用此值，允许较大敞口）
    // 例如：30 表示组合成本 > $0.70 就可以交易
    MAX_ARBITRAGE_PERCENT_INITIAL: parseFloat(process.env.MAX_ARBITRAGE_PERCENT_INITIAL || '30'),
    
    // 最终值（事件后期使用此值，敞口收紧）
    // 例如：15 表示组合成本 > $0.85 才可以交易
    MAX_ARBITRAGE_PERCENT_FINAL: parseFloat(process.env.MAX_ARBITRAGE_PERCENT_FINAL || '15'),
    
    // 收紧时长（分钟），在此时间内从初始值线性收紧到最终值
    MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES: parseInt(process.env.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES || '13'),
    
    // 最小套利利润金额（低于此值跳过，避免手续费亏损）
    MIN_PROFIT_USD: parseFloat(process.env.MIN_PROFIT_USD || '0.01'),
    
    // 单笔订单最大金额
    MAX_ORDER_SIZE_USD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '14'),
    
    // 使用订单簿深度的百分比
    DEPTH_USAGE_PERCENT: parseFloat(process.env.DEPTH_USAGE_PERCENT || '90'),
    
    // ========== 频率控制 ==========
    // 扫描间隔（毫秒）
    SCAN_INTERVAL_MS: parseInt(process.env.SCAN_INTERVAL_MS || '5'),
    
    // 同一市场交易冷却时间（毫秒）
    TRADE_COOLDOWN_MS: parseInt(process.env.TRADE_COOLDOWN_MS || '1000'),
    
    // 最大并行交易数
    MAX_PARALLEL_TRADES: parseInt(process.env.MAX_PARALLEL_TRADES || '8'),
    
    // ========== 安全限制 ==========
    // 每日最大交易次数（24小时约需 86400 次）
    MAX_DAILY_TRADES: parseInt(process.env.MAX_DAILY_TRADES || '100000'),
    
    // 模拟模式（true=不实际下单）
    SIMULATION_MODE: process.env.SIMULATION_MODE === 'true',
    
    // 启动时清除历史数据（true=从零开始）
    CLEAR_DATA_ON_START: process.env.CLEAR_DATA_ON_START === 'true',
    
    // ========== 止损配置 ==========
    // 止损功能开关
    STOP_LOSS_ENABLED: process.env.STOP_LOSS_ENABLED !== 'false',
    
    // 结束前多少秒开始监控止损（默认180秒=3分钟，即倒数第三分钟开始）
    STOP_LOSS_WINDOW_SEC: parseInt(process.env.STOP_LOSS_WINDOW_SEC || '180'),
    
    // 组合成本阈值（低于此值计入风险统计）
    // 支持两种输入格式：0.75 或 75 都表示 $0.75
    STOP_LOSS_COST_THRESHOLD: (() => {
        const val = parseFloat(process.env.STOP_LOSS_COST_THRESHOLD || '0.6');
        // 组合价格范围是 0-1，如果 > 1，视为百分比输入，自动除以 100
        return val > 1 ? val / 100 : val;
    })(),
    
    // 止损检查间隔（毫秒）
    STOP_LOSS_CHECK_INTERVAL_MS: parseInt(process.env.STOP_LOSS_CHECK_INTERVAL_MS || '1000'),
    
    // 风险比例阈值（低于阈值的次数占总检查次数的比例，超过此值触发止损）
    // 支持两种输入格式：0.7 或 70 都表示 70%，1 表示 1%
    STOP_LOSS_RISK_RATIO: (() => {
        const val = parseFloat(process.env.STOP_LOSS_RISK_RATIO || '0.7');
        // 如果 >= 1，视为百分比输入（1=1%, 70=70%），自动转换为小数
        return val >= 1 ? val / 100 : val;
    })(),
    
    // 止损模式：'sell' = 平仓止损，'hedge' = 对冲补仓保本
    STOP_LOSS_MODE: (process.env.STOP_LOSS_MODE || 'sell') as 'sell' | 'hedge',
    
    // 最小触发次数（风险次数的绝对值必须超过此值才触发止损）
    // 默认30次，避免样本太小误判
    STOP_LOSS_MIN_TRIGGER_COUNT: parseInt(process.env.STOP_LOSS_MIN_TRIGGER_COUNT || '30'),
    
    // ========== 币安波动率风控 ==========
    // 是否启用币安波动率检查（当 BTC 涨跌幅过小时触发对冲）
    BINANCE_VOLATILITY_CHECK_ENABLED: process.env.BINANCE_VOLATILITY_CHECK_ENABLED === 'true',
    
    // 距离事件结束多少秒开始检查（默认60秒=最后1分钟）
    BINANCE_CHECK_WINDOW_SEC: parseInt(process.env.BINANCE_CHECK_WINDOW_SEC || '60'),
    
    // 最小波动阈值（百分比），低于此值触发对冲（默认0.1%）
    // 例如：BTC 15分钟涨跌幅 < 0.1% 就触发
    BINANCE_MIN_VOLATILITY_PERCENT: parseFloat(process.env.BINANCE_MIN_VOLATILITY_PERCENT || '0.1'),
    
    // ========== 同池增持策略 ==========
    // 是否启用同池增持（在跨池套利的同时，利用平均持仓价在同池内套利）
    // 目的：逐步平衡每个池内的 Up/Down，减少止损时的亏损
    SAME_POOL_REBALANCE_ENABLED: process.env.SAME_POOL_REBALANCE_ENABLED === 'true',
    
    // 同池安全边际（%）：组合价必须 < 1 - margin 才买入，防止平均成本超过 1
    SAME_POOL_SAFETY_MARGIN: parseFloat(process.env.SAME_POOL_SAFETY_MARGIN || '2'),
    
    // ========== 紧急平衡（最后 X 秒强制平衡）==========
    // 是否启用紧急平衡
    EMERGENCY_BALANCE_ENABLED: process.env.EMERGENCY_BALANCE_ENABLED === 'true',
    // 最后多少秒进入紧急平衡模式
    EMERGENCY_BALANCE_SECONDS: parseInt(process.env.EMERGENCY_BALANCE_SECONDS || '20'),
    // 平衡度低于此阈值时触发紧急平衡（%）
    EMERGENCY_BALANCE_THRESHOLD: parseFloat(process.env.EMERGENCY_BALANCE_THRESHOLD || '60'),
    // 紧急平衡允许的最大亏损（%）：组合价可以放宽到 < 1 + maxLoss
    EMERGENCY_BALANCE_MAX_LOSS: parseFloat(process.env.EMERGENCY_BALANCE_MAX_LOSS || '5'),
    
    // ========== 极端不平衡提前平仓 ==========
    // 当平衡度极低时，说明走势确定，提前平掉不平衡部分
    EXTREME_IMBALANCE_ENABLED: process.env.EXTREME_IMBALANCE_ENABLED === 'true',
    // 最后多少秒检查极端不平衡
    EXTREME_IMBALANCE_SECONDS: parseInt(process.env.EXTREME_IMBALANCE_SECONDS || '90'),
    // 平衡度低于此值触发（%）
    EXTREME_IMBALANCE_THRESHOLD: parseFloat(process.env.EXTREME_IMBALANCE_THRESHOLD || '30'),
    
    // ========== 链配置 ==========
    CHAIN_ID: 137,
};

export default CONFIG;



