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
import { updatePosition, getImbalance, getPositionStats, getGroupCostAnalysis, getAssetAvgPrices, syncPositionsFromAPI } from './positions';
import { recordHedgeCost, recordHedgeFill } from './hedging';

let clobClient: ClobClient | null = null;
let provider: ethers.providers.JsonRpcProvider | null = null;
let wallet: ethers.Wallet | null = null;

// 记录上次下单时间（同一市场必须冷却）
const lastTradeTime = new Map<string, number>();

// 记录失败时间（失败后短暂冷却，避免反复重试）
const lastFailTime = new Map<string, number>();
const FAIL_COOLDOWN_MS = 3000;  // 失败后冷却 3 秒

// API 同步冷却（定期同步，不依赖成交结果）
let lastSyncTime = 0;
const SYNC_COOLDOWN_MS = 30000;  // 30 秒同步一次

// 🔒 同池增持并发锁：同一时间段+资产+方向只能有一个订单在执行
// Key 格式：`${timeGroup}-${asset}-${side}`，例如 `15min-btc-down`
const activeSamePoolExecutions = new Set<string>();

const getSamePoolLockKey = (timeGroup: string, asset: string, side: string): string => {
    return `${timeGroup}-${asset}-${side}`;
};

const tryAcquireSamePoolLock = (key: string): boolean => {
    if (activeSamePoolExecutions.has(key)) {
        return false;  // 已有同类型订单在执行
    }
    activeSamePoolExecutions.add(key);
    return true;
};

const releaseSamePoolLock = (key: string): void => {
    activeSamePoolExecutions.delete(key);
};

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
    // 模拟模式下，如果没有私钥，跳过授权检查
    if (CONFIG.SIMULATION_MODE && !CONFIG.PRIVATE_KEY) {
        Logger.info('🔵 模拟模式：跳过 USDC 授权检查');
        return true;
    }
    
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
    // 模拟模式下，如果没有私钥，返回模拟余额
    if (CONFIG.SIMULATION_MODE && !CONFIG.PRIVATE_KEY) {
        return 10000;  // 模拟 10000 USDC
    }
    
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
    
    // 模拟模式下，如果没有私钥，跳过真实客户端初始化
    if (CONFIG.SIMULATION_MODE && !CONFIG.PRIVATE_KEY) {
        Logger.info('🔵 模拟模式：跳过交易客户端初始化');
        // 返回一个空的 mock 客户端
        clobClient = {} as ClobClient;
        return clobClient;
    }
    
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
    // 模拟模式下，如果没有私钥，返回模拟余额
    if (CONFIG.SIMULATION_MODE && !CONFIG.PRIVATE_KEY) {
        return 10000;  // 模拟 10000 USDC
    }
    
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
 * 执行单边买入（使用 shares 数量下单，确保两边数量完全一致）
 * 
 * 重要：使用 size 参数直接指定 shares 数量，而不是 amount (USD)
 * 这样可以确保两边买到完全相同数量的 shares
 * 
 * @param isSamePool - 是否为同池套利（同池订单会应用 PRICE_TOLERANCE_PERCENT 提高成交率）
 */
