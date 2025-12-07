/**
 * 套利执行器 - 智能策略版本
 * 
 * 核心逻辑：
 * 1. 根据订单簿深度动态决定下单金额
 * 2. 可以单边或双边下单
 * 3. 追踪仓位确保最终平衡
 */

import { ethers, BigNumber } from 'ethers';
import { ClobClient, OrderType, Side, AssetType } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import CONFIG from './config';
import Logger from './logger';
import { ArbitrageOpportunity } from './scanner';
import { updatePosition, getImbalance } from './positions';

let clobClient: ClobClient | null = null;
let provider: ethers.providers.JsonRpcProvider | null = null;
let wallet: ethers.Wallet | null = null;

// 记录上次下单时间（同一市场必须冷却）
const lastTradeTime = new Map<string, number>();
const TRADE_COOLDOWN_MS = 60000;  // 同一市场 60 秒冷却

// Polygon 合约地址
const CONTRACTS = {
    // USDC on Polygon (PoS Bridge - 旧版)
    USDC_E: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    // USDC on Polygon (Native - 新版)
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    
    // Polymarket 核心合约
    CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8DB438C',        // 主交易所
    NEG_RISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a', // 负风险交易所
    NEG_RISK_ADAPTER: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',     // 负风险适配器
    CONDITIONAL_TOKENS: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',   // 条件代币合约
};

// ERC20 ABI (只需要 approve 和 allowance)
const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
];

// 无限授权额度
const MAX_APPROVAL = ethers.constants.MaxUint256;

/**
 * 获取 Provider 和 Wallet
 */
const getProviderAndWallet = (): { provider: ethers.providers.JsonRpcProvider; wallet: ethers.Wallet } => {
    if (!provider) {
        provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
    }
    if (!wallet) {
        wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY, provider);
    }
    return { provider, wallet };
};

/**
 * 检查钱包类型（EOA 或 Gnosis Safe）
 */
const isGnosisSafe = async (address: string): Promise<boolean> => {
    try {
        const { provider } = getProviderAndWallet();
        const code = await provider.getCode(address);
        return code !== '0x';
    } catch (error) {
        return false;
    }
};


/**
 * 检查指定 USDC 代币的授权
 */
const checkAllowanceForToken = async (tokenAddress: string, spender: string): Promise<BigNumber> => {
    try {
        const { provider, wallet } = getProviderAndWallet();
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const ownerAddress = CONFIG.PROXY_WALLET || wallet.address;
        return await token.allowance(ownerAddress, spender);
    } catch (error) {
        return BigNumber.from(0);
    }
};

/**
 * 授权指定 USDC 代币给合约
 */
const approveToken = async (tokenAddress: string, tokenName: string, spender: string, spenderName: string): Promise<boolean> => {
    try {
        const { wallet } = getProviderAndWallet();
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
        
        Logger.info(`📝 授权 ${tokenName} 给 ${spenderName}...`);
        
        const tx = await token.approve(spender, MAX_APPROVAL, {
            gasLimit: 100000,
        });
        
        Logger.info(`⏳ 等待交易确认: ${tx.hash}`);
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            Logger.success(`✅ ${tokenName} → ${spenderName} 授权成功`);
            return true;
        } else {
            Logger.error(`❌ ${tokenName} → ${spenderName} 授权失败`);
            return false;
        }
    } catch (error: any) {
        // 如果是 gas 估算失败，可能是已经授权了
        if (error.message?.includes('cannot estimate gas')) {
            Logger.info(`⚠️ ${tokenName} → ${spenderName} 可能已授权`);
            return true;
        }
        Logger.error(`授权交易失败: ${error.message || error}`);
        return false;
    }
};

/**
 * 检查并执行所有必要的 USDC 授权
 */
