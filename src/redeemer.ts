/**
 * 赎回模块 - 自动赎回已结算的仓位
 * 参考: poly-bot/src/services/autoRedeemer.ts
 */

import { ethers } from 'ethers';
import axios from 'axios';
import CONFIG from './config';
import Logger from './logger';

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

// CTF 合约 ABI（只需要 redeemPositions）
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
    'function balanceOf(address owner, uint256 tokenId) external view returns (uint256)',
];

// Data API
const DATA_API = 'https://data-api.polymarket.com';

// 判断仓位是否已结算的阈值
const RESOLVED_HIGH = 0.99;  // 价格接近 $1 = 赢了
const RESOLVED_LOW = 0.01;   // 价格接近 $0 = 输了
const ZERO_THRESHOLD = 0.0001;

// 缓存 provider 和 wallet
let provider: ethers.providers.JsonRpcProvider | null = null;
let wallet: ethers.Wallet | null = null;

/**
 * 获取 Provider 和 Wallet
 */
const getWallet = (): ethers.Wallet => {
    if (!provider) {
        provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
    }
    if (!wallet) {
        wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
    }
    return wallet;
};

/**
 * 用户持仓信息
 */
export interface UserPosition {
    conditionId: string;
    asset: string;  // token_id
    outcome: string;  // 'Yes' or 'No'
    size: number;
    avgPrice: number;
    currentPrice: number;
    initialValue: number;
    currentValue: number;
    pnl: number;
    redeemable: boolean;
    mergeable: boolean;
    market: string;  // market slug
    title: string;
}

/**
 * 查询用户所有持仓
 */
export const getUserPositions = async (sizeThreshold: number = 0.1): Promise<UserPosition[]> => {
    try {
        const response = await axios.get(`${DATA_API}/positions`, {
            params: {
                user: CONFIG.PROXY_WALLET,
                sizeThreshold,
            },
            timeout: 10000,
        });
        
        return response.data || [];
    } catch (error) {
        Logger.error(`查询持仓失败: ${error}`);
        return [];
    }
};

/**
 * 查询可赎回的持仓
 * 过滤条件：
 * 1. redeemable === true（API 标记）
 * 2. curPrice >= 0.99 或 <= 0.01（已结算）
 * 3. size > 0.0001（有余额）
 */
export const getRedeemablePositions = async (): Promise<UserPosition[]> => {
    try {
        // 先获取所有持仓
        const response = await axios.get(`${DATA_API}/positions`, {
            params: {
                user: CONFIG.PROXY_WALLET,
                sizeThreshold: ZERO_THRESHOLD,
            },
            timeout: 10000,
        });
        
        const allPositions: UserPosition[] = response.data || [];
        
        // 过滤：已结算 + 可赎回
        const redeemable = allPositions.filter(pos => 
            pos.redeemable === true &&
            (pos.currentPrice >= RESOLVED_HIGH || pos.currentPrice <= RESOLVED_LOW) &&
            pos.size > ZERO_THRESHOLD
        );
        
        return redeemable;
    } catch (error) {
        Logger.error(`查询可赎回持仓失败: ${error}`);
        return [];
    }
};

/**
 * 赎回单个仓位
 * 注意：conditionId 需要转换为 bytes32 格式
 */
export const redeemPosition = async (conditionId: string, title?: string): Promise<boolean> => {
    if (CONFIG.SIMULATION_MODE) {
        Logger.info(`[模拟] 跳过赎回: ${conditionId.slice(0, 10)}...`);
        return true;
    }
    
    try {
        const signer = getWallet();
        const ctf = new ethers.Contract(CONTRACTS.CONDITIONAL_TOKENS, CTF_ABI, signer);
        
        // ⚠️ 关键：将 conditionId 转换为 bytes32 格式
        const conditionIdBytes32 = ethers.utils.hexZeroPad(
            ethers.BigNumber.from(conditionId).toHexString(),
            32
        );
        
        // parentCollectionId 固定为 0
        const parentCollectionId = ethers.constants.HashZero;
        // indexSets: [1, 2] 表示赎回两个 outcome
        const indexSets = [1, 2];
        
        Logger.info(`💰 赎回仓位: ${title || conditionId.slice(0, 10)}...`);
        
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
        
        Logger.info(`   ⏳ 交易已提交: ${tx.hash.slice(0, 20)}...`);
        
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            Logger.success(`✅ 赎回成功: ${title || conditionId.slice(0, 10)}... | Gas: ${receipt.gasUsed.toString()}`);
            return true;
        } else {
            Logger.error(`❌ 赎回失败: ${title || conditionId.slice(0, 10)}...`);
            return false;
        }
    } catch (error: any) {
        // 如果是 "nothing to redeem" 类型的错误，不算失败
        if (error.message?.includes('nothing') || error.message?.includes('zero')) {
            Logger.debug(`ℹ️ 无需赎回: ${conditionId.slice(0, 10)}...`);
            return true;
        }
        Logger.error(`❌ 赎回出错: ${error.message || error}`);
        return false;
    }
};

/**
 * 赎回所有可赎回的仓位
 */
export const redeemAllPositions = async (): Promise<{ success: number; failed: number; total: number }> => {
    const positions = await getRedeemablePositions();
    
    if (positions.length === 0) {
        return { success: 0, failed: 0, total: 0 };
    }
    
    Logger.info(`🔍 发现 ${positions.length} 个可赎回仓位`);
    
    // 按 conditionId 去重（同一个市场可能有多个 outcome）
    const conditionIds = [...new Set(positions.map(p => p.conditionId))];
    
    let success = 0;
    let failed = 0;
    
    for (const conditionId of conditionIds) {
        const result = await redeemPosition(conditionId);
        if (result) {
            success++;
        } else {
            failed++;
        }
        // 间隔一下，避免 nonce 冲突
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    return { success, failed, total: conditionIds.length };
};

// 记录上次检查时间
let lastRedeemCheck = 0;

/**
 * 定期检查并赎回（在主循环中调用）
 */
export const checkAndRedeem = async (): Promise<void> => {
    const now = Date.now();
    
    // 每 5 秒检查一次
    if (now - lastRedeemCheck < 5000) {
        return;
    }
    lastRedeemCheck = now;
    
    try {
        const positions = await getRedeemablePositions();
        
        if (positions.length === 0) {
            return;
        }
        
        // 按 conditionId 分组（同一个市场可能有多个 outcome）
        const positionsByCondition = new Map<string, UserPosition[]>();
        for (const pos of positions) {
            const existing = positionsByCondition.get(pos.conditionId) || [];
            existing.push(pos);
            positionsByCondition.set(pos.conditionId, existing);
        }
        
        Logger.info(`💰 发现 ${positionsByCondition.size} 个可赎回仓位，开始赎回...`);
        
        for (const [conditionId, groupPositions] of positionsByCondition.entries()) {
            const pos = groupPositions[0];
            const totalValue = groupPositions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
            const status = pos.currentPrice >= RESOLVED_HIGH ? '🎉 赢' : '❌ 输';
            
            Logger.info(`   ${status} ${pos.title || pos.market} | 预期: $${totalValue.toFixed(2)}`);
            
            await redeemPosition(conditionId, pos.title || pos.market);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    } catch (error) {
        // 静默处理错误，不影响主循环
    }
};

export default {
    getUserPositions,
    getRedeemablePositions,
    redeemPosition,
    redeemAllPositions,
    checkAndRedeem,
};

