/**
 * 日志工具 - 彩色控制台输出
 */

import chalk from 'chalk';

const getTimestamp = (): string => {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
};

const Logger = {
    info: (message: string) => {
        console.log(chalk.blue(`[${getTimestamp()}] ℹ️  ${message}`));
    },

    success: (message: string) => {
        console.log(chalk.green(`[${getTimestamp()}] ✅ ${message}`));
    },

    warning: (message: string) => {
        console.log(chalk.yellow(`[${getTimestamp()}] ⚠️  ${message}`));
    },

    error: (message: string) => {
        console.log(chalk.red(`[${getTimestamp()}] ❌ ${message}`));
    },

    arbitrage: (message: string) => {
        console.log(chalk.magenta(`[${getTimestamp()}] 💰 ${message}`));
    },

    trade: (success: boolean, message: string) => {
        if (success) {
            console.log(chalk.green(`[${getTimestamp()}] 📈 ${message}`));
        } else {
            console.log(chalk.red(`[${getTimestamp()}] 📉 ${message}`));
        }
    },

    divider: () => {
        console.log(chalk.gray('─'.repeat(60)));
    },

    header: (title: string) => {
        console.log('');
        console.log(chalk.cyan.bold(`${'═'.repeat(60)}`));
        console.log(chalk.cyan.bold(`  ${title}`));
        console.log(chalk.cyan.bold(`${'═'.repeat(60)}`));
        console.log('');
    },
};

export default Logger;


