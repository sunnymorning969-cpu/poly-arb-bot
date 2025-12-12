/**
 * 交互式配置脚本
 * 
 * 运行: npm run setup
 * 自动创建 .env 文件
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const ENV_FILE = path.join(process.cwd(), '.env');

// 颜色输出
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

const log = {
    info: (msg: string) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
    success: (msg: string) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
    warning: (msg: string) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
    error: (msg: string) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
    title: (msg: string) => console.log(`\n${colors.bright}${colors.blue}${msg}${colors.reset}\n`),
};

// 创建 readline 接口
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => resolve(answer.trim()));
    });
};

// 加载现有配置
const loadExistingConfig = (): Record<string, string> => {
    const config: Record<string, string> = {};
    if (fs.existsSync(ENV_FILE)) {
        const content = fs.readFileSync(ENV_FILE, 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const [key, ...valueParts] = trimmed.split('=');
                if (key && valueParts.length > 0) {
                    config[key.trim()] = valueParts.join('=').trim();
                }
            }
        }
    }
    return config;
};

// 保存配置
const saveConfig = (config: Record<string, string>): void => {
    const lines: string[] = [
        '# Polymarket 跨池套利机器人配置',
        `# 生成时间: ${new Date().toLocaleString('zh-CN')}`,
        '',
        '# ========== 必填配置 ==========',
        `PRIVATE_KEY=${config.PRIVATE_KEY || ''}`,
        `PROXY_WALLET=${config.PROXY_WALLET || ''}`,
        '',
        '# ========== 模式 ==========',
        `SIMULATION_MODE=${config.SIMULATION_MODE || 'true'}`,
        `CLEAR_DATA_ON_START=${config.CLEAR_DATA_ON_START || 'false'}`,
        '',
        '# ========== 市场开关（0=关闭，1=开启）==========',
        `ENABLE_15MIN=${config.ENABLE_15MIN || '1'}`,
        `ENABLE_1HR=${config.ENABLE_1HR || '1'}`,
        '',
        '# ========== 交易参数 ==========',
        `MAX_ORDER_SIZE_USD=${config.MAX_ORDER_SIZE_USD || '14'}`,
        `PRICE_TOLERANCE_PERCENT=${config.PRICE_TOLERANCE_PERCENT || '0.5'}`,
        `MIN_CROSS_POOL_SINGLE_PRICE=${config.MIN_CROSS_POOL_SINGLE_PRICE || '0.25'}`,
        `MIN_PROFIT_USD=${config.MIN_PROFIT_USD || '0.01'}`,
        `MIN_ARBITRAGE_PERCENT=${config.MIN_ARBITRAGE_PERCENT || '6'}`,
        `MAX_ARBITRAGE_PERCENT_INITIAL=${config.MAX_ARBITRAGE_PERCENT_INITIAL || '30'}`,
        `MAX_ARBITRAGE_PERCENT_FINAL=${config.MAX_ARBITRAGE_PERCENT_FINAL || '15'}`,
        `MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES=${config.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES || '13'}`,
        `DEPTH_USAGE_PERCENT=${config.DEPTH_USAGE_PERCENT || '90'}`,
        '',
        '# ========== 止损配置 ==========',
        `STOP_LOSS_ENABLED=${config.STOP_LOSS_ENABLED || 'true'}`,
        `STOP_LOSS_MODE=${config.STOP_LOSS_MODE || 'sell'}`,
        `STOP_LOSS_WINDOW_SEC=${config.STOP_LOSS_WINDOW_SEC || '180'}`,
        `STOP_LOSS_COST_THRESHOLD=${config.STOP_LOSS_COST_THRESHOLD || '0.5'}`,
        `STOP_LOSS_RISK_RATIO=${config.STOP_LOSS_RISK_RATIO || '60'}`,
        `STOP_LOSS_MIN_TRIGGER_COUNT=${config.STOP_LOSS_MIN_TRIGGER_COUNT || '100'}`,
        '',
        '# 币安波动率风控（可选，检测BTC涨跌幅过小时触发对冲）',
        `BINANCE_VOLATILITY_CHECK_ENABLED=${config.BINANCE_VOLATILITY_CHECK_ENABLED || 'false'}`,
        `BINANCE_CHECK_WINDOW_SEC=${config.BINANCE_CHECK_WINDOW_SEC || '60'}`,
        `BINANCE_MIN_VOLATILITY_PERCENT=${config.BINANCE_MIN_VOLATILITY_PERCENT || '0.1'}`,
        '',
        '# 同池增持策略（利用平均持仓价在同池内平衡，允许少量亏损换取成交）',
        `SAME_POOL_REBALANCE_ENABLED=${config.SAME_POOL_REBALANCE_ENABLED || 'true'}`,
        `SAME_POOL_SAFETY_MARGIN=${config.SAME_POOL_SAFETY_MARGIN || '2'}`,
        '',
        '# 紧急平衡（最后X秒停止跨池，放宽同池限制）',
        `EMERGENCY_BALANCE_ENABLED=${config.EMERGENCY_BALANCE_ENABLED || 'true'}`,
        `EMERGENCY_BALANCE_SECONDS=${config.EMERGENCY_BALANCE_SECONDS || '20'}`,
        `EMERGENCY_BALANCE_THRESHOLD=${config.EMERGENCY_BALANCE_THRESHOLD || '60'}`,
        `EMERGENCY_BALANCE_MAX_LOSS=${config.EMERGENCY_BALANCE_MAX_LOSS || '2'}`,
        '',
        '# 极端不平衡提前平仓（平衡度<30%说明走势确定，平掉会输的一边）',
        `EXTREME_IMBALANCE_ENABLED=${config.EXTREME_IMBALANCE_ENABLED || 'true'}`,
        `EXTREME_IMBALANCE_SECONDS=${config.EXTREME_IMBALANCE_SECONDS || '90'}`,
        `EXTREME_IMBALANCE_THRESHOLD=${config.EXTREME_IMBALANCE_THRESHOLD || '30'}`,
        '',
    ];
    
    fs.writeFileSync(ENV_FILE, lines.join('\n'), 'utf-8');
};

// 主函数
const main = async () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║      🤖 Polymarket 跨池套利机器人 - 配置向导              ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    
    const existingConfig = loadExistingConfig();
    const hasExisting = Object.keys(existingConfig).length > 0;
    
    if (hasExisting) {
        log.info('发现已有配置文件 .env');
        const overwrite = await question('是否要重新配置？(y/n，默认 n): ');
        if (overwrite.toLowerCase() !== 'y') {
            log.info('保留现有配置，退出');
            rl.close();
            return;
        }
    }
    
    const config: Record<string, string> = { ...existingConfig };
    
    // ===== 先选择模式（决定是否需要填写私钥）=====
    log.title('🔒 模式选择');
    log.info('模拟模式：不会真实下单，不需要私钥，用于测试和观察市场');
    log.info('实盘模式：真实下单，需要私钥和钱包地址');
    const simMode = await question('启用模拟模式？(y/n，默认 y): ');
    config.SIMULATION_MODE = simMode.toLowerCase() === 'n' ? 'false' : 'true';
    
    const isSimulation = config.SIMULATION_MODE === 'true';
    
    // ===== 私钥和钱包地址（实盘模式必填）=====
    if (isSimulation) {
        log.title('📝 钱包配置（可选）');
        log.info('模拟模式下不需要填写，直接回车跳过');
        
        const currentPK = config.PRIVATE_KEY ? '(已有，回车保留)' : '(可跳过)';
        let pk = await question(`钱包私钥 ${currentPK}: `);
        if (pk) {
            pk = pk.replace(/^0x/, '');
            if (pk.length === 64) {
                config.PRIVATE_KEY = pk;
                log.success('私钥已设置');
            } else {
                log.error('私钥格式不正确，已跳过');
            }
        }
        
        const currentWallet = config.PROXY_WALLET ? `(当前: ${config.PROXY_WALLET.slice(0, 10)}...)` : '(可跳过)';
        const wallet = await question(`钱包地址 ${currentWallet}: `);
        if (wallet) {
            if (wallet.startsWith('0x') && wallet.length === 42) {
                config.PROXY_WALLET = wallet;
                log.success('钱包地址已设置');
            } else {
                log.error('钱包地址格式不正确，已跳过');
            }
        }
    } else {
        log.title('📝 钱包配置（必填）');
        log.warning('实盘模式需要填写私钥和钱包地址！');
        log.warning('私钥用于签名交易，请确保安全保管！');
        
        // 私钥必填
        while (!config.PRIVATE_KEY || config.PRIVATE_KEY.length !== 64) {
            const currentPK = config.PRIVATE_KEY ? '(已有，回车保留)' : '';
            let pk = await question(`钱包私钥 ${currentPK}: `);
            if (!pk && config.PRIVATE_KEY) break;  // 已有则跳过
            if (pk) {
                pk = pk.replace(/^0x/, '');
                if (pk.length === 64) {
                    config.PRIVATE_KEY = pk;
                    log.success('私钥已设置');
                } else {
                    log.error('私钥格式不正确，应为 64 位十六进制，请重新输入');
                }
            } else {
                log.error('实盘模式必须填写私钥');
            }
        }
        
        // 钱包地址必填
        while (!config.PROXY_WALLET || config.PROXY_WALLET.length !== 42) {
            const currentWallet = config.PROXY_WALLET ? `(当前: ${config.PROXY_WALLET.slice(0, 10)}...)` : '';
            const wallet = await question(`钱包地址 ${currentWallet}: `);
            if (!wallet && config.PROXY_WALLET) break;  // 已有则跳过
            if (wallet) {
                if (wallet.startsWith('0x') && wallet.length === 42) {
                    config.PROXY_WALLET = wallet;
                    log.success('钱包地址已设置');
                } else {
                    log.error('钱包地址格式不正确，请重新输入');
                }
            } else {
                log.error('实盘模式必须填写钱包地址');
            }
        }
    }
    
    // ===== 清除历史数据 =====
    log.title('🧹 数据选项');
    log.info('启用后每次启动会清除历史数据，从零开始');
    const clearData = await question('每次启动清除历史数据？(y/n，默认 n): ');
    config.CLEAR_DATA_ON_START = clearData.toLowerCase() === 'y' ? 'true' : 'false';
    
    // ===== 市场开关 =====
    log.title('📊 市场选择');
    log.info('可以选择只开启某个时间段的市场');
    
    const enable15min = await question('开启 15分钟场？(0=关闭, 1=开启，默认 1): ');
    config.ENABLE_15MIN = enable15min === '0' ? '0' : '1';
    
    const enable1hr = await question('开启 1小时场？(0=关闭, 1=开启，默认 1): ');
    config.ENABLE_1HR = enable1hr === '0' ? '0' : '1';
    
    // ===== 交易参数 =====
    log.title('💰 交易参数');
    
    const currentMaxOrder = config.MAX_ORDER_SIZE_USD || '14';
    const maxOrder = await question(`单笔最大下单金额 USD (当前: ${currentMaxOrder}): `);
    if (maxOrder && !isNaN(parseFloat(maxOrder))) {
        config.MAX_ORDER_SIZE_USD = maxOrder;
    } else if (!config.MAX_ORDER_SIZE_USD) {
        config.MAX_ORDER_SIZE_USD = '14';
    }
    
    const currentPriceTolerance = config.PRICE_TOLERANCE_PERCENT || '0.5';
    const priceTolerance = await question(`同池出价容忍度 % (仅同池套利加价提高成交率, 当前: ${currentPriceTolerance}): `);
    if (priceTolerance && !isNaN(parseFloat(priceTolerance))) {
        config.PRICE_TOLERANCE_PERCENT = priceTolerance;
    } else if (!config.PRICE_TOLERANCE_PERCENT) {
        config.PRICE_TOLERANCE_PERCENT = '0.5';
    }
    
    const currentMinSinglePrice = config.MIN_CROSS_POOL_SINGLE_PRICE || '0.25';
    const minSinglePrice = await question(`跨池单边最低价格 (低于此值跳过, 当前: ${currentMinSinglePrice}): `);
    if (minSinglePrice && !isNaN(parseFloat(minSinglePrice))) {
        config.MIN_CROSS_POOL_SINGLE_PRICE = minSinglePrice;
    } else if (!config.MIN_CROSS_POOL_SINGLE_PRICE) {
        config.MIN_CROSS_POOL_SINGLE_PRICE = '0.25';
    }
    
    const currentMinProfit = config.MIN_PROFIT_USD || '0.01';
    const minProfit = await question(`最小利润额 USD (当前: ${currentMinProfit}): `);
    if (minProfit && !isNaN(parseFloat(minProfit))) {
        config.MIN_PROFIT_USD = minProfit;
    } else if (!config.MIN_PROFIT_USD) {
        config.MIN_PROFIT_USD = '0.01';
    }
    
    console.log('');
    log.info('═══════════════════════════════════════════════════════');
    log.info('最小利润率 - 过滤利润率太低的交易');
    log.info('');
    log.info('  利润率 = (1 - 组合成本) / 组合成本 × 100%');
    log.info('');
    log.info('  示例：');
    log.info('    组合成本 $0.98 → 利润率 2%');
    log.info('    组合成本 $0.95 → 利润率 5%');
    log.info('    组合成本 $0.90 → 利润率 11%');
    log.info('');
    log.info('  设置 5% 意味着只做组合成本 < $0.95 的交易');
    log.info('  太低（如 0.1%）会接受高成本低利润的交易，亏损时损失大');
    log.info('═══════════════════════════════════════════════════════');
    const currentMinArbPercent = config.MIN_ARBITRAGE_PERCENT || '2';
    const minArbPercent = await question(`最小利润率 % (当前: ${currentMinArbPercent}): `);
    if (minArbPercent && !isNaN(parseFloat(minArbPercent))) {
        config.MIN_ARBITRAGE_PERCENT = minArbPercent;
    } else if (!config.MIN_ARBITRAGE_PERCENT) {
        config.MIN_ARBITRAGE_PERCENT = '2';
    }
    
    console.log('');
    log.info('═══════════════════════════════════════════════════════');
    log.info('组合成本下限（动态）- 防止在市场分歧大时开仓');
    log.info('');
    log.info('  组合成本下限 = 1 - 敞口%');
    log.info('');
    log.info('  示例：');
    log.info('    敞口 30% → 组合成本 > $0.70 可交易');
    log.info('    敞口 15% → 组合成本 > $0.85 可交易');
    log.info('');
    log.info('  策略：开盘波动大，允许较大敞口；后期逐渐收紧');
    log.info('═══════════════════════════════════════════════════════');
    
    const currentInitial = config.MAX_ARBITRAGE_PERCENT_INITIAL || '30';
    const initialArb = await question(`初始敞口 % (当前: ${currentInitial}): `);
    if (initialArb && !isNaN(parseFloat(initialArb))) {
        config.MAX_ARBITRAGE_PERCENT_INITIAL = initialArb;
    } else if (!config.MAX_ARBITRAGE_PERCENT_INITIAL) {
        config.MAX_ARBITRAGE_PERCENT_INITIAL = '30';
    }
    
    const currentFinal = config.MAX_ARBITRAGE_PERCENT_FINAL || '15';
    const finalArb = await question(`最终敞口 % (当前: ${currentFinal}): `);
    if (finalArb && !isNaN(parseFloat(finalArb))) {
        config.MAX_ARBITRAGE_PERCENT_FINAL = finalArb;
    } else if (!config.MAX_ARBITRAGE_PERCENT_FINAL) {
        config.MAX_ARBITRAGE_PERCENT_FINAL = '15';
    }
    
    const currentTighten = config.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES || '13';
    const tightenInput = await question(`收紧时长(分钟) (当前: ${currentTighten}): `);
    if (tightenInput && !isNaN(parseInt(tightenInput))) {
        config.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES = tightenInput;
    } else if (!config.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES) {
        config.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES = '13';
    }
    
    const currentDepth = config.DEPTH_USAGE_PERCENT || '90';
    const depth = await question(`深度使用百分比 % (当前: ${currentDepth}): `);
    if (depth && !isNaN(parseFloat(depth))) {
        config.DEPTH_USAGE_PERCENT = depth;
    } else if (!config.DEPTH_USAGE_PERCENT) {
        config.DEPTH_USAGE_PERCENT = '90';
    }
    
    // ===== 止损配置 =====
    log.title('🚨 止损配置');
    console.log('');
    log.info('═══════════════════════════════════════════════════════');
    log.info('止损功能 - 在事件结束前检测风险并提前平仓');
    log.info('');
    log.info('原理：');
    log.info('  BTC 涨 + ETH 跌 或 BTC 跌 + ETH 涨 = "双输"场景');
    log.info('  此时组合价格会很低（如 $0.3-$0.5）');
    log.info('  通过统计低价组合的出现频率来判断风险');
    log.info('');
    log.info('触发条件：');
    log.info('  最后 N 秒内，组合价格 < 阈值 的次数 / 总扫描次数 ≥ 风险比例');
    log.info('  且 触发次数 ≥ 最小次数');
    log.info('');
    log.info('触发后：');
    log.info('  立即卖出所有持仓，暂停开仓，等待下一个事件');
    log.info('═══════════════════════════════════════════════════════');
    
    const stopLossEnabled = await question('启用止损功能？(y/n，默认 y): ');
    config.STOP_LOSS_ENABLED = stopLossEnabled.toLowerCase() === 'n' ? 'false' : 'true';
    
    if (config.STOP_LOSS_ENABLED !== 'false') {
        console.log('');
        log.info('═══════════════════════════════════════════════════════');
        log.info('止损模式选择');
        log.info('');
        log.info('  sell  - 平仓止损（推荐）');
        log.info('          检测到风险后卖出仓位，接受部分亏损');
        log.info('          ✅ 优点：不需要额外资金，释放资金用于下一轮');
        log.info('          ⚠️ 缺点：如果市场反转回来，已卖无法获益');
        log.info('');
        log.info('  hedge - 同池对冲');
        log.info('          检测到风险后，在各自池子内补仓使两边 shares 相等');
        log.info('          ✅ 优点：收回金额确定（无论结果）');
        log.info('          ⚠️ 缺点：需要额外资金');
        log.info('');
        log.info('  ════════════════════════════════════════════════════════');
        log.info('  ⚠️ 重要发现：平仓亏损 = 对冲亏损（金额完全相同）！');
        log.info('');
        log.info('  公式：亏损 = (原买入组合价 - 当前组合价) × shares');
        log.info('');
        log.info('  例如：原买入 $0.85，当前 $0.65');
        log.info('    → 平仓亏损 = $850 - $650 = $200');
        log.info('    → 对冲亏损 = $2200 - $2000 = $200');
        log.info('');
        log.info('  既然亏损相同，推荐用 sell（平仓）：');
        log.info('    - 不需要额外资金');
        log.info('    - 释放资金可用于下一轮');
        log.info('  ════════════════════════════════════════════════════════');
        log.info('');
        log.info('            ETH 池：补 ETH Up 至 = ETH Down');
        log.info('');
        log.info('          结果分析：');
        log.info('            正常套利 → 双赢大赚 / 单赢小赚');
        log.info('            触发对冲 → 锁定收回金额，减少亏损');
        log.info('            效果：避免"双输"场景的 100% 亏损');
        log.info('═══════════════════════════════════════════════════════');
        const currentMode = config.STOP_LOSS_MODE || 'hedge';
        const modeInput = await question(`止损模式 sell/hedge (当前: ${currentMode}): `);
        if (modeInput === 'sell' || modeInput === 'hedge') {
            config.STOP_LOSS_MODE = modeInput;
        } else if (!config.STOP_LOSS_MODE) {
            config.STOP_LOSS_MODE = 'hedge';
        }
        
        const currentWindow = config.STOP_LOSS_WINDOW_SEC || '180';
        log.info(`监控窗口：结束前多少秒开始统计风险`);
        const windowSec = await question(`监控窗口 秒 (当前: ${currentWindow}): `);
        if (windowSec && !isNaN(parseInt(windowSec))) {
            config.STOP_LOSS_WINDOW_SEC = windowSec;
        } else if (!config.STOP_LOSS_WINDOW_SEC) {
            config.STOP_LOSS_WINDOW_SEC = '180';
        }
        
        console.log('');
        log.info('═══════════════════════════════════════════════════════');
        log.info('风险阈值 - 组合价格低于此值算作"风险信号"');
        log.info('');
        log.info('  正常情况：组合价格 $0.85-$1.00（BTC/ETH 同向）');
        log.info('  风险情况：组合价格 $0.30-$0.50（BTC/ETH 反向）');
        log.info('');
        log.info('  建议设置 $0.4-$0.6 之间');
        log.info('═══════════════════════════════════════════════════════');
        const currentCostThreshold = config.STOP_LOSS_COST_THRESHOLD || '0.5';
        const costThreshold = await question(`风险阈值 $ (当前: ${currentCostThreshold}): `);
        if (costThreshold && !isNaN(parseFloat(costThreshold))) {
            config.STOP_LOSS_COST_THRESHOLD = costThreshold;
        } else if (!config.STOP_LOSS_COST_THRESHOLD) {
            config.STOP_LOSS_COST_THRESHOLD = '0.5';
        }
        
        console.log('');
        log.info('═══════════════════════════════════════════════════════');
        log.info('风险比例 - 触发止损的阈值');
        log.info('');
        log.info('  例如 60% 意味着：');
        log.info('  如果监控窗口内 60% 的扫描组合价格 < 风险阈值，触发止损');
        log.info('');
        log.info('  可输入 60 或 0.6，都表示 60%');
        log.info('═══════════════════════════════════════════════════════');
        const currentRiskRatio = config.STOP_LOSS_RISK_RATIO || '60';
        const riskRatio = await question(`风险比例 % (当前: ${currentRiskRatio}): `);
        if (riskRatio && !isNaN(parseFloat(riskRatio))) {
            config.STOP_LOSS_RISK_RATIO = riskRatio;
        } else if (!config.STOP_LOSS_RISK_RATIO) {
            config.STOP_LOSS_RISK_RATIO = '60';
        }
        
        const currentMinCount = config.STOP_LOSS_MIN_TRIGGER_COUNT || '100';
        log.info(`最小触发次数：避免样本太小误判`);
        const minCount = await question(`最小触发次数 (当前: ${currentMinCount}): `);
        if (minCount && !isNaN(parseInt(minCount))) {
            config.STOP_LOSS_MIN_TRIGGER_COUNT = minCount;
        } else if (!config.STOP_LOSS_MIN_TRIGGER_COUNT) {
            config.STOP_LOSS_MIN_TRIGGER_COUNT = '100';
        }
        
        // 币安波动率风控
        console.log('');
        log.info('========== 币安波动率风控 ==========');
        log.info('当 BTC 涨跌幅过小时，结果难以预测，容易导致双输');
        log.info('启用后：在事件即将结束时检查 BTC 涨跌幅，过小则触发对冲');
        console.log('');
        
        const currentBinanceEnabled = config.BINANCE_VOLATILITY_CHECK_ENABLED || 'false';
        const binanceEnabled = await question(`启用币安波动率检查 [true/false] (当前: ${currentBinanceEnabled}): `);
        if (binanceEnabled === 'true' || binanceEnabled === 'false') {
            config.BINANCE_VOLATILITY_CHECK_ENABLED = binanceEnabled;
        }
        
        if (config.BINANCE_VOLATILITY_CHECK_ENABLED === 'true') {
            const currentWindow = config.BINANCE_CHECK_WINDOW_SEC || '60';
            log.info(`检查窗口：距离事件结束多少秒开始检查`);
            const window = await question(`检查窗口秒数 (当前: ${currentWindow}): `);
            if (window && !isNaN(parseInt(window))) {
                config.BINANCE_CHECK_WINDOW_SEC = window;
            } else if (!config.BINANCE_CHECK_WINDOW_SEC) {
                config.BINANCE_CHECK_WINDOW_SEC = '60';
            }
            
            const currentVolatility = config.BINANCE_MIN_VOLATILITY_PERCENT || '0.1';
            log.info(`最小波动率：BTC 涨跌幅低于此值触发对冲`);
            log.info(`例如：0.1 表示 BTC 15分钟涨跌幅 < 0.1% 时触发`);
            const volatility = await question(`最小波动率% (当前: ${currentVolatility}): `);
            if (volatility && !isNaN(parseFloat(volatility))) {
                config.BINANCE_MIN_VOLATILITY_PERCENT = volatility;
            } else if (!config.BINANCE_MIN_VOLATILITY_PERCENT) {
                config.BINANCE_MIN_VOLATILITY_PERCENT = '0.1';
            }
        }
    }
    
    // ===== 同池增持策略 =====
    console.log('');
    log.info('═══════════════════════════════════════════════════════');
    log.info('同池增持策略 - 利用平均持仓价在同池内套利');
    log.info('');
    log.info('原理：');
    log.info('  跨池套利时，你的 BTC Up 成本可能是 $0.45（因为配对 ETH Down $0.49）');
    log.info('  如果 BTC Down 当前价 $0.52，则：$0.45 + $0.52 = $0.97 < 1');
    log.info('  这就是一个同池套利机会！买入 BTC Down 可以逐步平衡仓位');
    log.info('');
    log.info('目标：');
    log.info('  让每个池的 Up/Down 数量相等 → 无论结果都盈利');
    log.info('');
    log.info('⚠️ 重要风险：');
    log.info('  如果同池买入价格过高，会导致平均组合成本 > 1，即使 100% 平衡也亏损！');
    log.info('  例如：Up 平均 $0.56 + Down 平均 $0.49 = $1.05 > 1 → 亏损');
    log.info('═══════════════════════════════════════════════════════');
    console.log('');
    
    const currentSamePool = config.SAME_POOL_REBALANCE_ENABLED || 'true';
    const samePoolEnabled = await question(`启用同池增持 [true/false] (当前: ${currentSamePool}): `);
    if (samePoolEnabled === 'true' || samePoolEnabled === 'false') {
        config.SAME_POOL_REBALANCE_ENABLED = samePoolEnabled;
    }
    
    if (config.SAME_POOL_REBALANCE_ENABLED === 'true') {
        console.log('');
        log.info('═══════════════════════════════════════════════════════');
        log.info('同池安全边际 - 确保平均组合成本 < 1');
        log.info('');
        log.info('  公式：最高可买价 = (1 - 平均持仓价) × (1 + 安全边际%)');
        log.info('');
        log.info('  示例（安全边际 2%）：');
        log.info('    持仓 Up 平均 $0.45');
        log.info('    最高可接受 Down 价格 = 0.55 × 1.02 = $0.561');
        log.info('    组合成本 = 0.45 + 0.561 = $1.011（允许亏1.1%换取平衡）');
        log.info('');
        log.info('  建议：1-2%（牺牲少量利润换取更高成交率）');
        log.info('  说明：跨池已有5-6%利润，同池亏2%后仍有3-4%总利润');
        log.info('═══════════════════════════════════════════════════════');
        const currentSafetyMargin = config.SAME_POOL_SAFETY_MARGIN || '2';
        const safetyMargin = await question(`同池允许亏损 % (当前: ${currentSafetyMargin}): `);
        if (safetyMargin && !isNaN(parseFloat(safetyMargin))) {
            config.SAME_POOL_SAFETY_MARGIN = safetyMargin;
        } else if (!config.SAME_POOL_SAFETY_MARGIN) {
            config.SAME_POOL_SAFETY_MARGIN = '3';
        }
        
        // ===== 紧急平衡 =====
        console.log('');
        log.info('═══════════════════════════════════════════════════════');
        log.info('紧急平衡 - 最后 X 秒强制平衡不平衡的仓位');
        log.info('');
        log.info('场景：');
        log.info('  事件快结束时，平衡度只有 30%，正常模式找不到 <0.98 的机会');
        log.info('  紧急平衡允许放宽限制，接受小亏损换取平衡');
        log.info('');
        log.info('触发条件：');
        log.info('  1. 距离事件结束 < X 秒');
        log.info('  2. 任一池平衡度 < Y%');
        log.info('');
        log.info('紧急模式下：');
        log.info('  买入条件从 < 1-2% 放宽到 < 1+Z%');
        log.info('  例如允许 5% 亏损：平均 $0.45 + 深度 $0.58 = $1.03 也能买');
        log.info('═══════════════════════════════════════════════════════');
        
        const currentEmergencyEnabled = config.EMERGENCY_BALANCE_ENABLED || 'true';
        const emergencyEnabled = await question(`启用紧急平衡 [true/false] (当前: ${currentEmergencyEnabled}): `);
        if (emergencyEnabled === 'true' || emergencyEnabled === 'false') {
            config.EMERGENCY_BALANCE_ENABLED = emergencyEnabled;
        }
        
        if (config.EMERGENCY_BALANCE_ENABLED === 'true') {
            const currentSeconds = config.EMERGENCY_BALANCE_SECONDS || '20';
            const seconds = await question(`最后多少秒触发 (当前: ${currentSeconds}): `);
            if (seconds && !isNaN(parseInt(seconds))) {
                config.EMERGENCY_BALANCE_SECONDS = seconds;
            } else if (!config.EMERGENCY_BALANCE_SECONDS) {
                config.EMERGENCY_BALANCE_SECONDS = '20';
            }
            
            const currentThreshold = config.EMERGENCY_BALANCE_THRESHOLD || '60';
            const threshold = await question(`平衡度低于多少%触发 (当前: ${currentThreshold}): `);
            if (threshold && !isNaN(parseFloat(threshold))) {
                config.EMERGENCY_BALANCE_THRESHOLD = threshold;
            } else if (!config.EMERGENCY_BALANCE_THRESHOLD) {
                config.EMERGENCY_BALANCE_THRESHOLD = '60';
            }
            
            console.log('');
            log.info('═══════════════════════════════════════════════════════');
            log.info('紧急平衡允许亏损 - 放宽组合价限制');
            log.info('');
            log.info('  正常模式：组合价 < 1 - 安全边际（如 < 0.98）');
            log.info('  紧急模式：组合价 < 1 + 允许亏损（如 < 1.03）');
            log.info('');
            log.info('  跨池套利 MIN_ARBITRAGE = 6% → 组合成本 ≈ 0.94');
            log.info('  正常同池 安全边际 = 2%     → 组合价 < 0.98');
            log.info('');
            log.info('  紧急模式建议：');
            log.info('    3% - 保守（放宽到 < 1.03，最多亏 3%）');
            log.info('    5% - 激进（放宽到 < 1.05，最多亏 5%）');
            log.info('');
            log.info('  ⚠️ 风险：设置过高会导致紧急买入带来更大亏损');
            log.info('═══════════════════════════════════════════════════════');
            const currentMaxLoss = config.EMERGENCY_BALANCE_MAX_LOSS || '2';
            const maxLoss = await question(`紧急平衡允许亏损 % (当前: ${currentMaxLoss}): `);
            if (maxLoss && !isNaN(parseFloat(maxLoss))) {
                config.EMERGENCY_BALANCE_MAX_LOSS = maxLoss;
            } else if (!config.EMERGENCY_BALANCE_MAX_LOSS) {
                config.EMERGENCY_BALANCE_MAX_LOSS = '2';
            }
        }
        
        // ===== 极端不平衡提前平仓 =====
        console.log('');
        log.info('═══════════════════════════════════════════════════════');
        log.info('极端不平衡提前平仓 - 走势确定时的特殊策略');
        log.info('');
        log.info('场景：');
        log.info('  平衡度 < 30%，说明 BTC/ETH 一直在单向走，没有波动');
        log.info('  走势非常确定 → BTC/ETH 大概率同向（80%一致）');
        log.info('');
        log.info('策略：');
        log.info('  不再紧急补仓，而是平掉不平衡部分，保留平衡部分');
        log.info('  结果出来后，平衡部分的盈利可以抵消平仓亏损');
        log.info('');
        log.info('示例：');
        log.info('  BTC: Up 1000, Down 300 (平衡 30%) → BTC 一直涨');
        log.info('  ETH: Up 300, Down 1000 (平衡 30%) → ETH 一直跌？不对！');
        log.info('  如果 BTC/ETH 同向，ETH 也涨 → ETH Up 会赢');
        log.info('  操作：平掉 BTC Up 700 + ETH Down 700');
        log.info('  保留：BTC 300/300 平衡 + ETH 300/300 平衡');
        log.info('═══════════════════════════════════════════════════════');
        
        const currentExtremeEnabled = config.EXTREME_IMBALANCE_ENABLED || 'true';
        const extremeEnabled = await question(`启用极端不平衡提前平仓 [true/false] (当前: ${currentExtremeEnabled}): `);
        if (extremeEnabled === 'true' || extremeEnabled === 'false') {
            config.EXTREME_IMBALANCE_ENABLED = extremeEnabled;
        }
        
        if (config.EXTREME_IMBALANCE_ENABLED === 'true') {
            const currentExtremeSeconds = config.EXTREME_IMBALANCE_SECONDS || '90';
            const extremeSeconds = await question(`最后多少秒检测 (当前: ${currentExtremeSeconds}): `);
            if (extremeSeconds && !isNaN(parseInt(extremeSeconds))) {
                config.EXTREME_IMBALANCE_SECONDS = extremeSeconds;
            } else if (!config.EXTREME_IMBALANCE_SECONDS) {
                config.EXTREME_IMBALANCE_SECONDS = '90';
            }
            
            const currentExtremeThreshold = config.EXTREME_IMBALANCE_THRESHOLD || '30';
            const extremeThreshold = await question(`平衡度低于多少%触发 (当前: ${currentExtremeThreshold}): `);
            if (extremeThreshold && !isNaN(parseFloat(extremeThreshold))) {
                config.EXTREME_IMBALANCE_THRESHOLD = extremeThreshold;
            } else if (!config.EXTREME_IMBALANCE_THRESHOLD) {
                config.EXTREME_IMBALANCE_THRESHOLD = '30';
            }
        }
    }
    
    // ===== 保存 =====
    saveConfig(config);
    
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║                    ✅ 配置完成                            ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    
    // 打印配置摘要
    console.log(`${colors.bright}📋 配置摘要${colors.reset}`);
    console.log('');
    console.log(`  🔵 模式: ${config.SIMULATION_MODE === 'true' ? '模拟（无需私钥）' : '🔴 实盘'}`);
    console.log(`  💼 钱包: ${config.PROXY_WALLET ? config.PROXY_WALLET.slice(0, 10) + '...' : '未设置'}`);
    console.log(`  🧹 启动清数据: ${config.CLEAR_DATA_ON_START === 'true' ? '是' : '否'}`);
    console.log('');
    console.log(`  📊 市场:`);
    console.log(`     15分钟场: ${config.ENABLE_15MIN === '0' ? '❌ 关闭' : '✅ 开启'}`);
    console.log(`     1小时场:  ${config.ENABLE_1HR === '0' ? '❌ 关闭' : '✅ 开启'}`);
    console.log('');
    console.log(`  💰 交易参数:`);
    console.log(`     单笔最大: $${config.MAX_ORDER_SIZE_USD}`);
    console.log(`     出价容忍度: ${config.PRICE_TOLERANCE_PERCENT}%`);
    console.log(`     跨池单边最低价: $${config.MIN_CROSS_POOL_SINGLE_PRICE}`);
    console.log(`     最小利润额: $${config.MIN_PROFIT_USD}`);
    console.log(`     最小利润率: ${config.MIN_ARBITRAGE_PERCENT}%`);
    const initial = config.MAX_ARBITRAGE_PERCENT_INITIAL || '30';
    const final = config.MAX_ARBITRAGE_PERCENT_FINAL || '15';
    const tighten = config.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES || '13';
    console.log(`     组合成本下限: $${(1 - parseFloat(initial)/100).toFixed(2)} → $${(1 - parseFloat(final)/100).toFixed(2)}（${tighten}分钟内收紧）`);
    console.log(`     深度使用: ${config.DEPTH_USAGE_PERCENT}%`);
    console.log('');
    console.log(`  🚨 止损/对冲配置:`);
    console.log(`     止损功能: ${config.STOP_LOSS_ENABLED === 'false' ? '❌ 关闭' : '✅ 开启'}`);
    if (config.STOP_LOSS_ENABLED !== 'false') {
        const mode = config.STOP_LOSS_MODE || 'hedge';
        const modeLabel = mode === 'sell' ? '📉 平仓止损（推荐）' : '🛡️ 同池对冲';
        console.log(`     止损模式: ${modeLabel}`);
        console.log(`       └─ 亏损公式: (原组合价 - 当前组合价) × shares`);
        console.log(`       └─ 平仓和对冲亏损金额相同，平仓不需要额外资金`);
        if (mode === 'hedge') {
            console.log(`       └─ 对冲需要额外资金，但收回金额确定`);
        }
        console.log(`     监控窗口: 结束前 ${config.STOP_LOSS_WINDOW_SEC || '180'} 秒`);
        console.log(`     风险阈值: 组合价格 < $${config.STOP_LOSS_COST_THRESHOLD || '0.5'}`);
        const ratioVal = parseFloat(config.STOP_LOSS_RISK_RATIO || '60');
        const ratioPercent = ratioVal > 1 ? ratioVal : ratioVal * 100;
        console.log(`     触发条件: 比例 ≥${ratioPercent.toFixed(0)}% 且 次数 ≥${config.STOP_LOSS_MIN_TRIGGER_COUNT || '100'}`);
    }
    console.log('');
    console.log(`  🔄 同池增持策略:`);
    console.log(`     同池增持: ${config.SAME_POOL_REBALANCE_ENABLED === 'true' ? '✅ 开启' : '❌ 关闭'}`);
    if (config.SAME_POOL_REBALANCE_ENABLED === 'true') {
        const safetyMargin = config.SAME_POOL_SAFETY_MARGIN || '2';
        const priceTolerance = config.PRICE_TOLERANCE_PERCENT || '0.5';
        console.log(`     允许亏损: ${safetyMargin}%（牺牲利润换取平衡成交）`);
        console.log(`     出价加价: ${priceTolerance}%（仅同池，提高成交率）`);
        console.log(`     紧急平衡: ${config.EMERGENCY_BALANCE_ENABLED === 'true' ? '✅ 开启' : '❌ 关闭'}`);
        if (config.EMERGENCY_BALANCE_ENABLED === 'true') {
            const emergencySec = config.EMERGENCY_BALANCE_SECONDS || '20';
            const emergencyThreshold = config.EMERGENCY_BALANCE_THRESHOLD || '60';
            const emergencyMaxLoss = config.EMERGENCY_BALANCE_MAX_LOSS || '3';
            console.log(`       └─ 触发: 最后 ${emergencySec}秒 + 平衡度 < ${emergencyThreshold}%`);
            console.log(`       └─ 放宽: 组合价 < ${(1 + parseFloat(emergencyMaxLoss)/100).toFixed(2)}（允许 ${emergencyMaxLoss}% 亏损）`);
        }
        console.log(`     极端不平衡: ${config.EXTREME_IMBALANCE_ENABLED === 'true' ? '✅ 开启' : '❌ 关闭'}`);
        if (config.EXTREME_IMBALANCE_ENABLED === 'true') {
            const extremeSec = config.EXTREME_IMBALANCE_SECONDS || '90';
            const extremeThreshold = config.EXTREME_IMBALANCE_THRESHOLD || '30';
            console.log(`       └─ 触发: 最后 ${extremeSec}秒 + 平衡度 < ${extremeThreshold}%`);
            console.log(`       └─ 策略: 平掉不平衡部分，保留平衡部分等结算`);
        }
    }
    console.log('');
    
    // 参数关系说明
    console.log(`${colors.bright}📊 参数关系图${colors.reset}`);
    console.log('');
    console.log('  有效交易区间：');
    console.log('  ┌─────────────────────────────────────────────────────┐');
    console.log(`  │  $${(1 - parseFloat(initial)/100).toFixed(2)} ─────────────────────────────── $${(1 - parseFloat(config.MIN_ARBITRAGE_PERCENT || '2') / 100 / (1 + parseFloat(config.MIN_ARBITRAGE_PERCENT || '2') / 100)).toFixed(2)}  │`);
    console.log('  │    ↑                                         ↑     │');
    console.log('  │  组合成本下限                          利润率下限   │');
    console.log('  │  (敞口限制)                            (MIN_ARB%)   │');
    console.log('  └─────────────────────────────────────────────────────┘');
    console.log('');
    console.log(`  ⚠️  组合成本 < $${(1 - parseFloat(initial)/100).toFixed(2)} 时跳过（敞口过大）`);
    console.log(`  ⚠️  组合成本 > $${(1 - parseFloat(config.MIN_ARBITRAGE_PERCENT || '2') / 100 / (1 + parseFloat(config.MIN_ARBITRAGE_PERCENT || '2') / 100)).toFixed(2)} 时跳过（利润率过低）`);
    console.log('');
    
    log.success('配置已保存到 .env');
    log.success('启动命令: npm run dev');
    console.log('');
    
    rl.close();
};

main().catch((error) => {
    console.error('配置出错:', error);
    rl.close();
    process.exit(1);
});