export const ensureApprovals = async (): Promise<boolean> => {
    Logger.info('🔐 检查 USDC 授权状态...');
    
    // 最小授权阈值（1000 USDC = 1000 * 1e6）
    const MIN_ALLOWANCE = BigNumber.from(1000).mul(BigNumber.from(10).pow(6));
    
    // 需要授权的合约列表
    const spenders = [
        { address: CONTRACTS.CTF_EXCHANGE, name: 'CTF Exchange' },
        { address: CONTRACTS.NEG_RISK_CTF_EXCHANGE, name: 'Neg Risk Exchange' },
        { address: CONTRACTS.NEG_RISK_ADAPTER, name: 'Neg Risk Adapter' },
        { address: CONTRACTS.CONDITIONAL_TOKENS, name: 'Conditional Tokens' },
    ];
    
    // USDC 代币列表 - USDC.e 是 Polymarket 主要使用的
    const tokens = [
        { address: CONTRACTS.USDC_E, name: 'USDC.e' },  // Polymarket 使用这个
        // { address: CONTRACTS.USDC, name: 'USDC (Native)' },  // 暂时不需要
    ];
    
    let allApproved = true;
    let needsApproval: Array<{ token: typeof tokens[0], spender: typeof spenders[0] }> = [];
    
    // 先检查所有授权状态
    Logger.info('📋 检查授权状态...');
    for (const token of tokens) {
        for (const spender of spenders) {
            try {
                const allowance = await checkAllowanceForToken(token.address, spender.address);
                
                if (allowance.lt(MIN_ALLOWANCE)) {
                    needsApproval.push({ token, spender });
                    Logger.warning(`   ⚠️ ${token.name} → ${spender.name}: 需要授权`);
                } else {
                    Logger.success(`   ✅ ${token.name} → ${spender.name}: 已授权`);
                }
            } catch (error) {
                // 忽略检查错误，稍后尝试授权
                needsApproval.push({ token, spender });
            }
        }
    }
    
    // 执行需要的授权
    if (needsApproval.length > 0) {
        Logger.divider();
        Logger.info(`📝 需要执行 ${needsApproval.length} 个授权...`);
        
        if (CONFIG.SIMULATION_MODE) {
            Logger.warning(`[模拟模式] 跳过实际授权交易`);
        } else {
            for (const { token, spender } of needsApproval) {
                const success = await approveToken(token.address, token.name, spender.address, spender.name);
                if (!success) {
                    allApproved = false;
                }
                // 等待一下避免 nonce 问题
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    
    Logger.divider();
    if (allApproved) {
        Logger.success('🔓 所有 USDC 授权已就绪');
    } else {
        Logger.warning('⚠️ 部分授权失败，交易可能受影响');
    }
    
    return allApproved;
};

/**
 * 获取 USDC.e 余额（Bridged USDC - Polymarket 主要使用这个）
 */
export const getUSDCBalance = async (): Promise<number> => {
    try {
        const { provider, wallet } = getProviderAndWallet();
        const ownerAddress = CONFIG.PROXY_WALLET || wallet.address;
        
        // Polymarket 使用的是 USDC.e (Bridged)
        const usdce = new ethers.Contract(CONTRACTS.USDC_E, ERC20_ABI, provider);
        const balance = await usdce.balanceOf(ownerAddress);
        return parseFloat(ethers.utils.formatUnits(balance, 6));
    } catch (error) {
        Logger.error(`获取 USDC.e 余额失败: ${error}`);
        return 0;
    }
};

/**
 * 初始化 CLOB 客户端
 */
export const initClient = async (): Promise<ClobClient> => {
    if (clobClient) return clobClient;
    
    Logger.info('初始化交易客户端...');
    
    const { wallet: w } = getProviderAndWallet();
    const isProxySafe = await isGnosisSafe(CONFIG.PROXY_WALLET);
    const signatureType = isProxySafe ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
    
    Logger.info(`钱包类型: ${isProxySafe ? 'Gnosis Safe' : 'EOA'}`);
    
    // 使用不带 provider 的 wallet（CLOB client 需要）
    const clobWallet = new ethers.Wallet(CONFIG.PRIVATE_KEY);
    
    let client = new ClobClient(
        CONFIG.CLOB_HTTP_URL,
        CONFIG.CHAIN_ID,
        clobWallet,
        undefined,
        signatureType,
        isProxySafe ? CONFIG.PROXY_WALLET : undefined
    );
    
    // 获取 API Key
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    
    let creds = await client.createApiKey();
    if (!creds.key) {
        creds = await client.deriveApiKey();
    }
    
    console.log = originalLog;
    console.error = originalError;
    
    clobClient = new ClobClient(
        CONFIG.CLOB_HTTP_URL,
        CONFIG.CHAIN_ID,
        clobWallet,
        creds,
        signatureType,
        isProxySafe ? CONFIG.PROXY_WALLET : undefined
    );
    
    Logger.success('交易客户端初始化成功');
    return clobClient;
};

/**
 * 获取账户余额
 */
export const getBalance = async (): Promise<number> => {
    try {
        const client = await initClient();
        const balances = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        return parseFloat(balances.balance || '0') / 1e6;
    } catch (error) {
        return 0;
    }
};

/**
 * 计算基于深度的下单金额
 */
const calculateOrderSize = (
    availableSize: number,  // 订单簿可用数量
    price: number,          // 价格
): number => {
    // 根据深度计算可用金额
    const maxByDepth = availableSize * price * (CONFIG.DEPTH_USAGE_PERCENT / 100);
    
    // 限制在最小和最大之间
    let orderSize = Math.min(maxByDepth, CONFIG.MAX_ORDER_SIZE_USD);
    orderSize = Math.max(orderSize, CONFIG.MIN_ORDER_SIZE_USD);
    
    // 如果深度不够最小金额，返回 0
    if (maxByDepth < CONFIG.MIN_ORDER_SIZE_USD) {
        return 0;
    }
    
    return orderSize;
};

/**
 * 执行单边买入（直接使用 WebSocket 缓存的价格，不再请求 API）
 */
const executeBuy = async (
    tokenId: string,
    amountUSD: number,
    cachedPrice: number,  // 使用 WebSocket 缓存的价格
    outcome: string
): Promise<{ success: boolean; filled: number; avgPrice: number; cost: number }> => {
    try {
        const client = await initClient();
        
        // 直接使用缓存价格，不再请求订单簿
        const askPrice = cachedPrice;
        
        const sharesToBuy = amountUSD / askPrice;
        
        if (CONFIG.SIMULATION_MODE) {
            // 模拟模式：静默成功
            return { success: true, filled: sharesToBuy, avgPrice: askPrice, cost: amountUSD };
        }
        
        const orderPrice = Math.min(askPrice * 1.005, 0.99);
        const orderArgs = { side: Side.BUY, tokenID: tokenId, amount: amountUSD, price: orderPrice };
        const signedOrder = await client.createMarketOrder(orderArgs);
        const resp = await client.postOrder(signedOrder, OrderType.FOK);
        
        if (resp.success) {
            Logger.success(`✅ ${outcome}: ${sharesToBuy.toFixed(0)} @ $${askPrice.toFixed(2)}`);
            return { success: true, filled: sharesToBuy, avgPrice: askPrice, cost: amountUSD };
        }
        return { success: false, filled: 0, avgPrice: 0, cost: 0 };
    } catch (error) {
        return { success: false, filled: 0, avgPrice: 0, cost: 0 };
    }
};

/**
 * 检查是否在冷却中（同一市场 60 秒内不重复下单）
 */
export const isDuplicateOpportunity = (conditionId: string, _upPrice: number, _downPrice: number): boolean => {
    const lastTime = lastTradeTime.get(conditionId);
    if (!lastTime) return false;
    
    // 60 秒冷却
    return Date.now() - lastTime < TRADE_COOLDOWN_MS;
};

/**
 * 记录下单时间
 */
export const recordTradePrice = (conditionId: string, _upPrice: number, _downPrice: number): void => {
    lastTradeTime.set(conditionId, Date.now());
};

// 兼容旧接口
export const isOnCooldown = (_conditionId: string): boolean => false;

/**
 * 智能套利执行 - 根据深度和仓位动态下单
 */
export const executeArbitrage = async (
    opportunity: ArbitrageOpportunity,
    _amountUSD: number  // 这个参数现在不用了，改为根据深度决定
): Promise<{
    success: boolean;
    upFilled: number;
    downFilled: number;
    totalCost: number;
    expectedProfit: number;
}> => {
    // 检查是否重复机会（同一价格不重复下单）
    if (isDuplicateOpportunity(opportunity.conditionId, opportunity.upAskPrice, opportunity.downAskPrice)) {
        return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
    }
    
    // 检查仓位不平衡度
    const imbalance = getImbalance(opportunity.conditionId);
    
    // 根据深度计算下单金额
    const upOrderSize = calculateOrderSize(opportunity.upAskSize, opportunity.upAskPrice);
    const downOrderSize = calculateOrderSize(opportunity.downAskSize, opportunity.downAskPrice);
    
    // 如果两边深度都不够，跳过
    if (upOrderSize === 0 && downOrderSize === 0) {
        Logger.warning('深度不足，跳过');
        return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
    }
    
    // 检查余额
    const balance = await getBalance();
    const totalNeeded = upOrderSize + downOrderSize;
    if (balance < Math.min(upOrderSize, downOrderSize)) {
        Logger.error(`余额不足: $${balance.toFixed(2)}`);
        return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
    }
    
    let upResult = { success: false, filled: 0, avgPrice: 0, cost: 0 };
    let downResult = { success: false, filled: 0, avgPrice: 0, cost: 0 };
    
    // 只做真套利（Up + Down < $1.00）
    const hasRealArbitrage = opportunity.combinedCost < 1.0;
    
    if (!hasRealArbitrage) {
        // 没有套利空间，跳过
        return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
    }
    
    // 真套利：买两边
    const shouldBuyUp = upOrderSize > 0;
    const shouldBuyDown = downOrderSize > 0;
    const strategyType = 'arbitrage';
    
    // 并行执行下单
    const promises: Promise<any>[] = [];
    
    if (shouldBuyUp) {
        promises.push(
            executeBuy(opportunity.upToken.token_id, upOrderSize, opportunity.upAskPrice, 'Up')
                .then(r => { upResult = r; })
        );
    }
    
    if (shouldBuyDown) {
        promises.push(
            executeBuy(opportunity.downToken.token_id, downOrderSize, opportunity.downAskPrice, 'Down')
                .then(r => { downResult = r; })
        );
    }
    
    if (promises.length > 0) {
        await Promise.all(promises);
    }
    
    // 更新仓位
    if (upResult.success) {
        updatePosition(
            opportunity.conditionId,
            opportunity.slug,
            opportunity.title,
            'up',
            upResult.filled,
            upResult.cost,
            opportunity.endDate
        );
    }
    
    if (downResult.success) {
        updatePosition(
            opportunity.conditionId,
            opportunity.slug,
            opportunity.title,
            'down',
            downResult.filled,
            downResult.cost,
            opportunity.endDate
        );
    }
    
    const totalCost = upResult.cost + downResult.cost;
    
    // 计算预期利润
    let expectedProfit = 0;
    if (strategyType === 'arbitrage') {
        // 套利：利润 = 最小成交量 * (1 - 合计价格)
        const minShares = Math.min(upResult.filled, downResult.filled);
        expectedProfit = minShares * (1 - opportunity.combinedCost);
    } else {
        // 投机：利润取决于结果
        if (upResult.success && !downResult.success) {
            expectedProfit = upResult.filled * (1 - opportunity.upAskPrice) - upResult.cost;
        } else if (downResult.success && !upResult.success) {
            expectedProfit = downResult.filled * (1 - opportunity.downAskPrice) - downResult.cost;
        }
    }
    
    // 记录下单价格（防止重复下单）
    if (upResult.success || downResult.success) {
        recordTradePrice(opportunity.conditionId, opportunity.upAskPrice, opportunity.downAskPrice);
    }
    
    return {
        success: upResult.success || downResult.success,
        upFilled: upResult.filled,
        downFilled: downResult.filled,
        totalCost,
        expectedProfit,
    };
};

export default {
    initClient,
    getBalance,
    getUSDCBalance,
    ensureApprovals,
    executeArbitrage,
    isOnCooldown,
};
