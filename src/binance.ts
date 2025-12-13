/**
 * 币安 WebSocket 模块（占位实现）
 * 原功能：实时获取 BTC K 线数据，计算涨跌幅
 */

import Logger from './logger';

let isConnected = false;

/**
 * 初始化币安 WebSocket
 */
export const initBinanceWs = (): void => {
    Logger.info('📡 币安 WebSocket 模块已禁用');
    isConnected = false;
};

/**
 * 关闭 WebSocket
 */
export const closeBinanceWs = (): void => {
    isConnected = false;
};

/**
 * 获取当前 K 线的涨跌幅
 */
export const getKlineChangePercent = (symbol: string, interval: string): number | null => {
    return null;
};

/**
 * 检查 BTC 波动率是否过低
 */
export const isBtcVolatilityTooLow = (interval: string): boolean => {
    return false;
};

/**
 * 获取当前 BTC 涨跌幅信息
 */
export const getBtcChangeInfo = (interval: string): string => {
    return 'N/A';
};

/**
 * 获取 WebSocket 连接状态
 */
export const isBinanceWsConnected = (): boolean => {
    return isConnected;
};

export default {
    initBinanceWs,
    closeBinanceWs,
    getKlineChangePercent,
    isBtcVolatilityTooLow,
    getBtcChangeInfo,
    isBinanceWsConnected,
};

