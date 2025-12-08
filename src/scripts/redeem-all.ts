/**
 * 赎回所有可赎回仓位脚本
 * 
 * 运行: npx ts-node src/scripts/redeem-all.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { ethers } from 'ethers';
import axios from 'axios';

// 配置
const CONFIG = {
    PRIVATE_KEY: process.env.PRIVATE_KEY as string,
    PROXY_WALLET: process.env.PROXY_WALLET as string,
    RPC_URL: process.env.RPC_URL || 'https://polygon-rpc.com',
};

// 使用 getAddress 确保 checksum 正确
const toChecksumAddress = (addr: string): string => {
    try {
        return ethers.utils.getAddress(addr.toLowerCase());
    } catch {
        return addr;
    }
};

// 合约地址（确保 checksum 正确）
const CONTRACTS = {
    USDC_E: toChecksumAddress('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'),
    CONDITIONAL_TOKENS: toChecksumAddress('0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'),
};

// CTF 合约 ABI
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];

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
 * 获取 Wallet
 */
const getWallet = (): ethers.Wallet => {
    const provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
    return new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
};

/**
 * 查询可赎回持仓
 */
const getRedeemablePositions = async () => {
    const response = await axios.get(`${DATA_API}/positions`, {
        params: {
            user: CONFIG.PROXY_WALLET,
            redeemable: true,
            sizeThreshold: 0.1,
        },
        timeout: 10000,
    });
    return response.data || [];
};

/**
 * 赎回单个仓位
 * 注意：conditionId 需要转换为 bytes32 格式
 */
const redeemPosition = async (
    wallet: ethers.Wallet,
    conditionId: string,
    title: string
): Promise<boolean> => {
    try {
        const ctf = new ethers.Contract(CONTRACTS.CONDITIONAL_TOKENS, CTF_ABI, wallet);
        
        // ⚠️ 关键：将 conditionId 转换为 bytes32 格式
        const conditionIdBytes32 = ethers.utils.hexZeroPad(
            ethers.BigNumber.from(conditionId).toHexString(),
            32
        );
        
        const parentCollectionId = ethers.constants.HashZero;
        const indexSets = [1, 2];
        
        log.info(`赎回: ${title}`);
        log.info(`   conditionId: ${conditionId.slice(0, 20)}...`);
        
        // 获取当前 gas price 并加 20% buffer
        const feeData = await ctf.provider.getFeeData();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
        
        if (!gasPrice) {
            throw new Error('无法获取 gas price');
        }
        
        const adjustedGasPrice = gasPrice.mul(120).div(100);
        
        const tx = await ctf.redeemPositions(
            CONTRACTS.USDC_E,
            parentCollectionId,
            conditionIdBytes32,
            indexSets,
            { 
                gasLimit: 500000,
                gasPrice: adjustedGasPrice,
            }
        );
        
        log.info(`   等待确认: ${tx.hash.slice(0, 20)}...`);
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            log.success(`✅ 赎回成功: ${title} | Gas: ${receipt.gasUsed.toString()}`);
            return true;
        } else {
            log.error(`❌ 赎回失败: ${title}`);
            return false;
        }
    } catch (error: any) {
        if (error.message?.includes('nothing') || error.message?.includes('zero')) {
            log.warning(`无需赎回: ${title} (已赎回或无余额)`);
            return true;
        }
        log.error(`赎回出错: ${title} - ${error.message || error}`);
        return false;
    }
};

/**
 * 主函数
 */
const main = async () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║           💎 Polymarket 一键赎回所有仓位                   ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    
    log.info(`钱包: ${CONFIG.PROXY_WALLET}`);
    console.log('');
    
    // 查询可赎回持仓
    log.info('查询可赎回仓位中...');
    const positions = await getRedeemablePositions();
    
    if (positions.length === 0) {
        log.info('没有可赎回的仓位');
        return;
    }
    
    // 按 conditionId 去重
    const conditionMap = new Map<string, any>();
    for (const pos of positions) {
        if (!conditionMap.has(pos.conditionId)) {
            conditionMap.set(pos.conditionId, pos);
        }
    }
    
    const uniquePositions = Array.from(conditionMap.values());
    
    log.info(`发现 ${uniquePositions.length} 个可赎回仓位:`);
    console.log('');
    
    // 显示仓位
    let totalValue = 0;
    for (const pos of uniquePositions) {
        console.log(`  • ${pos.title || pos.market}`);
        console.log(`    ${pos.outcome}: ${pos.size.toFixed(2)} shares`);
        console.log(`    预期收回: $${pos.currentValue?.toFixed(2) || '?'}`);
        totalValue += pos.currentValue || 0;
    }
    console.log('');
    log.info(`预计总收回: $${totalValue.toFixed(2)}`);
    console.log('');
    
    // 确认
    const readline = await import('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    
    const confirm = await new Promise<string>((resolve) => {
        rl.question('确认赎回所有仓位？(y/n): ', resolve);
    });
    rl.close();
    
    if (confirm.toLowerCase() !== 'y') {
        log.info('取消操作');
        return;
    }
    
    console.log('');
    log.info('开始赎回...');
    
    const wallet = getWallet();
    
    // 赎回
    let success = 0;
    let failed = 0;
    
    for (const pos of uniquePositions) {
        const result = await redeemPosition(
            wallet,
            pos.conditionId,
            pos.title || pos.market
        );
        
        if (result) {
            success++;
        } else {
            failed++;
        }
        
        // 间隔，避免 nonce 问题
        await new Promise(resolve => setTimeout(resolve, 2000));
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


