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
    // ========== 必填配置 ==========
    PRIVATE_KEY: process.env.PRIVATE_KEY as string,
    PROXY_WALLET: process.env.PROXY_WALLET as string,
    
    // ========== API 配置 ==========
    CLOB_HTTP_URL: process.env.CLOB_HTTP_URL || 'https://clob.polymarket.com',
    RPC_URL: process.env.RPC_URL || 'https://polygon-rpc.com',
    GAMMA_API: 'https://gamma-api.polymarket.com',
    
    // ========== Telegram 通知 ==========
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '7698365045:AAGaPd7zLHdb4Ky7Tw0NobpcRCpNKWk-648',
    TELEGRAM_GROUP_ID: process.env.TELEGRAM_GROUP_ID || '@rickyhutest',
    TELEGRAM_ENABLED: process.env.TELEGRAM_ENABLED !== 'false',
    
    // ========== 交易参数 ==========
    // 最小套利利润率（低于此值不交易）
    MIN_ARBITRAGE_PERCENT: parseFloat(process.env.MIN_ARBITRAGE_PERCENT || '0.1'),
    
    // 单笔订单金额范围
    MIN_ORDER_SIZE_USD: parseFloat(process.env.MIN_ORDER_SIZE_USD || '0.5'),
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
    // 每日最大交易次数
    MAX_DAILY_TRADES: parseInt(process.env.MAX_DAILY_TRADES || '3000'),
    
    // 模拟模式（true=不实际下单）
    SIMULATION_MODE: process.env.SIMULATION_MODE === 'true',
    
    // ========== 链配置 ==========
    CHAIN_ID: 137,
};

export default CONFIG;


