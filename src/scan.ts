/**
 * 扫描脚本 - 仅扫描并显示套利机会，不执行交易
 * 
 * 用法: npm run scan
 */

import Logger from './logger';
import { scanArbitrageOpportunities, printOpportunities } from './scanner';

const main = async () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║      🔍 Polymarket 套利扫描器                             ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    
    Logger.info('正在扫描 BTC/ETH Up/Down 市场...');
    Logger.divider();
    
    const opportunities = await scanArbitrageOpportunities();
    
    console.log('');
    printOpportunities(opportunities);
    
    if (opportunities.length > 0) {
        Logger.divider();
        Logger.success(`共找到 ${opportunities.length} 个套利机会`);
        
        // 计算总潜在利润
        let totalPotentialProfit = 0;
        for (const opp of opportunities) {
            totalPotentialProfit += opp.maxShares * (1 - opp.combinedCost);
        }
        Logger.arbitrage(`总潜在利润: $${totalPotentialProfit.toFixed(2)}`);
    }
    
    console.log('');
};

main().catch(error => {
    Logger.error(`扫描失败: ${error}`);
    process.exit(1);
});


