/**
 * USDC/USDC.e 授权脚本
 * 
 * 运行: npx ts-node src/scripts/approve.ts
 * 
 * 授权 USDC 和 USDC.e 给 Polymarket 合约，用于：
 * - 交易下单
 * - 卖出持仓
 * - 赎回仓位
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { ethers, BigNumber } from 'ethers';

// 配置
const CONFIG = {
    PRIVATE_KEY: process.env.PRIVATE_KEY as string,
    PROXY_WALLET: process.env.PROXY_WALLET as string,
    RPC_URL: process.env.RPC_URL || 'https://polygon-rpc.com',
};

// 代币地址
const TOKENS = {
    USDC_E: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',  // USDC.e (PoS Bridge)
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',    // Native USDC
};

// Polymarket 合约地址
const CONTRACTS = {
    CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8DB438C',        // 主交易所
    NEG_RISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a', // 负风险交易所
    NEG_RISK_ADAPTER: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',     // 负风险适配器
    CONDITIONAL_TOKENS: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',   // 条件代币合约
};

// ERC20 ABI
const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
];

// 无限授权额度
const MAX_APPROVAL = ethers.constants.MaxUint256;

// 颜色输出
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

const log = {
    info: (msg: string) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
    success: (msg: string) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
    warning: (msg: string) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
    error: (msg: string) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
    dim: (msg: string) => console.log(`${colors.dim}  ${msg}${colors.reset}`),
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
 * 检查授权额度
 */
const checkAllowance = async (
    wallet: ethers.Wallet,
    tokenAddress: string,
    spenderAddress: string
): Promise<BigNumber> => {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet.provider);
    return await token.allowance(CONFIG.PROXY_WALLET, spenderAddress);
};

/**
 * 执行授权
 */
const approveToken = async (
    wallet: ethers.Wallet,
    tokenAddress: string,
    tokenName: string,
    spenderAddress: string,
    spenderName: string
): Promise<boolean> => {
    try {
        // 先检查是否已授权
        const currentAllowance = await checkAllowance(wallet, tokenAddress, spenderAddress);
        
        if (currentAllowance.gt(ethers.utils.parseUnits('1000000', 6))) {
            log.success(`${tokenName} → ${spenderName}: 已授权 ✓`);
            return true;
        }
        
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        
        log.info(`${tokenName} → ${spenderName}: 授权中...`);
        
        // 获取 gas price
        const feeData = await wallet.provider.getFeeData();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
        const adjustedGasPrice = gasPrice ? gasPrice.mul(120).div(100) : undefined;
        
        const tx = await token.approve(spenderAddress, MAX_APPROVAL, {
            gasLimit: 100000,
            gasPrice: adjustedGasPrice,
        });
        
        log.dim(`交易: ${tx.hash}`);
        
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            log.success(`${tokenName} → ${spenderName}: 授权成功 ✓`);
            return true;
        } else {
            log.error(`${tokenName} → ${spenderName}: 授权失败`);
            return false;
        }
    } catch (error: any) {
        log.error(`${tokenName} → ${spenderName}: ${error.message || error}`);
        return false;
    }
};

/**
 * 获取代币余额
 */
const getTokenBalance = async (
    wallet: ethers.Wallet,
    tokenAddress: string
): Promise<string> => {
    try {
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet.provider);
        const balance = await token.balanceOf(CONFIG.PROXY_WALLET);
        const decimals = await token.decimals();
        return ethers.utils.formatUnits(balance, decimals);
    } catch {
        return '0';
    }
};

/**
 * 主函数
 */
const main = async () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║           🔐 Polymarket USDC 授权工具                      ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    
    log.info(`钱包: ${CONFIG.PROXY_WALLET}`);
    console.log('');
    
    const wallet = getWallet();
    
    // 显示余额
    log.info('查询余额...');
    const usdceBalance = await getTokenBalance(wallet, TOKENS.USDC_E);
    const usdcBalance = await getTokenBalance(wallet, TOKENS.USDC);
    const maticBalance = ethers.utils.formatEther(await wallet.provider.getBalance(wallet.address));
    
    console.log('');
    console.log(`  💵 USDC.e: $${parseFloat(usdceBalance).toFixed(2)}`);
    console.log(`  💵 USDC:   $${parseFloat(usdcBalance).toFixed(2)}`);
    console.log(`  ⛽ MATIC:  ${parseFloat(maticBalance).toFixed(4)}`);
    console.log('');
    
    // 检查 MATIC 余额
    if (parseFloat(maticBalance) < 0.01) {
        log.warning('MATIC 余额较低，可能无法完成授权交易');
    }
    
    // 授权列表
    const approvals = [
        // USDC.e 授权
        { token: TOKENS.USDC_E, tokenName: 'USDC.e', spender: CONTRACTS.CTF_EXCHANGE, spenderName: 'CTF Exchange' },
        { token: TOKENS.USDC_E, tokenName: 'USDC.e', spender: CONTRACTS.NEG_RISK_CTF_EXCHANGE, spenderName: 'Neg Risk Exchange' },
        { token: TOKENS.USDC_E, tokenName: 'USDC.e', spender: CONTRACTS.NEG_RISK_ADAPTER, spenderName: 'Neg Risk Adapter' },
        { token: TOKENS.USDC_E, tokenName: 'USDC.e', spender: CONTRACTS.CONDITIONAL_TOKENS, spenderName: 'CTF Contract' },
        // USDC 授权（新版）
        { token: TOKENS.USDC, tokenName: 'USDC', spender: CONTRACTS.CTF_EXCHANGE, spenderName: 'CTF Exchange' },
        { token: TOKENS.USDC, tokenName: 'USDC', spender: CONTRACTS.NEG_RISK_CTF_EXCHANGE, spenderName: 'Neg Risk Exchange' },
        { token: TOKENS.USDC, tokenName: 'USDC', spender: CONTRACTS.NEG_RISK_ADAPTER, spenderName: 'Neg Risk Adapter' },
        { token: TOKENS.USDC, tokenName: 'USDC', spender: CONTRACTS.CONDITIONAL_TOKENS, spenderName: 'CTF Contract' },
    ];
    
    log.info('开始授权检查...');
    console.log('');
    
    let success = 0;
    let failed = 0;
    
    for (const { token, tokenName, spender, spenderName } of approvals) {
        const result = await approveToken(wallet, token, tokenName, spender, spenderName);
        if (result) {
            success++;
        } else {
            failed++;
        }
        // 间隔避免 nonce 问题
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    if (failed === 0) {
        log.success(`全部完成! ${success} 项授权已确认`);
    } else {
        log.warning(`完成: ${success} 成功, ${failed} 失败`);
    }
    console.log('');
};

main().catch((error) => {
    log.error(`执行出错: ${error.message || error}`);
    process.exit(1);
});
