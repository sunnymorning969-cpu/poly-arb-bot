/**
 * 仓位查询诊断脚本
 * 用于检查 Polymarket API 返回的仓位数据
 * 
 * 运行: npx ts-node src/scripts/check-positions.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';

const PROXY_WALLET = process.env.PROXY_WALLET;
const DATA_API = 'https://data-api.polymarket.com';

if (!PROXY_WALLET) {
    console.error('❌ 请先配置 .env 文件中的 PROXY_WALLET');
    process.exit(1);
}

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    initialValue: number;
    currentValue: number;
    curPrice: number;
    title?: string;
    slug?: string;
    market?: string;
    outcome?: string;
    redeemable?: boolean;
    mergeable?: boolean;
    [key: string]: any;  // 其他字段
}

const main = async () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║           🔍 Polymarket 仓位查询诊断                       ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`📍 钱包: ${PROXY_WALLET}`);
    console.log(`📅 当前时间: ${new Date().toLocaleString()}`);
    console.log('');
    
    try {
        console.log('📥 查询 Data API...');
        const response = await axios.get(`${DATA_API}/positions`, {
            params: {
                user: PROXY_WALLET,
                sizeThreshold: 0.1,
            },
            timeout: 15000,
        });
        
        const positions: Position[] = response.data || [];
        
        console.log(`\n✅ 返回 ${positions.length} 个仓位\n`);
        
        if (positions.length === 0) {
            console.log('没有找到任何仓位');
            return;
        }
        
        // 显示每个仓位的详细信息
        for (let i = 0; i < positions.length; i++) {
            const pos = positions[i];
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`📦 仓位 #${i + 1}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            
            // 基本信息
            console.log(`  📌 title:        ${pos.title || 'N/A'}`);
            console.log(`  📌 slug:         ${pos.slug || pos.market || 'N/A'}`);
            console.log(`  📌 outcome:      ${pos.outcome || 'N/A'}`);
            console.log('');
            
            // 持仓数据
            console.log(`  💰 size:         ${pos.size?.toFixed(4) || 'N/A'} shares`);
            console.log(`  💰 curPrice:     $${pos.curPrice?.toFixed(4) || 'N/A'}`);
            console.log(`  💰 currentValue: $${pos.currentValue?.toFixed(4) || 'N/A'}`);
            console.log(`  💰 avgPrice:     $${pos.avgPrice?.toFixed(4) || 'N/A'}`);
            console.log('');
            
            // 关键 ID（这些决定了去哪个市场交易）
            console.log(`  🔑 asset (tokenId): ${pos.asset}`);
            console.log(`  🔑 conditionId:     ${pos.conditionId}`);
            console.log('');
            
            // 状态标记
            console.log(`  🏷️  redeemable:  ${pos.redeemable}`);
            console.log(`  🏷️  mergeable:   ${pos.mergeable}`);
            
            // 检查日期
            const title = pos.title || '';
            const dateMatch = title.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);
            if (dateMatch) {
                const today = new Date();
                const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                               'July', 'August', 'September', 'October', 'November', 'December'];
                const todayStr = `${months[today.getMonth()]} ${today.getDate()}`;
                const titleDate = `${dateMatch[1]} ${dateMatch[2]}`;
                
                if (titleDate.toLowerCase() === todayStr.toLowerCase()) {
                    console.log(`  ✅ 日期匹配: ${titleDate} = 今天`);
                } else {
                    console.log(`  ⚠️  日期不匹配: title="${titleDate}", 今天="${todayStr}"`);
                }
            }
            
            console.log('');
        }
        
        // 汇总
        console.log('═══════════════════════════════════════════════════════════');
        console.log('📊 汇总');
        console.log('═══════════════════════════════════════════════════════════');
        
        const totalValue = positions.reduce((sum, p) => sum + (p.currentValue || 0), 0);
        const totalShares = positions.reduce((sum, p) => sum + (p.size || 0), 0);
        
        console.log(`  总仓位数: ${positions.length}`);
        console.log(`  总 shares: ${totalShares.toFixed(2)}`);
        console.log(`  总价值: $${totalValue.toFixed(2)}`);
        
        // 按日期分组
        const byDate: Record<string, Position[]> = {};
        for (const pos of positions) {
            const title = pos.title || '';
            const dateMatch = title.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i);
            const dateKey = dateMatch ? `${dateMatch[1]} ${dateMatch[2]}` : 'Unknown';
            if (!byDate[dateKey]) byDate[dateKey] = [];
            byDate[dateKey].push(pos);
        }
        
        console.log('');
        console.log('  按日期分组:');
        for (const [date, posGroup] of Object.entries(byDate)) {
            const groupValue = posGroup.reduce((sum, p) => sum + (p.currentValue || 0), 0);
            console.log(`    ${date}: ${posGroup.length} 个仓位, $${groupValue.toFixed(2)}`);
        }
        
        console.log('');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('💡 诊断建议');
        console.log('═══════════════════════════════════════════════════════════');
        
        const today = new Date();
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                       'July', 'August', 'September', 'October', 'November', 'December'];
        const todayStr = `${months[today.getMonth()]} ${today.getDate()}`;
        
        const todayPositions = byDate[todayStr] || [];
        const otherPositions = positions.length - todayPositions.length;
        
        if (otherPositions > 0) {
            console.log(`  ⚠️  有 ${otherPositions} 个仓位的 title 日期不是今天`);
            console.log('     可能原因:');
            console.log('     1. Polymarket API 缓存延迟');
            console.log('     2. 确实持有昨天未卖出的仓位');
            console.log('     3. API 返回了错误的 title/tokenId');
            console.log('');
            console.log('     建议: 在 Polymarket 网页上确认实际持仓');
        } else {
            console.log('  ✅ 所有仓位的日期都是今天，数据看起来正常');
        }
        
        console.log('');
        
    } catch (error: any) {
        console.error('❌ 查询失败:', error.message);
        if (error.response) {
            console.error('   状态码:', error.response.status);
            console.error('   响应:', JSON.stringify(error.response.data));
        }
    }
};

main().catch(console.error);
