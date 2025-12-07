/**
 * WebSocket 订单簿管理器
 * 
 * 使用 WebSocket 实时接收订单簿更新，避免 HTTP 轮询
 * Polymarket WebSocket: wss://ws-subscriptions-clob.polymarket.com/ws/market
 */

import WebSocket from 'ws';
import Logger from './logger';

// 订单簿数据
export interface OrderBookData {
    tokenId: string;
    bestAsk: number;
    bestAskSize: number;
    bestBid: number;
    bestBidSize: number;
    timestamp: number;
}

// WebSocket 消息类型
interface WSMessage {
    event_type: string;
    asset_id?: string;
    market?: string;
    price?: string;
    size?: string;
    side?: string;
    timestamp?: string;
    asks?: Array<{ price: string; size: string }>;
    bids?: Array<{ price: string; size: string }>;
}

class OrderBookManager {
    private ws: WebSocket | null = null;
    private orderBooks: Map<string, OrderBookData> = new Map();
    private subscribedTokens: Set<string> = new Set();
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private reconnectDelay = 1000;
    private isConnected = false;
    private onUpdateCallback: ((tokenId: string, data: OrderBookData) => void) | null = null;
    
    private readonly WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
    
    /**
     * 连接 WebSocket
     */
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                Logger.info('🔌 连接 WebSocket...');
                
                this.ws = new WebSocket(this.WS_URL);
                
                this.ws.on('open', () => {
                    Logger.success('✅ WebSocket 连接成功');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    
                    // 重新订阅之前的 tokens
                    if (this.subscribedTokens.size > 0) {
                        this.resubscribeAll();
                    }
                    
                    resolve();
                });
                
                this.ws.on('message', (data: WebSocket.Data) => {
                    this.handleMessage(data.toString());
                });
                
                this.ws.on('close', () => {
                    Logger.warning('WebSocket 连接关闭');
                    this.isConnected = false;
                    this.scheduleReconnect();
                });
                
