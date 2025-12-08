/**
 * 卖出所有持仓脚本
 * 
 * 运行: npx ts-node src/scripts/sell-all.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { ethers } from 'ethers';
import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import axios from 'axios';

// 配置
const CONFIG = {
    PRIVATE_KEY: process.env.PRIVATE_KEY as string,
    PROXY_WALLET: process.env.PROXY_WALLET as string,
    RPC_URL: process.env.RPC_URL || 'https://polygon-rpc.com',
    CLOB_HTTP_URL: 'https://clob.polymarket.com',
    CHAIN_ID: 137,
};

const DATA_API = 'https://data-api.polymarket.com';

// 颜色输出
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

const log = {
    info: (msg: string) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
    success: (msg: string) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
    warning: (msg: string) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
    error: (msg: string) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
};

// 验证配置
if (!CONFIG.PRIVATE_KEY || !CONFIG.PROXY_WALLET) {
    log.error('请先配置 .env 文件（PRIVATE_KEY 和 PROXY_WALLET）');
    process.exit(1);
}

/**
 * 初始化 CLOB Client
 */
const initClient = async (): Promise<ClobClient> => {
    const provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
    const wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
    
    const client = new ClobClient(
        CONFIG.CLOB_HTTP_URL,
        CONFIG.CHAIN_ID,
        wallet,
        undefined,
        SignatureType.POLY_GNOSIS_SAFE,
        CONFIG.PROXY_WALLET
    );
    
    await client.createOrDeriveApiKey();
    return client;
};

/**
 * 查询用户持仓
 */
const getUserPositions = async () => {
    const response = await axios.get(`${DATA_API}/positions`, {
        params: {
            user: CONFIG.PROXY_WALLET,
            sizeThreshold: 0.1,
        },
        timeout: 10000,
    });
    return response.data || [];
};

/**
 * 获取当前市场价格
 */
const getMarketPrice = async (client: ClobClient, tokenId: string): Promise<number> => {
    try {
        const book = await client.getOrderBook(tokenId);
        if (book.bids && book.bids.length > 0) {
            return parseFloat(book.bids[0].price);
        }
        return 0;
    } catch {
        return 0;
    }
};

/**
 * 卖出单个持仓
 */
const sellPosition = async (
    client: ClobClient,
    tokenId: string,
    size: number,
    title: string
): Promise<boolean> => {
    try {
        // 获取当前买一价
        const bidPrice = await getMarketPrice(client, tokenId);
        
        if (bidPrice <= 0) {
            log.warning(`${title}: 无买单，跳过`);
            return false;
        }
        
        // 稍微低于买一价挂单，确保成交
        const sellPrice = Math.max(0.01, bidPrice * 0.995);
        const amountUSD = size * sellPrice;
        
        log.info(`卖出: ${title}`);
        log.info(`   数量: ${size.toFixed(2)} shares @ $${sellPrice.toFixed(3)}`);
        log.info(`   预期收入: $${amountUSD.toFixed(2)}`);
        
        const orderArgs = {
            side: Side.SELL,
            tokenID: tokenId,
            amount: amountUSD,
            price: sellPrice,
        };
        
        const signedOrder = await client.createMarketOrder(orderArgs);
        const resp = await client.postOrder(signedOrder, OrderType.FOK);
        
        if (resp.success) {
            log.success(`✅ 卖出成功: ${title}`);
            return true;
        } else {
            log.warning(`❌ 卖出失败: ${title} - ${resp.errorMsg || '未知错误'}`);
            return false;
        }
    } catch (error: any) {
        log.error(`卖出出错: ${title} - ${error.message || error}`);
        return false;
    }
};

/**
 * 主函数
 */
const main = async () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║           💰 Polymarket 一键卖出所有持仓                   ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    
    log.info(`钱包: ${CONFIG.PROXY_WALLET}`);
    console.log('');
    
    // 查询持仓
    log.info('查询持仓中...');
    const positions = await getUserPositions();
    
    if (positions.length === 0) {
        log.info('没有持仓需要卖出');
        return;
    }
    
    log.info(`发现 ${positions.length} 个持仓:`);
    console.log('');
    
    // 显示持仓
    let totalValue = 0;
    for (const pos of positions) {
        console.log(`  • ${pos.title || pos.market}`);
        console.log(`    ${pos.outcome}: ${pos.size.toFixed(2)} shares @ $${pos.currentPrice?.toFixed(3) || '?'}`);
        console.log(`    价值: $${pos.currentValue?.toFixed(2) || '?'}`);
        totalValue += pos.currentValue || 0;
    }
    console.log('');
    log.info(`总价值: $${totalValue.toFixed(2)}`);
    console.log('');
    
    // 确认
    const readline = await import('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    
    const confirm = await new Promise<string>((resolve) => {
        rl.question('确认卖出所有持仓？(y/n): ', resolve);
    });
    rl.close();
    
    if (confirm.toLowerCase() !== 'y') {
        log.info('取消操作');
        return;
    }
    
    console.log('');
    log.info('初始化交易客户端...');
    const client = await initClient();
    
    // 卖出
    let success = 0;
    let failed = 0;
    
    for (const pos of positions) {
        const result = await sellPosition(
            client,
            pos.asset,
            pos.size,
            `${pos.title || pos.market} - ${pos.outcome}`
        );
        
        if (result) {
            success++;
        } else {
            failed++;
        }
        
        // 间隔
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    log.success(`完成! 成功: ${success}, 失败: ${failed}`);
    console.log('');
};

main().catch((error) => {
    log.error(`执行出错: ${error.message || error}`);
    process.exit(1);
});

