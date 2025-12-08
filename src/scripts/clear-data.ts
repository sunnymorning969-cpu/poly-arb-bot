/**
 * 清除所有历史数据脚本
 * 
 * 运行: npm run clear-data
 */

import * as fs from 'fs';
import * as path from 'path';

// 颜色输出
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

const log = {
    info: (msg: string) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
    success: (msg: string) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
    warning: (msg: string) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
    error: (msg: string) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
};

const main = async () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║           🧹 清除机器人历史数据                            ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    
    const DATA_DIR = path.join(process.cwd(), 'data');
    const DATA_FILE = path.join(DATA_DIR, 'bot-data.json');
    const BACKUP_FILE = path.join(DATA_DIR, 'bot-data.backup.json');
    
    // 检查数据文件是否存在
    if (!fs.existsSync(DATA_FILE)) {
        log.info('没有历史数据需要清除');
        return;
    }
    
    // 显示当前数据
    try {
        const content = fs.readFileSync(DATA_FILE, 'utf-8');
        const data = JSON.parse(content);
        
        log.info('当前数据:');
        console.log(`  • 仓位数量: ${data.positions?.length || 0}`);
        console.log(`  • 结算历史: ${data.settlementHistory?.length || 0}`);
        console.log(`  • 总交易数: ${data.stats?.totalTrades || 0}`);
        console.log(`  • 累计盈亏: $${data.stats?.totalProfit?.toFixed(2) || '0.00'}`);
        console.log('');
    } catch (e) {
        log.warning('无法读取当前数据');
    }
    
    // 确认
    const readline = await import('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    
    const confirm = await new Promise<string>((resolve) => {
        rl.question('确认清除所有历史数据？(y/n): ', resolve);
    });
    rl.close();
    
    if (confirm.toLowerCase() !== 'y') {
        log.info('取消操作');
        return;
    }
    
    // 删除数据文件
    try {
        if (fs.existsSync(DATA_FILE)) {
            fs.unlinkSync(DATA_FILE);
            log.success('已删除: bot-data.json');
        }
        
        if (fs.existsSync(BACKUP_FILE)) {
            fs.unlinkSync(BACKUP_FILE);
            log.success('已删除: bot-data.backup.json');
        }
        
        console.log('');
        log.success('✅ 所有历史数据已清除！');
        log.info('下次启动机器人将从零开始');
        console.log('');
    } catch (error: any) {
        log.error(`删除失败: ${error.message || error}`);
    }
};

main().catch((error) => {
    log.error(`执行出错: ${error.message || error}`);
    process.exit(1);
});


