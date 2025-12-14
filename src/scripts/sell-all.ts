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
 * 检测是否为 Gnosis Safe 钱包
 */
const isGnosisSafe = async (address: string): Promise<boolean> => {
    try {
        const provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
        const code = await provider.getCode(address);
        return code !== '0x';
    } catch {
        return false;
    }
};

/**
 * 初始化 CLOB Client（和主程序保持一致）
 */
const initClient = async (): Promise<ClobClient> => {
    // 检测钱包类型
    const isProxySafe = CONFIG.PROXY_WALLET ? await isGnosisSafe(CONFIG.PROXY_WALLET) : false;
    const signatureType = isProxySafe ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
    
    log.info(`钱包类型: ${isProxySafe ? 'Gnosis Safe' : 'EOA'}`);
    
    // 使用不带 provider 的 wallet（CLOB client 需要）
    const clobWallet = new ethers.Wallet(CONFIG.PRIVATE_KEY);
    
    // 创建临时 client 获取 API Key
    let client = new ClobClient(
        CONFIG.CLOB_HTTP_URL,
        CONFIG.CHAIN_ID,
        clobWallet,
        undefined,
        signatureType,
        isProxySafe ? CONFIG.PROXY_WALLET : undefined
    );
    
    // 获取 API Key
    let creds: any;
    try {
        creds = await client.createApiKey();
    } catch {
        // createApiKey 失败
    }
    
    if (!creds?.key) {
        try {
            creds = await client.deriveApiKey();
        } catch {
            // deriveApiKey 也失败
        }
    }
    
    if (!creds?.key) {
        throw new Error('无法获取 API Key，请检查钱包配置');
    }
    
    // 使用 API Key 创建正式 client
    return new ClobClient(
        CONFIG.CLOB_HTTP_URL,
        CONFIG.CHAIN_ID,
        clobWallet,
        creds,
        signatureType,
        isProxySafe ? CONFIG.PROXY_WALLET : undefined
    );
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
 * 卖出单个持仓（循环吃单直到全部卖出）
 */
const sellPosition = async (
    client: ClobClient,
    tokenId: string,
    size: number,
    title: string
): Promise<boolean> => {
    let remaining = size;
    let totalSold = 0;
    let totalReceived = 0;
    const maxRetries = 10;
    let retries = 0;
    
    log.info(`卖出: ${title}`);
    log.info(`   目标: ${size.toFixed(2)} shares`);
    
    while (remaining > 0.1 && retries < maxRetries) {
        try {
            // 获取订单簿
            log.info(`   🔍 查询订单簿: tokenId=${tokenId.slice(0, 20)}...`);
            const book = await client.getOrderBook(tokenId);
            
            // 🔍 调试：打印订单簿原始数据
            log.info(`   🔍 订单簿: bids=${book.bids?.length || 0}个 asks=${book.asks?.length || 0}个`);
            if (book.bids && book.bids.length > 0) {
                log.info(`   🔍 买一: ${JSON.stringify(book.bids[0])}`);
            }
            
            if (!book.bids || book.bids.length === 0) {
                log.warning(`   无买单，可能已结算，请用 npm run redeem-all 赎回`);
                break;
            }
            
            // 获取买一价和深度
            const bestBid = book.bids[0];
            const bidPrice = parseFloat(bestBid.price);
            const bidSize = parseFloat(bestBid.size);
            
            log.info(`   🔍 解析: bidPrice=${bidPrice} bidSize=${bidSize}`);
            
            if (bidPrice <= 0.01) {
                log.warning(`   价格过低 ($${bidPrice.toFixed(3)})，可能已结算`);
                break;
            }
            
            // 本次卖出数量（不超过买一深度）
            const sellSize = Math.min(remaining, bidSize);
            const expectedValue = sellSize * bidPrice;
            
            // 检查最小订单金额
            if (expectedValue < 1) {
                log.warning(`   剩余 ${remaining.toFixed(2)} shares 价值 < $1，跳过`);
                break;
            }
            
            log.info(`   📤 卖出 ${sellSize.toFixed(2)} shares @ $${bidPrice.toFixed(3)} (预期 $${expectedValue.toFixed(2)})`);
            
            // 🔧 修复：卖出订单的 amount 应该是 USD 金额（shares * price）
            // 稍微降低价格确保成交
            const sellPrice = Math.floor(Math.max(0.01, bidPrice * 0.995) * 100) / 100;
            const amountUSD = Math.floor(sellSize * sellPrice * 100) / 100;
            
            const orderArgs = {
                side: Side.SELL,
                tokenID: tokenId,
                amount: amountUSD,  // USD 金额
                price: sellPrice,   // 稍低于买一价，确保成交
            };
            
            log.info(`   🔍 下单参数: amount=${amountUSD} price=${sellPrice}`);
            
            const signedOrder = await client.createMarketOrder(orderArgs);
            const resp = await client.postOrder(signedOrder, OrderType.FAK);  // FAK 允许部分成交
            
            if (resp.success) {
                // 🔧 修复：使用 API 返回的实际成交数量
                // SELL 订单：takingAmount 是收到的 USDC，makingAmount 是卖出的 shares
                let actualSold = sellSize;
                let actualReceived = expectedValue;
                
                if (resp.makingAmount) {
                    const rawSold = parseFloat(resp.makingAmount);
                    // 智能判断单位
                    actualSold = rawSold > 1000 ? rawSold / 1e6 : rawSold;
                }
                if (resp.takingAmount) {
                    const rawReceived = parseFloat(resp.takingAmount);
                    actualReceived = rawReceived > 1000 ? rawReceived / 1e6 : rawReceived;
                }
                
                if (actualSold < 0.01) {
                    retries++;
                    log.warning(`   ⚠️ 成交0 shares (${retries}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                
                totalSold += actualSold;
                totalReceived += actualReceived;
                remaining -= actualSold;
                retries = 0;  // 成功后重置重试计数
                log.success(`   ✅ 成交 ${actualSold.toFixed(2)} shares @ $${(actualReceived/actualSold).toFixed(3)} = $${actualReceived.toFixed(2)}`);
                
                if (remaining > 0.1) {
                    log.info(`   剩余 ${remaining.toFixed(2)} shares...`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            } else {
                retries++;
                log.warning(`   ⚠️ 未成交 (${retries}/${maxRetries})，重试...`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error: any) {
            retries++;
            const errMsg = error?.response?.data?.error || error?.message || '';
            log.warning(`   ⚠️ 出错 (${retries}/${maxRetries}): ${errMsg}`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    if (totalSold > 0) {
        log.success(`✅ ${title}: 共卖出 ${totalSold.toFixed(2)} shares，收入 $${totalReceived.toFixed(2)}`);
        return true;
    } else {
        log.error(`❌ ${title}: 卖出失败`);
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


