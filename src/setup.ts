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

// 保存配置（使用基于交易员分析的默认值）
const saveConfig = (config: Record<string, string>): void => {
    const lines: string[] = [
        '# Polymarket 套利机器人配置',
        '# 基于交易员数据分析的默认值',
        `# 生成时间: ${new Date().toLocaleString('zh-CN')}`,
        '',
        '# ========== 钱包配置（必填）==========',
        `PRIVATE_KEY=${config.PRIVATE_KEY || ''}`,
        `PROXY_WALLET=${config.PROXY_WALLET || ''}`,
        '',
        '# ========== API 配置 ==========',
        'CLOB_HTTP_URL=https://clob.polymarket.com',
        `RPC_URL=${config.RPC_URL || 'https://polygon-rpc.com'}`,
        '',
        '# ========== Telegram 配置 ==========',
        `TELEGRAM_BOT_TOKEN=${config.TELEGRAM_BOT_TOKEN || '7698365045:AAGaPd7zLHdb4Ky7Tw0NobpcRCpNKWk-648'}`,
        `TELEGRAM_GROUP_ID=${config.TELEGRAM_GROUP_ID || '@rickyhutest'}`,
        'TELEGRAM_ENABLED=true',
        '',
        '# ========== 套利配置（基于交易员分析）==========',
        '# 最小利润 % (交易员几乎所有>0%的都做)',
        'MIN_ARBITRAGE_PERCENT=0.1',
        '# 最大 Up+Down 合计成本 (严格控制，仅用于已有仓位加仓)',
        'MAX_COMBINED_COST=1.03',
        '# 下单金额范围 (分析: $0.5-$14)',
        'MIN_ORDER_SIZE_USD=1',
        'MAX_ORDER_SIZE_USD=14',
        '# 深度使用比例 %',
        'DEPTH_USAGE_PERCENT=90',
        '',
        '# ========== 单边买入阈值 ==========',
        '# Up/Down 价格低于此值时可单边买入',
        'UP_PRICE_THRESHOLD=0.55',
        'DOWN_PRICE_THRESHOLD=0.55',
        '',
        '# ========== 频率控制 ==========',
        '# 冷却时间 ms (1秒，快速响应)',
        'TRADE_COOLDOWN_MS=1000',
        '# 扫描间隔 ms (5ms = 200次/秒)',
        'SCAN_INTERVAL_MS=5',
        '# 最大并行交易数',
        'MAX_PARALLEL_TRADES=8',
        '',
        '# ========== 安全配置 ==========',
        '# 每日最大交易数',
        'MAX_DAILY_TRADES=3000',
        '# 每日最大亏损 $',
        'MAX_DAILY_LOSS_USD=100',
        '# 模拟模式 (true=不真实下单)',
        `SIMULATION_MODE=${config.SIMULATION_MODE || 'true'}`,
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
    
    // ===== 可选：RPC =====
    log.title('🔗 RPC 配置 (可选，回车使用默认)');
    const rpc = await question('RPC URL (默认 polygon-rpc.com): ');
    if (rpc) config.RPC_URL = rpc;
    
    // ===== 模拟模式 =====
    log.title('🔒 模式选择');
    log.info('模拟模式下不会真实下单，建议先测试');
    const simMode = await question('启用模拟模式？(y/n，默认 y): ');
    config.SIMULATION_MODE = simMode.toLowerCase() === 'n' ? 'false' : 'true';
    
    // ===== 保存 =====
    saveConfig(config);
    
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║                    ✅ 配置完成                            ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  钱包: ${config.PROXY_WALLET || '未设置'}`);
    console.log(`  模式: ${config.SIMULATION_MODE === 'true' ? '🔵 模拟' : '🔴 真实交易'}`);
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