                this.ws.on('error', (error) => {
                    Logger.error(`WebSocket 错误: ${error.message}`);
                    if (!this.isConnected) {
                        reject(error);
                    }
                });
                
            } catch (error) {
                reject(error);
            }
        });
    }
    
    /**
     * 处理 WebSocket 消息
     */
    private handleMessage(data: string): void {
        try {
            const messages: WSMessage[] = JSON.parse(data);
            
            if (!Array.isArray(messages)) {
                return;
            }
            
            for (const msg of messages) {
                // 处理订单簿快照
                if (msg.event_type === 'book' && msg.asset_id) {
                    this.updateOrderBook(msg.asset_id, msg.asks || [], msg.bids || []);
                }
                
                // 处理价格更新
                if (msg.event_type === 'price_change' && msg.asset_id) {
                    // 增量更新
                    const current = this.orderBooks.get(msg.asset_id);
                    if (current && msg.price && msg.size) {
                        if (msg.side === 'sell') {
                            current.bestAsk = parseFloat(msg.price);
                            current.bestAskSize = parseFloat(msg.size);
                        } else if (msg.side === 'buy') {
                            current.bestBid = parseFloat(msg.price);
                            current.bestBidSize = parseFloat(msg.size);
                        }
                        current.timestamp = Date.now();
                        
                        if (this.onUpdateCallback) {
                            this.onUpdateCallback(msg.asset_id, current);
                        }
                    }
                }
                
                // 处理 last_trade_price 消息
                if (msg.event_type === 'last_trade_price' && msg.asset_id) {
                    // 这个消息包含最新成交价，可以用来辅助判断
                }
            }
        } catch (error) {
            // 静默处理解析错误
        }
    }
    
    /**
     * 更新订单簿数据
     */
    private updateOrderBook(
        tokenId: string,
        asks: Array<{ price: string; size: string }>,
        bids: Array<{ price: string; size: string }>
    ): void {
        let bestAsk = Infinity;
        let bestAskSize = 0;
        let bestBid = 0;
        let bestBidSize = 0;
        
        // 找最低卖价
        for (const ask of asks) {
            const price = parseFloat(ask.price);
            if (price < bestAsk) {
                bestAsk = price;
                bestAskSize = parseFloat(ask.size);
            }
        }
        
        // 找最高买价
        for (const bid of bids) {
            const price = parseFloat(bid.price);
            if (price > bestBid) {
                bestBid = price;
                bestBidSize = parseFloat(bid.size);
            }
        }
        
        const data: OrderBookData = {
            tokenId,
            bestAsk: bestAsk === Infinity ? 1 : bestAsk,
            bestAskSize,
            bestBid,
            bestBidSize,
            timestamp: Date.now(),
        };
        
        this.orderBooks.set(tokenId, data);
        
        if (this.onUpdateCallback) {
            this.onUpdateCallback(tokenId, data);
        }
    }
    
    /**
     * 订阅 token 的订单簿
     */
    subscribe(tokenIds: string[]): void {
        if (!this.ws || !this.isConnected) {
            // 先保存，等连接成功后订阅
            tokenIds.forEach(id => this.subscribedTokens.add(id));
            return;
        }
        
        for (const tokenId of tokenIds) {
            if (this.subscribedTokens.has(tokenId)) {
                continue;
            }
            
            const subscribeMsg = {
                auth: {},
                type: 'market',
                assets_ids: [tokenId],
            };
            
            this.ws.send(JSON.stringify(subscribeMsg));
            this.subscribedTokens.add(tokenId);
        }
        
        Logger.info(`📡 已订阅 ${tokenIds.length} 个 token 的订单簿`);
    }
    
    /**
     * 重新订阅所有 token
     */
    private resubscribeAll(): void {
        if (!this.ws || !this.isConnected) return;
        
        const tokens = Array.from(this.subscribedTokens);
        this.subscribedTokens.clear();
        this.subscribe(tokens);
    }
    
    /**
     * 获取订单簿数据（从缓存）
     */
    getOrderBook(tokenId: string): OrderBookData | null {
        const data = this.orderBooks.get(tokenId);
        
        // 检查数据是否过期（超过 10 秒认为过期）
        if (data && Date.now() - data.timestamp > 10000) {
            return null;
        }
        
        return data || null;
    }
    
    /**
     * 批量获取订单簿
     */
    getOrderBooks(tokenIds: string[]): Map<string, OrderBookData> {
        const result = new Map<string, OrderBookData>();
        
        for (const tokenId of tokenIds) {
            const data = this.getOrderBook(tokenId);
            if (data) {
                result.set(tokenId, data);
            }
        }
        
        return result;
    }
    
    /**
     * 设置更新回调
     */
    onUpdate(callback: (tokenId: string, data: OrderBookData) => void): void {
        this.onUpdateCallback = callback;
    }
    
    /**
     * 计划重连
     */
    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            Logger.error('WebSocket 重连次数过多，停止重连');
            return;
        }
        
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        
        Logger.info(`🔄 ${delay}ms 后尝试重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        
        setTimeout(() => {
            this.connect().catch(() => {
                // 重连失败，会自动触发下一次重连
            });
        }, delay);
    }
    
    /**
     * 关闭连接
     */
    close(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
        this.orderBooks.clear();
        this.subscribedTokens.clear();
    }
    
    /**
     * 检查是否已连接
     */
    get connected(): boolean {
        return this.isConnected;
    }
    
    /**
     * 获取已订阅的 token 数量
     */
    get subscribedCount(): number {
        return this.subscribedTokens.size;
    }
    
    /**
     * 获取缓存的订单簿数量
     */
    get cachedCount(): number {
        return this.orderBooks.size;
    }
}

// 单例导出
export const orderBookManager = new OrderBookManager();
export default orderBookManager;
