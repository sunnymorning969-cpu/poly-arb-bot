/**
 * 配置文件 - 套利机器人参数
 */

import * as dotenv from 'dotenv';
dotenv.config();

// 验证必要的环境变量
const requiredEnvVars = ['PRIVATE_KEY', 'PROXY_WALLET'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`❌ 缺少必要的环境变量: ${envVar}`);
        console.error('请复制 env-example.txt 为 .env 并填入配置');
        process.exit(1);
    }
}

export const CONFIG = {
    // 钱包配置
    PRIVATE_KEY: process.env.PRIVATE_KEY as string,
    PROXY_WALLET: process.env.PROXY_WALLET as string,
    
    // API 配置
    CLOB_HTTP_URL: process.env.CLOB_HTTP_URL || 'https://clob.polymarket.com',
    RPC_URL: process.env.RPC_URL || 'https://polygon-rpc.com',
    GAMMA_API: 'https://gamma-api.polymarket.com',
    
    // Telegram 配置
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '7698365045:AAGaPd7zLHdb4Ky7Tw0NobpcRCpNKWk-648',
    TELEGRAM_GROUP_ID: process.env.TELEGRAM_GROUP_ID || '@rickyhutest',
    TELEGRAM_ENABLED: process.env.TELEGRAM_ENABLED !== 'false',  // 默认开启
    
    // ========== 基于交易员数据分析的配置 ==========
    // 分析事件: BTC/ETH 15分钟(321/160笔) + BTC/ETH 1小时(1990/2520笔)
    
    // 事件级套利配置
    MIN_ARBITRAGE_PERCENT: parseFloat(process.env.MIN_ARBITRAGE_PERCENT || '0.1'),   // 最小利润0.1%（交易员几乎所有有利润的都做）
    MAX_COMBINED_COST: parseFloat(process.env.MAX_COMBINED_COST || '1.05'),          // 最大合计$1.05（分析显示部分交易Up+Down>$1）
    MIN_ORDER_SIZE_USD: parseFloat(process.env.MIN_ORDER_SIZE_USD || '0.5'),         // 最小$0.5（分析显示有$0.13的小单）
    MAX_ORDER_SIZE_USD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '14'),          // 最大$14（分析显示最大约$13.92）
    DEPTH_USAGE_PERCENT: parseFloat(process.env.DEPTH_USAGE_PERCENT || '90'),        // 使用90%深度（交易员吃单激进）
    SCAN_INTERVAL_MS: parseInt(process.env.SCAN_INTERVAL_MS || '50'),                // 50ms扫描
    
    // 单边买入阈值（基于分析：Up价格$0.08-$0.53，Down价格$0.33-$0.90）
    UP_PRICE_THRESHOLD: parseFloat(process.env.UP_PRICE_THRESHOLD || '0.55'),        // Up<$0.55时可单边买入
    DOWN_PRICE_THRESHOLD: parseFloat(process.env.DOWN_PRICE_THRESHOLD || '0.55'),    // Down<$0.55时可单边买入
    
    // 频率与冷却控制（分析显示交易间隔约2秒）
    TRADE_COOLDOWN_MS: parseInt(process.env.TRADE_COOLDOWN_MS || '5000'),             // 5秒冷却（比交易员略保守）
    MAX_PARALLEL_TRADES: parseInt(process.env.MAX_PARALLEL_TRADES || '8'),           // 最多8个并行（4个市场×2边）
    
    // 性能优化
    MARKET_CACHE_MS: parseInt(process.env.MARKET_CACHE_MS || '5000'),
    PARALLEL_ORDERBOOK_REQUESTS: parseInt(process.env.PARALLEL_ORDERBOOK_REQUESTS || '10'),
    
    // 安全配置（15分钟事件300+笔，1小时2000+笔）
    MAX_DAILY_TRADES: parseInt(process.env.MAX_DAILY_TRADES || '3000'),              // 每日3000笔上限
    MAX_DAILY_LOSS_USD: parseFloat(process.env.MAX_DAILY_LOSS_USD || '100'),         // 每日最大亏损$100
    SIMULATION_MODE: process.env.SIMULATION_MODE === 'true',
    
    // Polygon 链配置
    CHAIN_ID: 137,
};

export default CONFIG;