const executeBuy = async (
    tokenId: string,
    shares: number,           // shares 数量
    limitPrice: number,       // 最高可接受价格（限价）
    outcome: string,
    isSamePool: boolean = false  // 是否为同池套利
): Promise<{ success: boolean; filled: number; avgPrice: number; cost: number }> => {
    // 🔧 精度控制：Polymarket 要求 shares 最多 2 位小数
    shares = Math.floor(shares * 100) / 100;
    
    const estimatedCost = shares * limitPrice;
    
    // 模拟模式：直接返回成功
    if (CONFIG.SIMULATION_MODE) {
        Logger.success(`🔵 [模拟] ${outcome}: ${shares.toFixed(2)} shares @ $${limitPrice.toFixed(3)}`);
        return { success: true, filled: shares, avgPrice: limitPrice, cost: estimatedCost };
    }
    
    const client = await initClient();
    
    // 计算限价：加容差提高成交率
    // FAK 订单的 price 是最高可接受价格，如果不加容差，市场轻微波动就会导致不成交
    // 🔧 统一使用 PRICE_TOLERANCE_PERCENT，跨池和同池都生效
    const tolerance = 1 + (CONFIG.PRICE_TOLERANCE_PERCENT / 100);
    // 🔧 精度控制：价格 2 位小数
    const orderPrice = Math.floor(Math.min(limitPrice * tolerance, 0.99) * 100) / 100;
    
    // 用 orderPrice 计算 amount，尽可能多吃深度
    // 🔧 精度控制：金额 2 位小数
    const amount = Math.floor(shares * orderPrice * 100) / 100;
    
    // Polymarket 最小订单金额是 $1，如果不足则跳过
    if (amount < CONFIG.MIN_ORDER_AMOUNT_USD) {
        return { success: false, filled: 0, avgPrice: 0, cost: 0 };
    }
    
    const orderArgs = { 
        side: Side.BUY, 
        tokenID: tokenId, 
        amount: amount,
        price: orderPrice 
    };
    
    // 调试：显示实际下单参数（精度检查）
    Logger.info(`📤 ${outcome}: ${shares.toFixed(2)} shares @ 限价$${orderPrice.toFixed(2)} | 金额$${amount.toFixed(2)} (原价$${limitPrice.toFixed(3)} +${CONFIG.PRICE_TOLERANCE_PERCENT}%)`);
    
    // 执行订单（不再禁用 console，避免卡死问题）
    try {
        const signedOrder = await client.createMarketOrder(orderArgs);
        const resp = await client.postOrder(signedOrder, OrderType.FAK);
        
        if (resp.success) {
            // 🔍 调试：打印 API 返回的完整信息
            const txHashCount = resp.transactionsHashes?.length || 0;
            const fillsCount = resp.fills?.length || 0;
            const matchedCount = (resp as any).matched?.length || 0;
            Logger.info(`🔍 API响应: success=${resp.success} status=${resp.status} orderID=${resp.orderID?.slice(0,8)}`);
            Logger.info(`🔍 数量: takingAmount=${resp.takingAmount} makingAmount=${resp.makingAmount}`);
            Logger.info(`🔍 成交: txHashes=${txHashCount}个 fills=${fillsCount}个 matched=${matchedCount}个`);
            if (txHashCount > 0) {
                Logger.info(`🔍 txHashes: ${JSON.stringify(resp.transactionsHashes)}`);
            }
            if (fillsCount > 0) {
                Logger.info(`🔍 fills: ${JSON.stringify(resp.fills).slice(0, 200)}`);
            }
            
            // 🔧 尝试从多个可能的字段获取成交数量
            let actualShares = 0;
            let actualCost = 0;
            
            // 🔧 优先从 fills/matched 数组获取实际成交（最可靠）
            // fills 为空说明没有成交，即使 success=true 也当作失败
            
            // 方式1: fills 数组
            if (resp.fills && Array.isArray(resp.fills) && resp.fills.length > 0) {
                for (const fill of resp.fills) {
                    actualShares += parseFloat(fill.size || fill.amount || 0);
                    actualCost += parseFloat(fill.price || 0) * parseFloat(fill.size || fill.amount || 0);
                }
            }
            // 方式2: matched 数组
            else if (resp.matched && Array.isArray(resp.matched) && resp.matched.length > 0) {
                for (const match of resp.matched) {
                    actualShares += parseFloat(match.size || match.amount || 0);
                    actualCost += parseFloat(match.price || 0) * parseFloat(match.size || match.amount || 0);
                }
            }
            // 方式3: transactionsHashes 不为空说明有链上成交，用 takingAmount
            else if (resp.transactionsHashes && Array.isArray(resp.transactionsHashes) && resp.transactionsHashes.length > 0 && resp.takingAmount) {
                const rawShares = parseFloat(resp.takingAmount);
                const rawCost = resp.makingAmount ? parseFloat(resp.makingAmount) : amount;
                // 智能判断单位
                if (rawShares > 1000) {
                    actualShares = rawShares / 1e6;
                    actualCost = rawCost / 1e6;
                } else {
                    actualShares = rawShares;
                    actualCost = rawCost;
                }
            }
            // 方式4: fills 为空，没有成交
            // 不再回退到请求值，这样会导致虚假成交记录
            
            const actualAvgPrice = actualShares > 0 ? actualCost / actualShares : orderPrice;
            
            // 🔧 如果实际成交数量为 0，当作失败处理
            if (actualShares < 0.01) {
                Logger.warning(`❌ ${outcome}: 成交0 shares`);
                return { success: false, filled: 0, avgPrice: 0, cost: 0 };
            }
            
            Logger.success(`✅ ${outcome}: ${actualShares.toFixed(2)} shares @ $${actualAvgPrice.toFixed(3)}`);
            return { success: true, filled: actualShares, avgPrice: actualAvgPrice, cost: actualCost };
        }
        // FAK 订单 resp.success=false 说明没有匹配单
        Logger.warning(`❌ ${outcome}: 无匹配单`);
        return { success: false, filled: 0, avgPrice: 0, cost: 0 };
    } catch (error: any) {
        const status = error?.response?.status || error?.status;
        const errMsg = error?.response?.data?.error || error?.message || '';
        
        // 简化错误日志（不打印完整的 CLOB Client 错误）
        if (status === 400) {
            if (errMsg.includes('no orders found')) {
                Logger.warning(`❌ ${outcome}: 无匹配单`);
            } else if (errMsg.includes('min size')) {
                Logger.warning(`❌ ${outcome}: 金额<$1`);
            } else {
                Logger.warning(`❌ ${outcome}: 订单被拒`);
            }
        } else if (status === 500) {
            Logger.warning(`❌ ${outcome}: 服务器错误，重试中...`);
            // 500 错误重试一次
            await new Promise(resolve => setTimeout(resolve, 300));
            try {
                const signedOrder = await client.createMarketOrder(orderArgs);
                const resp = await client.postOrder(signedOrder, OrderType.FAK);
                if (resp.success) {
                    // 🔧 修复：使用 API 返回的实际成交数量
                    const actualShares = resp.takingAmount ? parseFloat(resp.takingAmount) / 1e6 : shares;
                    const actualCost = resp.makingAmount ? parseFloat(resp.makingAmount) / 1e6 : amount;
                    const actualAvgPrice = actualShares > 0 ? actualCost / actualShares : orderPrice;
                    
                    // 如果实际成交数量为 0，当作失败
                    if (actualShares >= 0.01) {
                        Logger.success(`✅ ${outcome}: ${actualShares.toFixed(2)} shares @ $${actualAvgPrice.toFixed(3)}`);
                        return { success: true, filled: actualShares, avgPrice: actualAvgPrice, cost: actualCost };
                    }
                }
            } catch (retryErr) {
                // 重试也失败
            }
            Logger.warning(`❌ ${outcome}: 重试失败`);
        } else {
            Logger.warning(`❌ ${outcome}: 网络错误`);
        }
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
    // 🔒 同池增持并发控制：同一资产同方向只能有一个订单在执行
    let samePoolLockKey: string | null = null;
    if (opportunity.isSamePoolRebalance && opportunity.rebalanceAsset && opportunity.rebalanceSide) {
        samePoolLockKey = getSamePoolLockKey(
            opportunity.timeGroup,
            opportunity.rebalanceAsset,
            opportunity.rebalanceSide
        );
        if (!tryAcquireSamePoolLock(samePoolLockKey)) {
            // 已有同类型同池增持在执行，跳过避免重复下单
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
    }
    
    // 包装整个执行逻辑，确保锁被释放
    try {
        return await executeArbitrageInternal(opportunity, samePoolLockKey);
    } finally {
        // 无论成功失败，释放锁
        if (samePoolLockKey) {
            releaseSamePoolLock(samePoolLockKey);
        }
    }
};

// 内部执行函数
const executeArbitrageInternal = async (
    opportunity: ArbitrageOpportunity,
    _samePoolLockKey: string | null
): Promise<{
    success: boolean;
    upFilled: number;
    downFilled: number;
    totalCost: number;
    expectedProfit: number;
}> => {
    // 检查冷却（同池增持不检查，因为如果没有真正的机会，扫描器就不应该发送）
    if (!opportunity.isSamePoolRebalance) {
        if (isDuplicateOpportunity(opportunity.conditionId, opportunity.upAskPrice, opportunity.downAskPrice)) {
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
    }
    
    // 获取交易动作
    const action = opportunity.tradingAction;
    if (action === 'wait') {
        return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
    }
    
    // 打印执行开始日志
    const execPoolTag = opportunity.isCrossPool ? '🔀' : 
                        opportunity.isSamePoolRebalance ? '🔄' : '📊';
    const assetInfo = opportunity.isSamePoolRebalance 
        ? `${opportunity.rebalanceAsset?.toUpperCase()}${opportunity.rebalanceSide === 'up' ? '↑' : '↓'}`
        : '';
    Logger.info(`${execPoolTag} ${opportunity.timeGroup} ${assetInfo} 执行 ${action}: Up $${opportunity.upAskPrice.toFixed(3)} | Down $${opportunity.downAskPrice.toFixed(3)}`);
    
    // 用 shares 数量下单，确保两边数量完全一致
    let upShares = 0;
    let downShares = 0;
    
    if (action === 'buy_both') {
        // 两边都买时，确保买到的 SHARES 数量完全一致
        
        // 计算每边能买到的最大 shares（基于深度）
        const maxUpShares = opportunity.upAskSize * (CONFIG.DEPTH_USAGE_PERCENT / 100);
        const maxDownShares = opportunity.downAskSize * (CONFIG.DEPTH_USAGE_PERCENT / 100);
        
        // 如果任一边深度不足，跳过
        if (maxUpShares < 1 || maxDownShares < 1) {
            Logger.info(`⏭️ 跳过: 深度不足 Up=${maxUpShares.toFixed(1)} Down=${maxDownShares.toFixed(1)}`);
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
        
        // 取两边能买到的 shares 的最小值，确保配对平衡
        // 🔧 精度控制：Polymarket 要求 shares 最多 2 位小数
        let targetShares = Math.floor(Math.min(maxUpShares, maxDownShares) * 100) / 100;
        
        // 计算需要多少钱（USD）来买这些 shares
        const combinedCost = opportunity.upAskPrice + opportunity.downAskPrice;
        const totalCostNeeded = targetShares * combinedCost;
        
        // Polymarket 最小订单金额 $1：计算两边各自满足 $1 所需的最少 shares（精确值，不取整）
        const minSharesForUp = CONFIG.MIN_ORDER_AMOUNT_USD / opportunity.upAskPrice;
        const minSharesForDown = CONFIG.MIN_ORDER_AMOUNT_USD / opportunity.downAskPrice;
        const minSharesRequired = Math.max(minSharesForUp, minSharesForDown);
        
        // 预算允许的最大股数
        const maxAffordableShares = (CONFIG.MAX_ORDER_SIZE_USD * 2) / combinedCost;
        
        // targetShares 受三个限制：深度、预算、$1 最低要求
        targetShares = Math.min(targetShares, maxAffordableShares);  // 不超过预算
        
        // 检查：在预算范围内，两边是否都能满足 $1 最低要求
        const upAmount = targetShares * opportunity.upAskPrice;
        const downAmount = targetShares * opportunity.downAskPrice;
        
        if (upAmount < CONFIG.MIN_ORDER_AMOUNT_USD || downAmount < CONFIG.MIN_ORDER_AMOUNT_USD) {
            // 预算太小，无法让两边都满足 $1（显示原因）
            Logger.info(`⏭️ 跳过: Up=$${upAmount.toFixed(2)} Down=$${downAmount.toFixed(2)} 有一边<$1`);
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
        
        // 计算预期利润，如果太小就跳过
        const finalCost = targetShares * combinedCost;
        const expectedProfitCheck = targetShares - finalCost;  // 套利利润 = shares数 - 总成本（因为每对赎回 $1）
        
        if (expectedProfitCheck < CONFIG.MIN_PROFIT_USD) {
            // 利润太小，跳过（显示原因）
            Logger.info(`⏭️ 跳过: 预期利润$${expectedProfitCheck.toFixed(2)} < $${CONFIG.MIN_PROFIT_USD}`);
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
        
        // 两边使用完全相同的 shares 数量！
        upShares = targetShares;
        downShares = targetShares;
        
    } else if (action === 'buy_up_only') {
        // 对冲/同池增持：尽可能多买，吃掉全部深度
        // 普通交易：90% 深度，有金额限制
        if (opportunity.isHedge || opportunity.isSamePoolRebalance) {
            // 对冲/同池增持：使用全部深度，不受预算限制
            upShares = Math.min(opportunity.maxShares, opportunity.upAskSize);
        } else {
            const maxSharesByDepth = opportunity.upAskSize * (CONFIG.DEPTH_USAGE_PERCENT / 100);
            const maxSharesByBudget = CONFIG.MAX_ORDER_SIZE_USD / opportunity.upAskPrice;
            upShares = Math.min(maxSharesByDepth, maxSharesByBudget);
        }
        
        // 检查金额是否满足 $1 最低要求
        const upAmount = upShares * opportunity.upAskPrice;
        if (upAmount < CONFIG.MIN_ORDER_AMOUNT_USD) {
            // 深度不够 $1，等待更多深度
            if (opportunity.isHedge || opportunity.isSamePoolRebalance) {
                Logger.warning(`⚠️ 等待深度: Up 当前$${upAmount.toFixed(2)} < $1 @ $${opportunity.upAskPrice.toFixed(2)}`);
            }
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
    } else if (action === 'buy_down_only') {
        // 对冲/同池增持：尽可能多买，吃掉全部深度
        // 普通交易：90% 深度，有金额限制
        if (opportunity.isHedge || opportunity.isSamePoolRebalance) {
            // 对冲/同池增持：使用全部深度，不受预算限制
            downShares = Math.min(opportunity.maxShares, opportunity.downAskSize);
        } else {
            const maxSharesByDepth = opportunity.downAskSize * (CONFIG.DEPTH_USAGE_PERCENT / 100);
            const maxSharesByBudget = CONFIG.MAX_ORDER_SIZE_USD / opportunity.downAskPrice;
            downShares = Math.min(maxSharesByDepth, maxSharesByBudget);
        }
        
        // 检查金额是否满足 $1 最低要求
        const downAmount = downShares * opportunity.downAskPrice;
        if (downAmount < CONFIG.MIN_ORDER_AMOUNT_USD) {
            // 深度不够 $1，等待更多深度
            if (opportunity.isHedge || opportunity.isSamePoolRebalance) {
                Logger.warning(`⚠️ 等待深度: Down 当前$${downAmount.toFixed(2)} < $1 @ $${opportunity.downAskPrice.toFixed(2)}`);
            }
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
    }
    
    // 计算总成本用于余额检查
    const totalCostNeeded = (upShares * opportunity.upAskPrice) + (downShares * opportunity.downAskPrice);
    
    // 检查余额（模拟模式跳过）
    if (!CONFIG.SIMULATION_MODE) {
        const balance = await getBalance();
        if (balance < totalCostNeeded) {
            Logger.error(`余额不足: $${balance.toFixed(2)} < $${totalCostNeeded.toFixed(2)}`);
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
    }
    
    let upResult = { success: false, filled: 0, avgPrice: 0, cost: 0 };
    let downResult = { success: false, filled: 0, avgPrice: 0, cost: 0 };
    
    // 🔒 下单前预验证：确保两边金额都 >= $1，避免单边被拒绝导致仓位不平衡
    if (action === 'buy_both' && upShares > 0 && downShares > 0) {
        const upAmount = upShares * opportunity.upAskPrice;
        const downAmount = downShares * opportunity.downAskPrice;
        
        if (upAmount < CONFIG.MIN_ORDER_AMOUNT_USD || downAmount < CONFIG.MIN_ORDER_AMOUNT_USD) {
            Logger.warning(`⚠️ 跳过: Up=$${upAmount.toFixed(2)} Down=$${downAmount.toFixed(2)} 有一边<$1`);
            return { success: false, upFilled: 0, downFilled: 0, totalCost: 0, expectedProfit: 0 };
        }
    }
    
    // 并行执行下单（传入 shares 数量）
    // 同池套利会应用 PRICE_TOLERANCE_PERCENT 提高成交率
    const isSamePool = opportunity.isSamePoolRebalance || false;
    const promises: Promise<any>[] = [];
    
    if (upShares > 0) {
        promises.push(
            executeBuy(opportunity.upToken.token_id, upShares, opportunity.upAskPrice, 'Up', isSamePool)
                .then(r => { upResult = r; })
        );
    }
    
    if (downShares > 0) {
        promises.push(
            executeBuy(opportunity.downToken.token_id, downShares, opportunity.downAskPrice, 'Down', isSamePool)
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
    
    // ⚠️ API 同步：定期同步，不依赖成交结果
    // 原因：fills=[] 可能为空但实际有成交，或者 API 返回延迟
    // 改为：每 30 秒自动同步一次
    const now = Date.now();
    if (now - lastSyncTime >= SYNC_COOLDOWN_MS) {
        lastSyncTime = now;
        await syncPositionsFromAPI();
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
    
    // 记录下单时间（同池增持不记录冷却，以便连续快速执行）
    if (!opportunity.isSamePoolRebalance) {
        if (upResult.success) {
            recordTradePrice(opportunity.conditionId, opportunity.upAskPrice, opportunity.downAskPrice);
        }
        // 跨池套利时记录两个市场
        if (downResult.success && opportunity.isCrossPool && opportunity.downConditionId) {
            recordTradePrice(opportunity.downConditionId, opportunity.upAskPrice, opportunity.downAskPrice);
        }
    }
    
    // 打印执行结果
    const success = upResult.success || downResult.success;
    // 区分：跨池套利、同池增持、普通同池
    const poolTag = opportunity.isCrossPool ? '🔀跨池' : 
                   opportunity.isSamePoolRebalance ? '🔄同池增持' : '📊同池';
    const modeTag = CONFIG.SIMULATION_MODE ? '[模拟]' : '[实盘]';
    const timeTag = opportunity.timeGroup || '';
    
    if (success) {
        // 如果是对冲交易，记录对冲成本和已补数量
        if (opportunity.isHedge && opportunity.timeGroup && opportunity.hedgeSide) {
            const filledShares = upResult.filled > 0 ? upResult.filled : downResult.filled;
            recordHedgeFill(opportunity.timeGroup, opportunity.hedgeSide, filledShares, totalCost);
        } else if (opportunity.isHedge && opportunity.timeGroup) {
            // 兼容旧接口
            recordHedgeCost(opportunity.timeGroup, totalCost);
        }
        
        // 获取当前时间组的累计成本（而不是全部仓位）
        const groupAnalysis = opportunity.timeGroup ? getGroupCostAnalysis(opportunity.timeGroup) : null;
        const groupCost = groupAnalysis?.totalCost || 0;
        
        // 检查是否部分成交（buy_both 时只有一边成功）
        if (action === 'buy_both') {
            if (upResult.success && !downResult.success) {
                Logger.warning(`⚠️ ${modeTag} ${timeTag} ${poolTag} 部分成交: Up ✅ ${upResult.filled.toFixed(0)} | Down ❌ 失败 | 需要后续补仓 Down`);
            } else if (!upResult.success && downResult.success) {
                Logger.warning(`⚠️ ${modeTag} ${timeTag} ${poolTag} 部分成交: Up ❌ 失败 | Down ✅ ${downResult.filled.toFixed(0)} | 需要后续补仓 Up`);
            } else {
                // 两边都成功 - 显示详细成本明细
                const upCostStr = `${upResult.filled.toFixed(1)}×$${upResult.avgPrice.toFixed(2)}`;
                const downCostStr = `${downResult.filled.toFixed(1)}×$${downResult.avgPrice.toFixed(2)}`;
                Logger.arbitrage(`${modeTag} ${timeTag} ${poolTag} 成交: Up(${upCostStr}) Down(${downCostStr}) | 本次$${totalCost.toFixed(2)} | 利润$${expectedProfit.toFixed(2)} | 本轮$${groupCost.toFixed(2)}`);
            }
        } else {
            // 单边买入
            const filledStr = upResult.filled > 0 
                ? `Up ${upResult.filled.toFixed(1)}×$${upResult.avgPrice.toFixed(2)}`
                : `Down ${downResult.filled.toFixed(1)}×$${downResult.avgPrice.toFixed(2)}`;
            Logger.arbitrage(`${modeTag} ${timeTag} ${poolTag} 成交: ${filledStr} | 本次$${totalCost.toFixed(2)} | 本轮$${groupCost.toFixed(2)}`);
        }
        
        // 同池增持成交后，显示仓位平衡率
        if (opportunity.isSamePoolRebalance && opportunity.timeGroup) {
            const avgPrices = getAssetAvgPrices(opportunity.timeGroup);
            const btcUp = avgPrices.btc?.upShares || 0;
            const btcDown = avgPrices.btc?.downShares || 0;
            const ethUp = avgPrices.eth?.upShares || 0;
            const ethDown = avgPrices.eth?.downShares || 0;
            
            // 计算平衡率：min/max * 100%
            const btcBalance = (btcUp > 0 || btcDown > 0) 
                ? (Math.min(btcUp, btcDown) / Math.max(btcUp, btcDown) * 100).toFixed(1) 
                : '0.0';
            const ethBalance = (ethUp > 0 || ethDown > 0) 
                ? (Math.min(ethUp, ethDown) / Math.max(ethUp, ethDown) * 100).toFixed(1) 
                : '0.0';
            
            Logger.info(`   📊 仓位平衡: BTC(Up=${btcUp.toFixed(0)} Down=${btcDown.toFixed(0)} 平衡${btcBalance}%) | ETH(Up=${ethUp.toFixed(0)} Down=${ethDown.toFixed(0)} 平衡${ethBalance}%)`);
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

/**
 * 执行卖出（用于止损）
 * 静默重试3次
 */
export const executeSell = async (
    tokenId: string,
    shares: number,
    bidPrice: number,
    label: string
): Promise<{ success: boolean; received: number }> => {
    // 🔧 精度控制：shares 最多 2 位小数
    shares = Math.floor(shares * 100) / 100;
    
    // 模拟模式
    if (CONFIG.SIMULATION_MODE) {
        const received = shares * bidPrice;
        Logger.success(`🔵 [模拟卖出] ${label}: ${shares.toFixed(2)} shares @ $${bidPrice.toFixed(3)} = $${received.toFixed(2)}`);
        return { success: true, received };
    }
    
    const client = await initClient();
    
    // 稍微低于 bid 价格确保成交
    // 🔧 精度控制：价格和金额 2 位小数
    const sellPrice = Math.floor(Math.max(0.01, bidPrice * 0.995) * 100) / 100;
    const amountUSD = Math.floor(shares * sellPrice * 100) / 100;
    
    // Polymarket 最小订单金额 $1
    if (amountUSD < CONFIG.MIN_ORDER_AMOUNT_USD) {
        return { success: false, received: 0 };
    }
    
    const orderArgs = {
        side: Side.SELL,
        tokenID: tokenId,
        amount: amountUSD,
        price: sellPrice,
    };
    
    // 执行卖出订单
    try {
        const signedOrder = await client.createMarketOrder(orderArgs);
        const resp = await client.postOrder(signedOrder, OrderType.FAK);
        
        if (resp.success) {
            // 🔧 修复：使用 API 返回的实际成交数量
            // SELL 订单：takingAmount 是收到的 USDC，makingAmount 是卖出的 shares
            const actualReceived = resp.takingAmount ? parseFloat(resp.takingAmount) / 1e6 : shares * sellPrice;
            const actualSold = resp.makingAmount ? parseFloat(resp.makingAmount) / 1e6 : shares;
            
            // 如果实际成交数量为 0，当作失败
            if (actualSold < 0.01) {
                Logger.warning(`❌ [卖出] ${label}: 成交0 shares`);
                return { success: false, received: 0 };
            }
            
            Logger.success(`✅ [卖出] ${label}: ${actualSold.toFixed(2)} shares @ $${(actualReceived/actualSold).toFixed(3)} = $${actualReceived.toFixed(2)}`);
            return { success: true, received: actualReceived };
        }
        Logger.warning(`❌ [卖出] ${label}: 无匹配单`);
        return { success: false, received: 0 };
    } catch (error: any) {
        const status = error?.response?.status || error?.status;
        
        if (status === 500) {
            // 500 错误重试一次
            await new Promise(resolve => setTimeout(resolve, 300));
            try {
                const signedOrder = await client.createMarketOrder(orderArgs);
                const resp = await client.postOrder(signedOrder, OrderType.FAK);
                if (resp.success) {
                    // 🔧 修复：使用 API 返回的实际成交数量
                    const actualReceived = resp.takingAmount ? parseFloat(resp.takingAmount) / 1e6 : shares * sellPrice;
                    const actualSold = resp.makingAmount ? parseFloat(resp.makingAmount) / 1e6 : shares;
                    
                    if (actualSold >= 0.01) {
                        Logger.success(`✅ [卖出] ${label}: ${actualSold.toFixed(2)} shares @ $${(actualReceived/actualSold).toFixed(3)} = $${actualReceived.toFixed(2)}`);
                        return { success: true, received: actualReceived };
                    }
                }
            } catch (retryErr) {
                // 重试也失败
            }
        }
        Logger.warning(`❌ [卖出] ${label}: 失败`);
        return { success: false, received: 0 };
    }
};

export default {
    initClient,
    getBalance,
    getUSDCBalance,
    ensureApprovals,
    executeArbitrage,
    executeSell,
    isOnCooldown,
};



