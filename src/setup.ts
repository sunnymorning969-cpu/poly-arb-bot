/**
 * 交互式配置脚本
 * 
 * 运行: npm run setup
 * 自动创建 .env 文件，只需填写私钥和钱包地址
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
        '# Polymarket 套利机器人配置',
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
        `MIN_PROFIT_USD=${config.MIN_PROFIT_USD || '0.01'}`,
        `MIN_ARBITRAGE_PERCENT=${config.MIN_ARBITRAGE_PERCENT || '0.1'}`,
        `MAX_ARBITRAGE_PERCENT_INITIAL=${config.MAX_ARBITRAGE_PERCENT_INITIAL || '30'}`,
        `MAX_ARBITRAGE_PERCENT_FINAL=${config.MAX_ARBITRAGE_PERCENT_FINAL || '15'}`,
        `MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES=${config.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES || '13'}`,
        `DEPTH_USAGE_PERCENT=${config.DEPTH_USAGE_PERCENT || '90'}`,
        '',
        '# ========== 止损配置 ==========',
        `STOP_LOSS_ENABLED=${config.STOP_LOSS_ENABLED || 'true'}`,
        `STOP_LOSS_WINDOW_SEC=${config.STOP_LOSS_WINDOW_SEC || '180'}`,
        `STOP_LOSS_COST_THRESHOLD=${config.STOP_LOSS_COST_THRESHOLD || '0.6'}`,
        `STOP_LOSS_CHECK_INTERVAL_MS=${config.STOP_LOSS_CHECK_INTERVAL_MS || '1000'}`,
        `STOP_LOSS_RISK_RATIO=${config.STOP_LOSS_RISK_RATIO || '0.7'}`,
        `STOP_LOSS_MIN_TRIGGER_COUNT=${config.STOP_LOSS_MIN_TRIGGER_COUNT || '30'}`,
        '',
    ];
    
    fs.writeFileSync(ENV_FILE, lines.join('\n'), 'utf-8');
};

// 主函数
const main = async () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║      🤖 Polymarket 套利机器人 - 配置向导                  ║');
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
    const maxOrder = await question(`最大单笔下单金额 USD (当前: ${currentMaxOrder}): `);
    if (maxOrder && !isNaN(parseFloat(maxOrder))) {
        config.MAX_ORDER_SIZE_USD = maxOrder;
    } else if (!config.MAX_ORDER_SIZE_USD) {
        config.MAX_ORDER_SIZE_USD = '14';
    }
    
    const currentMinProfit = config.MIN_PROFIT_USD || '0.01';
    const minProfit = await question(`最小套利利润 USD (当前: ${currentMinProfit}): `);
    if (minProfit && !isNaN(parseFloat(minProfit))) {
        config.MIN_PROFIT_USD = minProfit;
    } else if (!config.MIN_PROFIT_USD) {
        config.MIN_PROFIT_USD = '0.01';
    }
    
    log.info('最小利润率：控制套利空间的下限，过滤掉利润率太低的交易');
    log.info('例如：5% 意味着只做组合成本 < $0.95 的交易（利润率 ≥ 5%）');
    log.info('利润率 = (1 - 组合成本) / 组合成本');
    const currentMinArbPercent = config.MIN_ARBITRAGE_PERCENT || '0.1';
    const minArbPercent = await question(`最小利润率 % (当前: ${currentMinArbPercent}): `);
    if (minArbPercent && !isNaN(parseFloat(minArbPercent))) {
        config.MIN_ARBITRAGE_PERCENT = minArbPercent;
    } else if (!config.MIN_ARBITRAGE_PERCENT) {
        config.MIN_ARBITRAGE_PERCENT = '0.1';
    }
    
    log.info('最大套利敞口（动态）：开盘波动大允许大敞口，后期逐渐收紧');
    log.info('公式：敞口从初始值线性收紧到最终值');
    
    const currentInitial = config.MAX_ARBITRAGE_PERCENT_INITIAL || '30';
    log.info(`初始敞口：开盘时允许的最大敞口（例如 30% = 组合成本>$0.70可交易）`);
    const initialArb = await question(`初始敞口 % (当前: ${currentInitial}): `);
    if (initialArb && !isNaN(parseFloat(initialArb))) {
        config.MAX_ARBITRAGE_PERCENT_INITIAL = initialArb;
    } else if (!config.MAX_ARBITRAGE_PERCENT_INITIAL) {
        config.MAX_ARBITRAGE_PERCENT_INITIAL = '30';
    }
    
    const currentFinal = config.MAX_ARBITRAGE_PERCENT_FINAL || '15';
    log.info(`最终敞口：后期收紧后的敞口限制（例如 15% = 组合成本>$0.85才可交易）`);
    const finalArb = await question(`最终敞口 % (当前: ${currentFinal}): `);
    if (finalArb && !isNaN(parseFloat(finalArb))) {
        config.MAX_ARBITRAGE_PERCENT_FINAL = finalArb;
    } else if (!config.MAX_ARBITRAGE_PERCENT_FINAL) {
        config.MAX_ARBITRAGE_PERCENT_FINAL = '15';
    }
    
    const currentTighten = config.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES || '13';
    log.info(`收紧时长：在多少分钟内完成从初始到最终的收紧`);
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
    log.info('止损功能：在事件结束前检测"最坏情况"（BTC跌+ETH涨 或 BTC涨+ETH跌），提前卖出减少损失');
    log.info('原理：每次扫描到套利机会时记录组合价格，统计低于风险阈值的占比');
    log.info('触发条件：最后N秒内，组合价格<风险阈值的次数 / 总扫描次数 ≥ 风险比例 且 次数 ≥ 最小次数');
    log.info('止损后：仓位会被清除，盈亏会计入统计，暂停开仓等待下一个事件');
    
    const stopLossEnabled = await question('启用止损功能？(y/n，默认 y): ');
    config.STOP_LOSS_ENABLED = stopLossEnabled.toLowerCase() === 'n' ? 'false' : 'true';
    
    if (config.STOP_LOSS_ENABLED !== 'false') {
        const currentWindow = config.STOP_LOSS_WINDOW_SEC || '180';
        log.info(`监控窗口：结束前多少秒开始统计风险（默认180秒=倒数第3分钟）`);
        const windowSec = await question(`监控窗口 秒 (当前: ${currentWindow}): `);
        if (windowSec && !isNaN(parseInt(windowSec))) {
            config.STOP_LOSS_WINDOW_SEC = windowSec;
        } else if (!config.STOP_LOSS_WINDOW_SEC) {
            config.STOP_LOSS_WINDOW_SEC = '180';
        }
        
        const currentCostThreshold = config.STOP_LOSS_COST_THRESHOLD || '0.6';
        log.info(`风险阈值：组合价格(Up Ask + Down Ask)低于此值计入风险统计`);
        log.info(`例如 0.48 = 组合价格<$0.48时算作风险信号`);
        const costThreshold = await question(`风险阈值 $ (当前: ${currentCostThreshold}): `);
        if (costThreshold && !isNaN(parseFloat(costThreshold))) {
            config.STOP_LOSS_COST_THRESHOLD = costThreshold;
        } else if (!config.STOP_LOSS_COST_THRESHOLD) {
            config.STOP_LOSS_COST_THRESHOLD = '0.6';
        }
        
        const currentRiskRatio = config.STOP_LOSS_RISK_RATIO || '70';
        log.info(`风险比例：低于阈值的次数占总检查次数的比例，超过此值触发止损`);
        log.info(`支持两种格式：70 或 0.7 都表示 70%`);
        const riskRatio = await question(`风险比例 % (当前: ${currentRiskRatio}): `);
        if (riskRatio && !isNaN(parseFloat(riskRatio))) {
            config.STOP_LOSS_RISK_RATIO = riskRatio;
        } else if (!config.STOP_LOSS_RISK_RATIO) {
            config.STOP_LOSS_RISK_RATIO = '0.7';
        }
        
        const currentMinCount = config.STOP_LOSS_MIN_TRIGGER_COUNT || '30';
        log.info(`最小触发次数：风险次数的绝对值必须超过此值才触发止损`);
        log.info(`避免样本太小误判`);
        const minCount = await question(`最小触发次数 (当前: ${currentMinCount}): `);
        if (minCount && !isNaN(parseInt(minCount))) {
            config.STOP_LOSS_MIN_TRIGGER_COUNT = minCount;
        } else if (!config.STOP_LOSS_MIN_TRIGGER_COUNT) {
            config.STOP_LOSS_MIN_TRIGGER_COUNT = '30';
        }
    }
    
    // ===== 保存 =====
    saveConfig(config);
    
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║                    ✅ 配置完成                            ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  模式: ${config.SIMULATION_MODE === 'true' ? '🔵 模拟（无需私钥）' : '🔴 真实交易'}`);
    console.log(`  钱包: ${config.PROXY_WALLET ? config.PROXY_WALLET.slice(0, 10) + '...' : '未设置'}`);
    console.log(`  启动清数据: ${config.CLEAR_DATA_ON_START === 'true' ? '✅ 是' : '❌ 否'}`);
    console.log(`  15分钟场: ${config.ENABLE_15MIN === '0' ? '❌ 关闭' : '✅ 开启'}`);
    console.log(`  1小时场: ${config.ENABLE_1HR === '0' ? '❌ 关闭' : '✅ 开启'}`);
    console.log(`  最大下单: $${config.MAX_ORDER_SIZE_USD}`);
    console.log(`  最小利润额: $${config.MIN_PROFIT_USD}`);
    console.log(`  最小利润率: ${config.MIN_ARBITRAGE_PERCENT || '0.1'}%`);
    const initial = config.MAX_ARBITRAGE_PERCENT_INITIAL || '30';
    const final = config.MAX_ARBITRAGE_PERCENT_FINAL || '15';
    const tighten = config.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES || '13';
    console.log(`  敞口限制: ${initial}% → ${final}%（${tighten}分钟内收紧）`);
    console.log(`  深度使用: ${config.DEPTH_USAGE_PERCENT}%`);
    console.log('');
    console.log('  🚨 止损配置:');
    console.log(`  止损功能: ${config.STOP_LOSS_ENABLED === 'false' ? '❌ 关闭' : '✅ 开启'}`);
    if (config.STOP_LOSS_ENABLED !== 'false') {
        console.log(`  监控窗口: 结束前 ${config.STOP_LOSS_WINDOW_SEC || '180'} 秒`);
        console.log(`  组合阈值: $${config.STOP_LOSS_COST_THRESHOLD || '0.6'}`);
        const ratio = parseFloat(config.STOP_LOSS_RISK_RATIO || '0.7') * 100;
        console.log(`  风险比例: ≥${ratio.toFixed(0)}%`);
        console.log(`  最小次数: ≥${config.STOP_LOSS_MIN_TRIGGER_COUNT || '30'} 次`);
    }
    console.log('');
    log.success('启动命令: npm run dev');
    console.log('');
    
    rl.close();
};

main().catch((error) => {
    console.error('配置出错:', error);
    rl.close();
    process.exit(1);
});



