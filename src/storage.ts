/**
 * 数据持久化模块
 * 
 * 支持两种存储方式：
 * 1. 本地 JSON 文件（默认，无需配置）
 * 2. MongoDB（可选，需要配置连接字符串）
 */

import * as fs from 'fs';
import * as path from 'path';
import Logger from './logger';

// 存储数据结构
export interface StorageData {
    positions: Array<{
        conditionId: string;
        slug: string;
        title: string;
        upShares: number;
        downShares: number;
        upCost: number;
        downCost: number;
        lastUpdate: number;
        endDate: string;
    }>;
    settlementHistory: Array<{
        conditionId: string;
        slug: string;
        title: string;
        outcome: 'up' | 'down';
        payout: number;
        totalCost: number;
        profit: number;
        profitPercent: number;
        settledAt: number;
    }>;
    stats: {
        totalTrades: number;
        successfulTrades: number;
        totalProfit: number;
        totalCost: number;
        lastUpdate: number;
    };
    lastSave: number;
}

// 默认数据
const DEFAULT_DATA: StorageData = {
    positions: [],
    settlementHistory: [],
    stats: {
        totalTrades: 0,
        successfulTrades: 0,
        totalProfit: 0,
        totalCost: 0,
        lastUpdate: Date.now(),
    },
    lastSave: Date.now(),
};

// 存储文件路径
const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'bot-data.json');
const BACKUP_FILE = path.join(DATA_DIR, 'bot-data.backup.json');

// 内存缓存
let cachedData: StorageData = { ...DEFAULT_DATA };
let isDirty = false;
let saveInterval: NodeJS.Timeout | null = null;

/**
 * 初始化存储
 */
export const initStorage = async (): Promise<void> => {
    // 确保数据目录存在
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        Logger.info('📁 创建数据目录: ' + DATA_DIR);
    }
    
    // 尝试加载现有数据
    try {
        if (fs.existsSync(DATA_FILE)) {
            const content = fs.readFileSync(DATA_FILE, 'utf-8');
            cachedData = JSON.parse(content);
            Logger.success(`📂 已加载存储数据: ${cachedData.positions.length} 个仓位, ${cachedData.settlementHistory.length} 条结算记录`);
        } else {
            Logger.info('📂 未找到存储文件，使用默认数据');
            await saveData();
        }
    } catch (error) {
        Logger.warning(`加载数据失败，尝试恢复备份: ${error}`);
        
        // 尝试从备份恢复
        try {
            if (fs.existsSync(BACKUP_FILE)) {
                const content = fs.readFileSync(BACKUP_FILE, 'utf-8');
                cachedData = JSON.parse(content);
                Logger.success('从备份文件恢复成功');
            }
        } catch (backupError) {
            Logger.error('备份恢复失败，使用默认数据');
            cachedData = { ...DEFAULT_DATA };
        }
    }
    
    // 启动定时保存（每 30 秒）
    saveInterval = setInterval(() => {
        if (isDirty) {
            saveData();
        }
    }, 30000);
    
    Logger.info('💾 存储模块初始化完成');
};

/**
 * 保存数据到文件
 */
export const saveData = async (): Promise<void> => {
    try {
        cachedData.lastSave = Date.now();
        
        // 先写入备份
        if (fs.existsSync(DATA_FILE)) {
            fs.copyFileSync(DATA_FILE, BACKUP_FILE);
        }
        
        // 写入主文件
        fs.writeFileSync(DATA_FILE, JSON.stringify(cachedData, null, 2), 'utf-8');
        isDirty = false;
        
    } catch (error) {
        Logger.error(`保存数据失败: ${error}`);
    }
};

/**
 * 获取所有仓位
 */
export const getStoredPositions = (): StorageData['positions'] => {
    return cachedData.positions;
};

/**
 * 保存仓位
 */
export const savePosition = (position: StorageData['positions'][0]): void => {
    const index = cachedData.positions.findIndex(p => p.conditionId === position.conditionId);
    
    if (index >= 0) {
        cachedData.positions[index] = position;
    } else {
        cachedData.positions.push(position);
    }
    
    isDirty = true;
};

/**
 * 删除仓位
 */
export const deletePosition = (conditionId: string): void => {
    cachedData.positions = cachedData.positions.filter(p => p.conditionId !== conditionId);
    isDirty = true;
};

/**
 * 获取结算历史
 */
export const getSettlementHistory = (): StorageData['settlementHistory'] => {
    return cachedData.settlementHistory;
};

/**
 * 添加结算记录
 */
export const addSettlementRecord = (record: StorageData['settlementHistory'][0]): void => {
    cachedData.settlementHistory.push(record);
    isDirty = true;
    
    // 只保留最近 1000 条记录
    if (cachedData.settlementHistory.length > 1000) {
        cachedData.settlementHistory = cachedData.settlementHistory.slice(-1000);
    }
};

/**
 * 获取统计数据
 */
export const getStoredStats = (): StorageData['stats'] => {
    return cachedData.stats;
};

/**
 * 更新统计数据
 */
export const updateStats = (updates: Partial<StorageData['stats']>): void => {
    cachedData.stats = {
        ...cachedData.stats,
        ...updates,
        lastUpdate: Date.now(),
    };
    isDirty = true;
};

/**
 * 关闭存储（保存并清理）
 */
export const closeStorage = async (): Promise<void> => {
    if (saveInterval) {
        clearInterval(saveInterval);
    }
    
    await saveData();
    Logger.info('💾 存储数据已保存');
};

/**
 * 清除所有数据（重新开始）
 */
export const clearStorage = (): void => {
    cachedData = {
        positions: [],
        settlementHistory: [],
        stats: {
            totalTrades: 0,
            successfulTrades: 0,
            totalProfit: 0,
            totalCost: 0,
            lastUpdate: Date.now(),
        },
        lastSave: Date.now(),
    };
    isDirty = true;
    saveData();
    Logger.success('🧹 已清除所有历史数据，从零开始');
};

/**
 * 获取存储状态
 */
export const getStorageStatus = (): {
    dataFile: string;
    positionsCount: number;
    historyCount: number;
    lastSave: Date;
    isDirty: boolean;
} => {
    return {
        dataFile: DATA_FILE,
        positionsCount: cachedData.positions.length,
        historyCount: cachedData.settlementHistory.length,
        lastSave: new Date(cachedData.lastSave),
        isDirty,
    };
};

export default {
    initStorage,
    saveData,
    getStoredPositions,
    savePosition,
    deletePosition,
    getSettlementHistory,
    addSettlementRecord,
    getStoredStats,
    updateStats,
    closeStorage,
    clearStorage,
    getStorageStatus,
};



