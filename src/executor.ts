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

// 使用 getAddress 确保 checksum 正确
const toChecksumAddress = (addr: string): string => {
    try {
        return ethers.utils.getAddress(addr.toLowerCase());
    } catch {
        return addr;
    }
};

// Polygon 合约地址（确保 checksum 正确）
const CONTRACTS = {
    // USDC on Polygon (PoS Bridge - 旧版)
    USDC_E: toChecksumAddress('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'),
    // USDC on Polygon (Native - 新版)
    USDC: toChecksumAddress('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
    
    // Polymarket 核心合约
    CTF_EXCHANGE: toChecksumAddress('0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8DB438C'),        // 主交易所
    NEG_RISK_CTF_EXCHANGE: toChecksumAddress('0xC5d563A36AE78145C45a50134d48A1215220f80a'), // 负风险交易所
    NEG_RISK_ADAPTER: toChecksumAddress('0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'),     // 负风险适配器
    CONDITIONAL_TOKENS: toChecksumAddress('0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'),   // 条件代币合约
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

// 余额缓存（减少 API 调用）
let cachedBalance = 0;
let lastBalanceCheck = 0;
const BALANCE_CACHE_MS = 30000;  // 30 秒缓存

/**
 * 获取账户余额（带缓存）
 */
export const getBalance = async (): Promise<number> => {
    const now = Date.now();
    
    // 使用缓存
    if (now - lastBalanceCheck < BALANCE_CACHE_MS && cachedBalance > 0) {
        return cachedBalance;
    }
    
    try {
        const client = await initClient();
        
        // 带超时的余额查询
        const timeoutPromise = new Promise<number>((_, reject) => 
            setTimeout(() => reject(new Error('余额查询超时')), 5000)
        );
        
        const balancePromise = client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
            .then(balances => parseFloat(balances.balance || '0') / 1e6);
        
        cachedBalance = await Promise.race([balancePromise, timeoutPromise]);
        lastBalanceCheck = now;
        return cachedBalance;
    } catch (error) {
        // 超时或错误时返回缓存值
        return cachedBalance > 0 ? cachedBalance : 1000;  // 模拟模式假设有 1000
    }
};

/**
 * 计算基于深度的下单金额
 * 不再有最小金额限制，深度有多少就下多少（但不超过最大值）
 */
const calculateOrderSize = (
    availableSize: number,  // 订单簿可用数量
    price: number,          // 价格
): number => {
    // 根据深度计算可用金额（使用配置的深度使用百分比）
    const maxByDepth = availableSize * price * (CONFIG.DEPTH_USAGE_PERCENT / 100);
    
    // 只限制最大值，不限制最小值
    const orderSize = Math.min(maxByDepth, CONFIG.MAX_ORDER_SIZE_USD);
    
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
    const askPrice = cachedPrice;
    const sharesToBuy = amountUSD / askPrice;
    
    // 模拟模式：直接返回成功
    if (CONFIG.SIMULATION_MODE) {
        // 模拟模式也打印日志
        Logger.success(`🔵 [模拟] ${outcome}: ${sharesToBuy.toFixed(0)} shares @ $${askPrice.toFixed(3)}`);
        return { success: true, filled: sharesToBuy, avgPrice: askPrice, cost: amountUSD };
    }
    
    try {
        const client = await initClient();
        
        const orderPrice = Math.min(askPrice * 1.005, 0.99);
        const orderArgs = { side: Side.BUY, tokenID: tokenId, amount: amountUSD, price: orderPrice };
        const signedOrder = await client.createMarketOrder(orderArgs);
        const resp = await client.postOrder(signedOrder, OrderType.FOK);
        
        if (resp.success) {
            Logger.success(`✅ ${outcome}: ${sharesToBuy.toFixed(0)} shares @ $${askPrice.toFixed(3)}`);
            return { success: true, filled: sharesToBuy, avgPrice: askPrice, cost: amountUSD };
        }
        Logger.warning(`❌ ${outcome}: 订单未成交`);
        return { success: false, filled: 0, avgPrice: 0, cost: 0 };
    } catch (error) {
        Logger.error(`❌ ${outcome}: 下单失败 - ${error}`);
        return { success: false, filled: 0, avgPrice: 0, cost: 0 };
    }
};

/**
 * 检查是否在冷却中（同一市场在冷却时间内不重复下单）
 */
export const isDuplicateOpportunity = (conditionId: string, _upPrice: number, _downPrice: number): boolean => {
    const lastTime = lastTradeTime.get(conditionId);
    if (!lastTime) return false;
    
    return Date.now() - lastTime < CONFIG.TRADE_COOLDOWN_MS;
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
 * 智能套利执行 - 事件级套利策略
 * 
 * 根据 tradingAction 决定：
 * - buy_both: 两边都买（传统套利或仓位构建）
 * - buy_up_only: 只买 Up（仓位平衡）
 * - buy_down_only: 只买 Down（仓位平衡）
 */
export const executeArbitrage = async (
    opportunity: ArbitrageOpportunity,
    _amountUSD: number
): Promise<{
    success: boolean;
    upFilled: number;
    downFilled: number;
    totalCost: number;
    expectedProfit: number;
}> => {
    // 检查冷却（同一市场冷却时间内不重复）
    if (isDuplicateOpportunity(opportunity.conditionId, opportunity.upAskPrice, opportunity.downAskPrice)) {
        return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
    }
    
    // 获取交易动作
    const action = opportunity.tradingAction;
    if (action === 'wait') {
        return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
    }
    
    // 打印执行开始日志
    const crossTag = opportunity.isCrossPool ? '🔀' : '📊';
    Logger.info(`${crossTag} 执行 ${action}: Up $${opportunity.upAskPrice.toFixed(3)} | Down $${opportunity.downAskPrice.toFixed(3)}`);
    
    // 根据深度计算下单金额
    let upOrderSize = 0;
    let downOrderSize = 0;
    
    if (action === 'buy_both') {
        // 两边都买时，确保买到的 SHARES 数量相近（而不是金额相近）
        // 这样才能真正实现套利配对
        
        // 计算每边能买到的最大 shares（基于深度）
        const maxUpShares = opportunity.upAskSize * (CONFIG.DEPTH_USAGE_PERCENT / 100);
        const maxDownShares = opportunity.downAskSize * (CONFIG.DEPTH_USAGE_PERCENT / 100);
        
        // 如果任一边深度不足，跳过
        if (maxUpShares < 1 || maxDownShares < 1) {
            Logger.warning(`❌ ${crossTag} 深度不足: Up=${opportunity.upAskSize.toFixed(0)} Down=${opportunity.downAskSize.toFixed(0)}`);
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
        
        // 取两边能买到的 shares 的最小值，确保配对平衡
        const targetShares = Math.min(maxUpShares, maxDownShares);
        
        // 计算需要多少钱（USD）来买这些 shares
        const upCostNeeded = targetShares * opportunity.upAskPrice;
        const downCostNeeded = targetShares * opportunity.downAskPrice;
        const totalCostNeeded = upCostNeeded + downCostNeeded;
        
        // 检查是否超过最大订单限制
        if (totalCostNeeded > CONFIG.MAX_ORDER_SIZE_USD * 2) {
            // 按比例缩小到限制内
            const scale = (CONFIG.MAX_ORDER_SIZE_USD * 2) / totalCostNeeded;
            upOrderSize = upCostNeeded * scale;
            downOrderSize = downCostNeeded * scale;
        } else {
            upOrderSize = upCostNeeded;
            downOrderSize = downCostNeeded;
        }
        
        // 计算预期利润，如果太小就跳过
        const finalShares = Math.min(upOrderSize / opportunity.upAskPrice, downOrderSize / opportunity.downAskPrice);
        const finalCost = upOrderSize + downOrderSize;
        const expectedProfitCheck = finalShares - finalCost;  // 套利利润 = 配对shares数 - 总成本
        
        if (expectedProfitCheck < CONFIG.MIN_PROFIT_USD) {
            Logger.debug(`⏭️ ${crossTag} 利润太小: $${expectedProfitCheck.toFixed(3)} < $${CONFIG.MIN_PROFIT_USD}`);
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
    } else if (action === 'buy_up_only') {
        upOrderSize = calculateOrderSize(opportunity.upAskSize, opportunity.upAskPrice);
        // 深度太小（< 1 share）就跳过
        if (upOrderSize < 0.01) {
            Logger.warning(`❌ Up 深度不足: ${opportunity.upAskSize.toFixed(0)}`);
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
    } else if (action === 'buy_down_only') {
        downOrderSize = calculateOrderSize(opportunity.downAskSize, opportunity.downAskPrice);
        // 深度太小（< 1 share）就跳过
        if (downOrderSize < 0.01) {
            Logger.warning(`❌ Down 深度不足: ${opportunity.downAskSize.toFixed(0)}`);
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
    }
    
    // 检查余额（模拟模式跳过）
    if (!CONFIG.SIMULATION_MODE) {
        const balance = await getBalance();
        const totalNeeded = upOrderSize + downOrderSize;
        if (balance < totalNeeded) {
            Logger.error(`余额不足: $${balance.toFixed(2)} < $${totalNeeded.toFixed(2)}`);
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
    }
    
    let upResult = { success: false, filled: 0, avgPrice: 0, cost: 0 };
    let downResult = { success: false, filled: 0, avgPrice: 0, cost: 0 };
    
    // 并行执行下单
    const promises: Promise<any>[] = [];
    
    if (upOrderSize > 0) {
        promises.push(
            executeBuy(opportunity.upToken.token_id, upOrderSize, opportunity.upAskPrice, 'Up')
                .then(r => { upResult = r; })
        );
    }
    
    if (downOrderSize > 0) {
        promises.push(
            executeBuy(opportunity.downToken.token_id, downOrderSize, opportunity.downAskPrice, 'Down')
                .then(r => { downResult = r; })
        );
    }
    
    if (promises.length > 0) {
        await Promise.all(promises);
    }
    
    // 更新仓位（支持跨池子：Up 和 Down 可能在不同市场）
    if (upResult.success) {
        updatePosition(
            opportunity.conditionId,  // Up 所在的市场
            opportunity.upMarketSlug || opportunity.slug,
            opportunity.title,
            'up',
            upResult.filled,
            upResult.cost,
            opportunity.endDate
        );
    }
    
    if (downResult.success) {
        // 跨池子时，Down 可能在不同的市场
        const downConditionId = opportunity.downConditionId || opportunity.conditionId;
        const downSlug = opportunity.downMarketSlug || opportunity.slug;
        updatePosition(
            downConditionId,
            downSlug,
            opportunity.title,
            'down',
            downResult.filled,
            downResult.cost,
            opportunity.endDate
        );
    }
    
    const totalCost = upResult.cost + downResult.cost;
    
    // 计算本次交易的预期利润
    // 对于单边买入：利润来自平衡仓位后新增的"配对 shares"
    // 对于双边买入：利润来自 minShares * (1 - combinedCost)
    let expectedProfit = 0;
    if (upResult.filled > 0 && downResult.filled > 0) {
        // 双边买入：传统套利利润
        const minFilled = Math.min(upResult.filled, downResult.filled);
        expectedProfit = minFilled * (1 - (upResult.avgPrice + downResult.avgPrice));
    } else if (upResult.filled > 0 || downResult.filled > 0) {
        // 单边买入：这次交易本身没有直接套利利润
        // 但可能改善了整体仓位平衡，显示为 0 更准确
        expectedProfit = 0;
    }
    
    // 记录下单时间（防止重复，跨池子时记录两个市场）
    if (upResult.success) {
        recordTradePrice(opportunity.conditionId, opportunity.upAskPrice, opportunity.downAskPrice);
    }
    if (downResult.success && opportunity.isCrossPool && opportunity.downConditionId) {
        recordTradePrice(opportunity.downConditionId, opportunity.upAskPrice, opportunity.downAskPrice);
    }
    
    // 打印执行结果
    const success = upResult.success || downResult.success;
    const crossTag = opportunity.isCrossPool ? '🔀跨池' : '📊同池';
    const modeTag = CONFIG.SIMULATION_MODE ? '[模拟]' : '[实盘]';
    
    if (success) {
        // 检查是否部分成交（buy_both 时只有一边成功）
        if (action === 'buy_both') {
            if (upResult.success && !downResult.success) {
                Logger.warning(`⚠️ ${modeTag} ${crossTag} 部分成交: Up ✅ ${upResult.filled.toFixed(0)} | Down ❌ 失败 | 需要后续补仓 Down`);
            } else if (!upResult.success && downResult.success) {
                Logger.warning(`⚠️ ${modeTag} ${crossTag} 部分成交: Up ❌ 失败 | Down ✅ ${downResult.filled.toFixed(0)} | 需要后续补仓 Up`);
            } else {
                // 两边都成功
                Logger.arbitrage(`${modeTag} ${crossTag} 成交: Up ${upResult.filled.toFixed(0)} | Down ${downResult.filled.toFixed(0)} | 成本 $${totalCost.toFixed(2)} | 预期利润 $${expectedProfit.toFixed(2)}`);
            }
        } else {
            // 单边买入
            Logger.arbitrage(`${modeTag} ${crossTag} 成交: Up ${upResult.filled.toFixed(0)} | Down ${downResult.filled.toFixed(0)} | 成本 $${totalCost.toFixed(2)} | 预期利润 $${expectedProfit.toFixed(2)}`);
        }
    }
    
    return {
        success,
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


