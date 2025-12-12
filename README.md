# Poly-Arb-Bot

Polymarket BTC/ETH 涨跌事件套利机器人

## 策略原理

### 核心机制

Polymarket 的 BTC/ETH 15分钟涨跌事件：
- 每个事件有两个代币：**Up** 和 **Down**
- 事件结算时，赢的那边每股兑换 **$1**，输的那边归零
- 如果持有 **相同数量** 的 Up 和 Down，无论结果如何，保底拿回 $1/对

### 套利逻辑

当 `Up价格 + Down价格 < $1` 时存在套利机会：

```
例如：BTC Up $0.40 + Down $0.45 = $0.85
买入配对后，无论涨跌都收到 $1
利润 = $1 - $0.85 = $0.15 (17.6%)
```

### 双层策略

1. **跨池套利**：BTC Up + ETH Down 或 BTC Down + ETH Up
   - 寻找组合成本 < $1 的机会
   - 同时买入两边，确保数量一致

2. **同池增持**：在单个池内平衡 Up/Down 仓位
   - 目标：让每个池的 Up = Down
   - 触发条件：卖单价格 ≤ `(1 - 对手方均价) × (1 + 安全边际)`
   - 效果：减少单边风险，提高整体平衡度

## 技术架构

### 数据源

- **WebSocket 订单簿**：实时订阅 Polymarket CLOB
  - 完整快照（book）：初次连接时获取
  - 增量更新（price_changes）：实时维护 asks/bids 数组
  
### 关键文件

| 文件 | 功能 |
|------|------|
| `orderbook-ws.ts` | WebSocket 连接，实时维护订单簿 |
| `scanner.ts` | 扫描套利机会，生成交易信号 |
| `executor.ts` | 执行 FAK 订单，更新仓位 |
| `positions.ts` | 仓位追踪，成本计算 |
| `config.ts` | 配置参数 |

### 订单类型

使用 **FAK (Fill-and-Kill)** 订单：
- 立即执行，吃掉所有可用深度
- 未成交部分自动取消
- `price` 参数作为限价（最高可接受价格）
- `amount` 参数指定 USDC 预算

## 配置说明

### 基础配置

```bash
SIMULATION_MODE=true      # 模拟模式（不实际下单）
PRIVATE_KEY=              # 私钥（实盘必填）
PROXY_WALLET=             # 代理钱包地址
```

### 交易参数

```bash
MAX_ORDER_SIZE_USD=14             # 单笔最大金额
DEPTH_USAGE_PERCENT=90            # 使用深度百分比
PRICE_TOLERANCE_PERCENT=0.5       # 出价容忍度（提高成交率）
MIN_CROSS_POOL_SINGLE_PRICE=0.25  # 跨池单边最低价格
```

### 同池增持

```bash
SAME_POOL_REBALANCE_ENABLED=true  # 启用同池增持
SAME_POOL_SAFETY_MARGIN=2         # 安全边际（%）

# 计算公式：
# maxPrice = (1 - 对手方均价) × (1 + safetyMargin%)
# 例如：Up均价 $0.45, safetyMargin=2%
# maxPrice = 0.55 × 1.02 = $0.561
# 允许组合成本略微亏损，换取更高成交率
```

### 紧急平衡

```bash
EMERGENCY_BALANCE_ENABLED=true    # 启用紧急平衡
EMERGENCY_BALANCE_SECONDS=20      # 最后 N 秒进入紧急模式
EMERGENCY_BALANCE_THRESHOLD=60    # 平衡度阈值（%）
EMERGENCY_BALANCE_MAX_LOSS=5      # 允许最大亏损（%）
```

### 止损配置

```bash
STOP_LOSS_ENABLED=true            # 启用止损
STOP_LOSS_WINDOW_SEC=180          # 结束前 N 秒开始监控
STOP_LOSS_COST_THRESHOLD=0.6      # 组合价低于此值计入风险
STOP_LOSS_RISK_RATIO=0.7          # 风险比例阈值
```

## 运行

### 安装

```bash
npm install
```

### 模拟模式

```bash
npm run dev
```

### 实盘模式

1. 复制 `env-example.txt` 为 `.env`
2. 填入私钥和钱包地址
3. 设置 `SIMULATION_MODE=false`
4. 运行：

```bash
npm run build
npm start

# 或使用 PM2
pm2 start npm --name poly-arb-bot -- start
pm2 logs poly-arb-bot
```

## 日志说明

```
📊 [同池诊断] BTC: Up=209@$0.263 Down=130@$0.453 imbalance=79 平衡62%
   BTC同池[正常]: 平均Up $0.263 + 3档共150@$0.451 = $0.714 限价$0.752
✅ 📉🔄 15min BTC↓同池增持 | 组合:$0.714 | 组:U+79 | buy_down_only
```

- `Up=209@$0.263`：持有 209 股 Up，均价 $0.263
- `imbalance=79`：Up 比 Down 多 79 股
- `3档共150`：订单簿有 3 档共 150 股可吃
- `限价$0.752`：最高可接受买入价格

## 常见问题

### FAK 订单频繁失败

**原因**：订单簿数据过时，探测到的机会实际不存在

**已修复**：WebSocket 增量更新现在实时维护 `asks/bids` 数组

### 同池成功率低

**优化方案**：
1. 提高 `SAME_POOL_SAFETY_MARGIN`（允许更大亏损）
2. 启用紧急平衡模式
3. 确保 WebSocket 连接稳定

### 仓位数据不准确

**解决**：每次交易后自动调用 `syncPositionsFromAPI` 从 Polymarket API 同步真实仓位

## 更新日志

### 2024-12-07

- **修复**：WebSocket 增量更新现在维护完整 `asks/bids` 数组
- **优化**：同池增持支持多档深度，一次吃掉所有 ≤ maxPriceLevel 的卖单
- **改进**：减少虚假机会，提高成交成功率
