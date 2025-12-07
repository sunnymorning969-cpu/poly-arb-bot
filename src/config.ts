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
    
    // 套利配置
    MIN_ARBITRAGE_PERCENT: parseFloat(process.env.MIN_ARBITRAGE_PERCENT || '0.5'),
    MIN_ORDER_SIZE_USD: parseFloat(process.env.MIN_ORDER_SIZE_USD || '1'),      // 最小下单金额
    MAX_ORDER_SIZE_USD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '15'),     // 最大下单金额（参考trader的$1-15）
    DEPTH_USAGE_PERCENT: parseFloat(process.env.DEPTH_USAGE_PERCENT || '80'),   // 使用深度的百分比
    SCAN_INTERVAL_MS: parseInt(process.env.SCAN_INTERVAL_MS || '50'),  // 毫秒级扫描，默认50ms
    
    // 单边价格阈值（价格低于此值时优先买入）
    UP_PRICE_THRESHOLD: parseFloat(process.env.UP_PRICE_THRESHOLD || '0.30'),   // Up价格阈值
    DOWN_PRICE_THRESHOLD: parseFloat(process.env.DOWN_PRICE_THRESHOLD || '0.70'), // Down价格阈值
    
    // 并行下单
    MAX_PARALLEL_TRADES: parseInt(process.env.MAX_PARALLEL_TRADES || '5'),  // 最多同时在几个市场下单
    
    // 性能优化
    MARKET_CACHE_MS: parseInt(process.env.MARKET_CACHE_MS || '5000'),  // 市场列表缓存5秒
    PARALLEL_ORDERBOOK_REQUESTS: parseInt(process.env.PARALLEL_ORDERBOOK_REQUESTS || '10'),  // 并行请求数
    
    // 安全配置
    MAX_DAILY_TRADES: parseInt(process.env.MAX_DAILY_TRADES || '100'),
    MAX_DAILY_LOSS_USD: parseFloat(process.env.MAX_DAILY_LOSS_USD || '50'),
    SIMULATION_MODE: process.env.SIMULATION_MODE === 'true',
    
    // Polygon 链配置
    CHAIN_ID: 137,
};

export default CONFIG;
