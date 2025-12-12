/**
 * 币安 WebSocket 模块
 * 
 * 使用 WebSocket 实时获取 BTC K 线数据，计算涨跌幅
 */

import WebSocket from 'ws';
import Logger from './logger';
import CONFIG from './config';

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws';

// K 线实时数据
interface KlineData {
    symbol: string;
    interval: string;
    openPrice: number;
    currentPrice: number;
    highPrice: number;
    lowPrice: number;
    changePercent: number;  // (currentPrice - openPrice) / openPrice * 100
    updateTime: number;
}

// 存储各个时间周期的 K 线数据
const klineData = new Map<string, KlineData>();

// WebSocket 连接
let ws: WebSocket | null = null;
let isConnected = false;
let reconnectTimer: NodeJS.Timeout | null = null;

// 订阅的数据流
const subscribedStreams = new Set<string>();

/**
 * 获取数据流名称
 */
const getStreamName = (symbol: string, interval: string): string => {
    return `${symbol.toLowerCase()}@kline_${interval}`;
};

/**
 * 获取缓存 key
 */
const getCacheKey = (symbol: string, interval: string): string => {
    return `${symbol}_${interval}`;
};

/**
 * 处理 K 线数据更新
 */
const handleKlineUpdate = (data: any): void => {
    try {
        const kline = data.k;
        if (!kline) return;
        
        const symbol = data.s;  // 如 'BTCUSDT'
        const interval = kline.i;  // 如 '15m'
        const openPrice = parseFloat(kline.o);
        const currentPrice = parseFloat(kline.c);
        const highPrice = parseFloat(kline.h);
        const lowPrice = parseFloat(kline.l);
        
        if (openPrice === 0) return;
        
        const changePercent = ((currentPrice - openPrice) / openPrice) * 100;
        
        const cacheKey = getCacheKey(symbol, interval);
        klineData.set(cacheKey, {
            symbol,
            interval,
            openPrice,
            currentPrice,
            highPrice,
            lowPrice,
            changePercent,
            updateTime: Date.now(),
        });
    } catch (error) {
        // 静默处理解析错误
    }
};

/**
 * 连接 WebSocket
 */
const connect = (): void => {
    if (ws && isConnected) return;
    
    // 构建订阅 URL（组合多个数据流）
    const streams = Array.from(subscribedStreams);
    if (streams.length === 0) {
        // 默认订阅 BTC 15m 和 1h
        subscribedStreams.add(getStreamName('BTCUSDT', '15m'));
        subscribedStreams.add(getStreamName('BTCUSDT', '1h'));
    }
    
    const streamList = Array.from(subscribedStreams).join('/');
    const url = `${BINANCE_WS_URL}/${streamList}`;
    
    try {
        ws = new WebSocket(url);
        
        ws.on('open', () => {
            isConnected = true;
            Logger.success(`📡 币安 WebSocket 已连接 (${subscribedStreams.size} 个数据流)`);
        });
        
        ws.on('message', (data: WebSocket.Data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.e === 'kline') {
                    handleKlineUpdate(msg);
                }
            } catch (error) {
                // 静默处理
            }
        });
        
        ws.on('close', () => {
            isConnected = false;
            Logger.warning('📡 币安 WebSocket 断开，5 秒后重连...');
            scheduleReconnect();
        });
        
        ws.on('error', (error) => {
            Logger.error(`📡 币安 WebSocket 错误: ${error.message}`);
            isConnected = false;
        });
    } catch (error) {
        Logger.error(`📡 币安 WebSocket 连接失败: ${error}`);
        scheduleReconnect();
    }
};

/**
 * 安排重连
 */
const scheduleReconnect = (): void => {
    if (reconnectTimer) return;
    
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!isConnected) {
            connect();
        }
    }, 5000);
};

/**
 * 初始化币安 WebSocket（在程序启动时调用）
 */
export const initBinanceWs = (): void => {
    if (!CONFIG.BINANCE_VOLATILITY_CHECK_ENABLED) {
        Logger.info('📡 币安波动率检查未启用，跳过 WebSocket 连接');
        return;
    }
    
    // 订阅 BTC 15m 和 1h K 线
    subscribedStreams.add(getStreamName('BTCUSDT', '15m'));
    subscribedStreams.add(getStreamName('BTCUSDT', '1h'));
    
    connect();
};

/**
 * 关闭 WebSocket
 */
export const closeBinanceWs = (): void => {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    if (ws) {
        ws.removeAllListeners();
        ws.close();
        ws = null;
    }
    
    isConnected = false;
};

/**
 * 获取当前 K 线的涨跌幅（实时数据）
 * @param symbol 交易对，如 'BTCUSDT'
 * @param interval K 线间隔，如 '15m', '1h'
 * @returns 涨跌幅百分比（如 0.05 表示 0.05%），无数据返回 null
 */
export const getKlineChangePercent = (
    symbol: string,
    interval: string
): number | null => {
    const cacheKey = getCacheKey(symbol, interval);
    const data = klineData.get(cacheKey);
    
    if (!data) return null;
    
    // 检查数据是否过期（超过 30 秒没更新）
    if (Date.now() - data.updateTime > 30000) {
        return null;
    }
    
    return data.changePercent;
};

/**
 * 检查 BTC 波动率是否过低（可能导致双输）
 * @param interval K 线间隔，如 '15m', '1h'
 * @returns true = 波动率过低，应该对冲
 */
export const isBtcVolatilityTooLow = (interval: string): boolean => {
    if (!CONFIG.BINANCE_VOLATILITY_CHECK_ENABLED) {
        return false;
    }
    
    const changePercent = getKlineChangePercent('BTCUSDT', interval);
    
    if (changePercent === null) {
        return false;  // 无数据，不触发
    }
    
    const absChange = Math.abs(changePercent);
    const threshold = CONFIG.BINANCE_MIN_VOLATILITY_PERCENT;
    
    return absChange < threshold;
};

/**
 * 获取当前 BTC 涨跌幅信息（用于日志）
 */
export const getBtcChangeInfo = (interval: string): string => {
    const changePercent = getKlineChangePercent('BTCUSDT', interval);
    
    if (changePercent === null) {
        return 'N/A';
    }
    
    const emoji = changePercent >= 0 ? '📈' : '📉';
    return `${emoji} ${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(3)}%`;
};

/**
 * 获取 WebSocket 连接状态
 */
export const isBinanceWsConnected = (): boolean => {
    return isConnected;
};

/**
 * 获取当前 K 线详细信息（用于调试）
 */
export const getKlineInfo = (symbol: string, interval: string): KlineData | null => {
    const cacheKey = getCacheKey(symbol, interval);
    return klineData.get(cacheKey) || null;
};

export default {
    initBinanceWs,
    closeBinanceWs,
    getKlineChangePercent,
    isBtcVolatilityTooLow,
    getBtcChangeInfo,
    isBinanceWsConnected,
    getKlineInfo,
};



