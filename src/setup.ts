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
        `MIN_PROFIT_USD=${config.MIN_PROFIT_USD || '0.01'}`,
        `MIN_ARBITRAGE_PERCENT=${config.MIN_ARBITRAGE_PERCENT || '2'}`,
        `MAX_ARBITRAGE_PERCENT_INITIAL=${config.MAX_ARBITRAGE_PERCENT_INITIAL || '30'}`,
        `MAX_ARBITRAGE_PERCENT_FINAL=${config.MAX_ARBITRAGE_PERCENT_FINAL || '15'}`,
        `MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES=${config.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES || '13'}`,
        `DEPTH_USAGE_PERCENT=${config.DEPTH_USAGE_PERCENT || '90'}`,
        '',
        '# ========== 止损配置 ==========',
        `STOP_LOSS_ENABLED=${config.STOP_LOSS_ENABLED || 'true'}`,
        `STOP_LOSS_WINDOW_SEC=${config.STOP_LOSS_WINDOW_SEC || '180'}`,
        `STOP_LOSS_COST_THRESHOLD=${config.STOP_LOSS_COST_THRESHOLD || '0.5'}`,
        `STOP_LOSS_RISK_RATIO=${config.STOP_LOSS_RISK_RATIO || '60'}`,
        `STOP_LOSS_MIN_TRIGGER_COUNT=${config.STOP_LOSS_MIN_TRIGGER_COUNT || '100'}`,
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
    console.log(`     最小利润额: $${config.MIN_PROFIT_USD}`);
    console.log(`     最小利润率: ${config.MIN_ARBITRAGE_PERCENT}%`);
    const initial = config.MAX_ARBITRAGE_PERCENT_INITIAL || '30';
    const final = config.MAX_ARBITRAGE_PERCENT_FINAL || '15';
    const tighten = config.MAX_ARBITRAGE_PERCENT_TIGHTEN_MINUTES || '13';
    console.log(`     组合成本下限: $${(1 - parseFloat(initial)/100).toFixed(2)} → $${(1 - parseFloat(final)/100).toFixed(2)}（${tighten}分钟内收紧）`);
    console.log(`     深度使用: ${config.DEPTH_USAGE_PERCENT}%`);
    console.log('');
    console.log(`  🚨 止损配置:`);
    console.log(`     止损功能: ${config.STOP_LOSS_ENABLED === 'false' ? '❌ 关闭' : '✅ 开启'}`);
    if (config.STOP_LOSS_ENABLED !== 'false') {
        console.log(`     监控窗口: 结束前 ${config.STOP_LOSS_WINDOW_SEC || '180'} 秒`);
        console.log(`     风险阈值: 组合价格 < $${config.STOP_LOSS_COST_THRESHOLD || '0.5'}`);
        const ratioVal = parseFloat(config.STOP_LOSS_RISK_RATIO || '60');
        const ratioPercent = ratioVal > 1 ? ratioVal : ratioVal * 100;
        console.log(`     触发条件: 比例 ≥${ratioPercent.toFixed(0)}% 且 次数 ≥${config.STOP_LOSS_MIN_TRIGGER_COUNT || '100'}`);
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
