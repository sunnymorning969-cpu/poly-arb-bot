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
        `MAX_ARBITRAGE_PERCENT=${config.MAX_ARBITRAGE_PERCENT || '10'}`,
        `DEPTH_USAGE_PERCENT=${config.DEPTH_USAGE_PERCENT || '90'}`,
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
    
    // ===== 必填：私钥和钱包地址 =====
    log.title('📝 必填配置');
    
    log.warning('私钥用于签名交易，请确保安全保管！');
    const currentPK = config.PRIVATE_KEY ? '(已有，回车保留)' : '';
    let pk = await question(`钱包私钥 ${currentPK}: `);
    if (pk) {
        pk = pk.replace(/^0x/, '');
        if (pk.length === 64) {
            config.PRIVATE_KEY = pk;
            log.success('私钥已设置');
        } else {
            log.error('私钥格式不正确，应为 64 位十六进制');
        }
    }
    
    const currentWallet = config.PROXY_WALLET ? `(当前: ${config.PROXY_WALLET.slice(0, 10)}...)` : '';
    const wallet = await question(`钱包地址 ${currentWallet}: `);
    if (wallet) {
        if (wallet.startsWith('0x') && wallet.length === 42) {
            config.PROXY_WALLET = wallet;
            log.success('钱包地址已设置');
        } else {
            log.error('钱包地址格式不正确');
        }
    }
    
    // ===== 模拟模式 =====
    log.title('🔒 模式选择');
    log.info('模拟模式下不会真实下单，建议先测试');
    const simMode = await question('启用模拟模式？(y/n，默认 y): ');
    config.SIMULATION_MODE = simMode.toLowerCase() === 'n' ? 'false' : 'true';
    
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
    
    const currentMaxArb = config.MAX_ARBITRAGE_PERCENT || '10';
    log.info('最大套利敞口：超过此值说明市场分歧大，风险高');
    log.info('例如 10% = 合计成本 < $0.90 时不交易');
    const maxArb = await question(`最大套利敞口 % (当前: ${currentMaxArb}): `);
    if (maxArb && !isNaN(parseFloat(maxArb))) {
        config.MAX_ARBITRAGE_PERCENT = maxArb;
    } else if (!config.MAX_ARBITRAGE_PERCENT) {
        config.MAX_ARBITRAGE_PERCENT = '10';
    }
    
    const currentDepth = config.DEPTH_USAGE_PERCENT || '90';
    const depth = await question(`深度使用百分比 % (当前: ${currentDepth}): `);
    if (depth && !isNaN(parseFloat(depth))) {
        config.DEPTH_USAGE_PERCENT = depth;
    } else if (!config.DEPTH_USAGE_PERCENT) {
        config.DEPTH_USAGE_PERCENT = '90';
    }
    
    // ===== 保存 =====
    saveConfig(config);
    
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║                    ✅ 配置完成                            ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  钱包: ${config.PROXY_WALLET || '未设置'}`);
    console.log(`  模式: ${config.SIMULATION_MODE === 'true' ? '🔵 模拟' : '🔴 真实交易'}`);
    console.log(`  启动清数据: ${config.CLEAR_DATA_ON_START === 'true' ? '✅ 是' : '❌ 否'}`);
    console.log(`  15分钟场: ${config.ENABLE_15MIN === '0' ? '❌ 关闭' : '✅ 开启'}`);
    console.log(`  1小时场: ${config.ENABLE_1HR === '0' ? '❌ 关闭' : '✅ 开启'}`);
    console.log(`  最大下单: $${config.MAX_ORDER_SIZE_USD}`);
    console.log(`  最小利润: $${config.MIN_PROFIT_USD}`);
    console.log(`  最大敞口: ${config.MAX_ARBITRAGE_PERCENT}%`);
    console.log(`  深度使用: ${config.DEPTH_USAGE_PERCENT}%`);
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


