/**
 * 交互式配置脚本
 * 
 * 运行: npm run setup
 * 引导用户配置 .env 文件
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const ENV_FILE = path.join(process.cwd(), '.env');

// 配置项定义
interface ConfigItem {
    key: string;
    description: string;
    required: boolean;
    default?: string;
    secret?: boolean;  // 是否是敏感信息（不显示输入）
    validate?: (value: string) => boolean;
}

// ========== 基于交易员数据分析的默认配置 ==========
// 分析样本: 4个完整事件
// - BTC 15分钟 (321笔): Up $0.08-$0.29, Down $0.69-$0.90, 金额 $0.13-$13.92
// - BTC 1小时 (1990笔): Up $0.08-$0.24, Down $0.75-$0.89, 金额 $0.52-$10.32
// - ETH 15分钟 (160笔): Up $0.24-$0.53, Down $0.44-$0.76, 金额 $0.54-$9.12
// - ETH 1小时 (2520笔): Up $0.37-$0.53, Down $0.33-$0.64, 金额 $0.07-$5.12
// 交易间隔: 约2秒一笔

const CONFIG_ITEMS: ConfigItem[] = [
    // 钱包配置
    {
        key: 'PRIVATE_KEY',
        description: '钱包私钥 (用于签名交易，不要泄露！)',
        required: true,
        secret: true,
        validate: (v) => v.length === 64 || v.length === 66,
    },
    {
        key: 'PROXY_WALLET',
        description: '代理钱包地址 (用于交易的钱包，通常与私钥对应)',
        required: true,
        validate: (v) => v.startsWith('0x') && v.length === 42,
    },
    
    // API 配置
    {
        key: 'RPC_URL',
        description: 'Polygon RPC URL (推荐 Alchemy/Infura)',
        required: false,
        default: 'https://polygon-rpc.com',
    },
    
    // Telegram 配置
    {
        key: 'TELEGRAM_BOT_TOKEN',
        description: 'Telegram Bot Token (从 @BotFather 获取)',
        required: false,
        secret: true,
        default: '7698365045:AAGaPd7zLHdb4Ky7Tw0NobpcRCpNKWk-648',
    },
    {
        key: 'TELEGRAM_GROUP_ID',
        description: 'Telegram 群组 ID (如 @your_group 或数字 ID)',
        required: false,
        default: '@rickyhutest',
    },
    {
        key: 'TELEGRAM_ENABLED',
        description: '是否启用 Telegram 通知 (true/false)',
        required: false,
        default: 'true',
    },
    
    // 事件级套利配置（基于交易员分析）
    {
        key: 'MIN_ARBITRAGE_PERCENT',
        description: '最小利润 % (交易员几乎所有>0%的都做)',
        required: false,
        default: '0.1',  // 基于分析：交易员非常激进
    },
    {
        key: 'MAX_COMBINED_COST',
        description: '最大 Up+Down 合计成本 (分析显示部分>$1)',
        required: false,
        default: '1.05',  // 基于分析：允许略亏来平衡仓位
    },
    {
        key: 'MIN_ORDER_SIZE_USD',
        description: '最小下单金额 $ (分析显示有$0.13小单)',
        required: false,
        default: '0.5',  // 基于分析：最小$0.13，设置$0.5安全
    },
    {
        key: 'MAX_ORDER_SIZE_USD',
        description: '最大下单金额 $ (分析显示最大约$14)',
        required: false,
        default: '14',  // 基于分析：最大$13.92
    },
    {
        key: 'DEPTH_USAGE_PERCENT',
        description: '深度使用比例 % (交易员吃单激进)',
        required: false,
        default: '90',  // 基于分析：交易员吃单非常激进
    },
    
    // 单边买入阈值（基于分析：Up $0.08-$0.53, Down $0.33-$0.90）
    {
        key: 'UP_PRICE_THRESHOLD',
        description: 'Up 单边买入阈值 (分析: Up价格$0.08-$0.53)',
        required: false,
        default: '0.55',  // 基于分析：Up最高到$0.53
    },
    {
        key: 'DOWN_PRICE_THRESHOLD',
        description: 'Down 单边买入阈值 (分析: Down价格$0.33-$0.90)',
        required: false,
        default: '0.55',  // 对称设置，配合Up使用
    },
    
    // 冷却与频率控制（分析显示交易间隔约2秒）
    {
        key: 'TRADE_COOLDOWN_MS',
        description: '冷却时间 ms (分析: 交易员约2秒一笔)',
        required: false,
        default: '5000',  // 比交易员略保守，5秒
    },
    {
        key: 'MAX_PARALLEL_TRADES',
        description: '最大并行交易数 (4市场×2边)',
        required: false,
        default: '8',
    },
    {
        key: 'SCAN_INTERVAL_MS',
        description: '扫描间隔 (毫秒)',
        required: false,
        default: '50',
    },
    
    // 安全配置（15分钟300+笔，1小时2000+笔）
    {
        key: 'MAX_DAILY_TRADES',
        description: '每日最大交易数 (分析: 1小时约2000笔)',
        required: false,
        default: '3000',
    },
    {
        key: 'MAX_DAILY_LOSS_USD',
        description: '每日最大亏损 $',
        required: false,
        default: '100',
    },
    {
        key: 'SIMULATION_MODE',
        description: '模拟模式 (true=不真实下单)',
        required: false,
        default: 'true',
    },
];

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

// 提问函数
const question = (prompt: string): Promise<string> => {
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            resolve(answer.trim());
        });
    });
};

// 加载现有配置
const loadExistingConfig = (): Record<string, string> => {
    const config: Record<string, string> = {};
    
    if (fs.existsSync(ENV_FILE)) {
        const content = fs.readFileSync(ENV_FILE, 'utf-8');
        const lines = content.split('\n');
        
        for (const line of lines) {
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
        '# Polymarket 套利机器人配置 (基于交易员数据分析)',
        '# 由 setup 脚本生成',
        `# 生成时间: ${new Date().toLocaleString('zh-CN')}`,
        '',
        '# ========== 钱包配置 ==========',
        `PRIVATE_KEY=${config.PRIVATE_KEY || ''}`,
        `PROXY_WALLET=${config.PROXY_WALLET || ''}`,
        '',
        '# ========== API 配置 ==========',
        `CLOB_HTTP_URL=https://clob.polymarket.com`,
        `RPC_URL=${config.RPC_URL || 'https://polygon-rpc.com'}`,
        '',
        '# ========== Telegram 配置 ==========',
        `TELEGRAM_BOT_TOKEN=${config.TELEGRAM_BOT_TOKEN || ''}`,
        `TELEGRAM_GROUP_ID=${config.TELEGRAM_GROUP_ID || ''}`,
        `TELEGRAM_ENABLED=${config.TELEGRAM_ENABLED || 'true'}`,
        '',
        '# ========== 事件级套利配置（基于交易员分析）==========',
        '# 分析样本: BTC/ETH 15分钟(321/160笔) + BTC/ETH 1小时(1990/2520笔)',
        `MIN_ARBITRAGE_PERCENT=${config.MIN_ARBITRAGE_PERCENT || '0.1'}`,
        `MAX_COMBINED_COST=${config.MAX_COMBINED_COST || '1.05'}`,
        `MIN_ORDER_SIZE_USD=${config.MIN_ORDER_SIZE_USD || '0.5'}`,
        `MAX_ORDER_SIZE_USD=${config.MAX_ORDER_SIZE_USD || '14'}`,
        `DEPTH_USAGE_PERCENT=${config.DEPTH_USAGE_PERCENT || '90'}`,
        '',
        '# ========== 单边买入阈值（基于价格分析）==========',
        '# Up价格范围: $0.08-$0.53, Down价格范围: $0.33-$0.90',
        `UP_PRICE_THRESHOLD=${config.UP_PRICE_THRESHOLD || '0.55'}`,
        `DOWN_PRICE_THRESHOLD=${config.DOWN_PRICE_THRESHOLD || '0.55'}`,
        '',
        '# ========== 频率与冷却控制（分析:交易间隔约2秒）==========',
        `TRADE_COOLDOWN_MS=${config.TRADE_COOLDOWN_MS || '5000'}`,
        `SCAN_INTERVAL_MS=${config.SCAN_INTERVAL_MS || '50'}`,
        `MAX_PARALLEL_TRADES=${config.MAX_PARALLEL_TRADES || '8'}`,
        '',
        '# ========== 安全配置（分析:1小时约2000笔）==========',
        `MAX_DAILY_TRADES=${config.MAX_DAILY_TRADES || '3000'}`,
        `MAX_DAILY_LOSS_USD=${config.MAX_DAILY_LOSS_USD || '100'}`,
        `SIMULATION_MODE=${config.SIMULATION_MODE || 'true'}`,
        '',
    ];
    
    fs.writeFileSync(ENV_FILE, lines.join('\n'), 'utf-8');
};

// 主函数
const main = async () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║                                                           ║');
    console.log('║      🤖 Polymarket 套利机器人 - 配置向导                  ║');
    console.log('║                                                           ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    
    // 检查是否已有配置
    const existingConfig = loadExistingConfig();
    const hasExisting = Object.keys(existingConfig).length > 0;
    
    if (hasExisting) {
        log.info('发现已有配置文件 .env');
        const overwrite = await question('是否要重新配置？(y/n，默认 n): ');
        if (overwrite.toLowerCase() !== 'y') {
            log.info('保留现有配置，退出设置向导');
            rl.close();
            return;
        }
    }
    
    const config: Record<string, string> = { ...existingConfig };
    
    // ===== 必填配置 =====
    log.title('📝 必填配置');
    
    // 私钥
    log.info('私钥用于签名交易，请确保安全保管，不要泄露给任何人！');
    const currentPK = config.PRIVATE_KEY ? `(已有，回车保留)` : '';
    let pk = await question(`请输入钱包私钥 ${currentPK}: `);
    if (pk) {
        // 移除可能的 0x 前缀
        pk = pk.replace(/^0x/, '');
        if (pk.length !== 64) {
            log.error('私钥格式不正确，应为 64 位十六进制字符');
        } else {
            config.PRIVATE_KEY = pk;
            log.success('私钥已设置');
        }
    } else if (config.PRIVATE_KEY) {
        log.info('保留现有私钥');
    }
    
    // 钱包地址
    const currentWallet = config.PROXY_WALLET ? `(当前: ${config.PROXY_WALLET.slice(0, 10)}...)` : '';
    let wallet = await question(`请输入钱包地址 ${currentWallet}: `);
    if (wallet) {
        if (!wallet.startsWith('0x') || wallet.length !== 42) {
            log.error('钱包地址格式不正确');
        } else {
            config.PROXY_WALLET = wallet;
            log.success('钱包地址已设置');
        }
    } else if (config.PROXY_WALLET) {
        log.info('保留现有钱包地址');
    }
    
    // ===== Telegram 配置 =====
    log.title('📱 Telegram 通知配置 (可选)');
    
    // 设置默认值
    const defaultToken = '7698365045:AAGaPd7zLHdb4Ky7Tw0NobpcRCpNKWk-648';
    const defaultGroup = '@rickyhutest';
    
    if (!config.TELEGRAM_BOT_TOKEN) config.TELEGRAM_BOT_TOKEN = defaultToken;
    if (!config.TELEGRAM_GROUP_ID) config.TELEGRAM_GROUP_ID = defaultGroup;
    
    log.info(`默认 Bot Token: ${defaultToken.slice(0, 15)}...`);
    log.info(`默认群组: ${defaultGroup}`);
    
    const setupTelegram = await question('是否使用默认 Telegram 配置？(y/n，默认 y): ');
    if (setupTelegram.toLowerCase() === 'n') {
        // 用户想自定义
        const token = await question(`Telegram Bot Token (当前: ${config.TELEGRAM_BOT_TOKEN.slice(0, 15)}...): `);
        if (token) {
            config.TELEGRAM_BOT_TOKEN = token;
            log.success('Bot Token 已设置');
        }
        
        const group = await question(`Telegram 群组 ID (当前: ${config.TELEGRAM_GROUP_ID}): `);
        if (group) {
            config.TELEGRAM_GROUP_ID = group;
            log.success('群组 ID 已设置');
        }
    } else {
        // 使用默认配置
        log.success('使用默认 Telegram 配置');
    }
    config.TELEGRAM_ENABLED = 'true';
    
    // ===== RPC 配置 =====
    log.title('🔗 RPC 配置 (可选)');
    
    log.info('推荐使用 Alchemy 或 Infura 获取更稳定的 RPC');
    log.info('Alchemy 免费: https://alchemy.com');
    const currentRPC = config.RPC_URL ? `(当前: ${config.RPC_URL.slice(0, 40)}...)` : '(默认: polygon-rpc.com)';
    const rpc = await question(`RPC URL ${currentRPC}: `);
    if (rpc) {
        config.RPC_URL = rpc;
        log.success('RPC 已设置');
    }
    
    // ===== 交易参数 =====
    log.title('💰 交易参数配置');
    
    const currentMin = config.MIN_ORDER_SIZE_USD || '1';
    const minOrder = await question(`最小下单金额 $ (当前: ${currentMin}): `);
    if (minOrder) config.MIN_ORDER_SIZE_USD = minOrder;
    
    const currentMax = config.MAX_ORDER_SIZE_USD || '15';
    const maxOrder = await question(`最大下单金额 $ (当前: ${currentMax}): `);
    if (maxOrder) config.MAX_ORDER_SIZE_USD = maxOrder;
    
    const currentArb = config.MIN_ARBITRAGE_PERCENT || '0.5';
    const minArb = await question(`最小套利空间 % (当前: ${currentArb}): `);
    if (minArb) config.MIN_ARBITRAGE_PERCENT = minArb;
    
    // ===== 安全配置 =====
    log.title('🔒 安全配置');
    
    const currentSim = config.SIMULATION_MODE || 'true';
    log.info('模拟模式下不会真实下单，建议先用模拟模式测试');
    const simMode = await question(`启用模拟模式？(true/false，当前: ${currentSim}): `);
    if (simMode) config.SIMULATION_MODE = simMode;
    
    const currentDailyLimit = config.MAX_DAILY_TRADES || '100';
    const dailyLimit = await question(`每日最大交易次数 (当前: ${currentDailyLimit}): `);
    if (dailyLimit) config.MAX_DAILY_TRADES = dailyLimit;
    
    // ===== 保存配置 =====
    log.title('💾 保存配置');
    
    saveConfig(config);
    log.success(`.env 配置文件已保存到: ${ENV_FILE}`);
    
    // ===== 显示摘要 =====
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║                    配置摘要                               ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  钱包地址:     ${config.PROXY_WALLET || '未设置'}`);
    console.log(`  RPC:          ${(config.RPC_URL || 'polygon-rpc.com').slice(0, 40)}...`);
    console.log(`  Telegram:     ${config.TELEGRAM_ENABLED === 'true' ? '已启用' : '未启用'}`);
    console.log(`  下单范围:     $${config.MIN_ORDER_SIZE_USD || '1'} - $${config.MAX_ORDER_SIZE_USD || '15'}`);
    console.log(`  模拟模式:     ${config.SIMULATION_MODE === 'true' ? '✅ 开启' : '❌ 关闭'}`);
    console.log('');
    
    if (config.SIMULATION_MODE === 'true') {
        log.warning('当前为模拟模式，不会真实下单');
        log.info('测试完成后，修改 .env 中 SIMULATION_MODE=false 开启真实交易');
    } else {
        log.warning('⚠️ 真实交易模式！请确保配置正确');
    }
    
    console.log('');
    log.success('配置完成！运行以下命令启动机器人:');
    console.log('');
    console.log('  npm install    # 安装依赖');
    console.log('  npm run dev    # 启动机器人');
    console.log('');
    
    rl.close();
};

// 运行
main().catch((error) => {
    console.error('配置向导出错:', error);
    rl.close();
    process.exit(1);
});
