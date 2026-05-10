# 实盘策略详情刷新体验第一阶段优化计划

## 2026-05-10 实施状态

第一阶段 P0/P1 已完成，P2 保持为后续增强。

- P0-1 已完成：指标总览刷新从 30 秒收敛到 5 秒。
- P0-2 已完成：详情页手动刷新与写操作成功后统一刷新当前策略页主要 query。
- P0-3 已完成：策略详情后端查询改为目标节点读取，非目标节点慢/失败不再拖慢当前详情。
- P1-1 已完成：实盘详情 query key 与刷新周期集中到 `frontend/src/pages/live-trading/liveTradingRefresh.ts`。
- P1-2 已确认：收益曲线仍由 `snapshot_loop` 驱动，默认后端快照周期不在本阶段强行调小。
- P1-3 已完成：后端策略详情超过 2 秒会记录包含 node/engine/strategy/outcome 的 warning 日志。
- P2 未实施：SSE / WebSocket invalidation 仍作为下一阶段方案。

验证结果：
- `E:\ssd_backup\Pycharm_project\python-3.11.0-amd64\python.exe -m pytest tests/test_backend/test_live_trading.py -q --basetemp .pytest_tmp`：41 passed。
- `E:\ssd_backup\Pycharm_project\python-3.11.0-amd64\python.exe -m pytest tests/test_backend -q --basetemp .pytest_tmp`：155 passed, 9 skipped。
- `cmd /c npm run build`：通过；保留 Vite 既有大 chunk warning。

## 2026-05-10 架构评估后计划

本计划独立于部署路线图，也不并入 `live-trading-detail-metrics-and-history.md`。目标是先用低风险改造解决“策略详情页数据刷新慢、刷新不一致、局部卡片滞后”的体感问题，暂不引入 SSE / WebSocket 事件流。

结论：第一阶段应优先优化现有轮询链路和查询边界。全链路事件驱动可行，但需要 vnpy 节点稳定提供策略、账户、持仓、成交事件流，代价和风险明显高于本阶段目标。

## 当前刷新现状

| 区域 | 当前周期 | 数据来源 | 影响 |
| --- | ---: | --- | --- |
| 实盘策略列表/卡片 | 5 秒 | `GET /api/live-trading/strategies`，多节点 fanout | 列表层刷新基本可接受 |
| 策略详情主数据 | 3 秒 | `GET /api/live-trading/strategies/{node}/{engine}/{name}` | 当前状态、变量、当前持仓理论上应较快 |
| 指标总览卡片 | 30 秒 | performance summary 接口 | 与详情页 3 秒周期不一致，是最明显的滞后来源 |
| 收益曲线 | 前端 3 秒取详情，后端快照默认 10 秒 | `strategy_equity_snapshots` | 曲线刷新受 `snapshot_loop` 限制 |
| 交易记录 | 10 秒 | strategy trades 接口 | 中频数据，通常可接受 |
| 最新 TopK / ML 监控 | 60 秒 | `ml_snapshot_loop` / ML 监控接口 | 日频/推理监控性质，继续低频刷新 |
| 历史持仓 / 历史预测 | 按需查询，缓存 1 到 5 分钟 | 历史接口 / SQLite | 不应作为实时刷新对象 |

## 问题根因

1. 指标总览卡片的 `refetchInterval=30s`，与详情页主数据的 `3s` 周期错配。用户看到最显眼的 KPI 时，会感觉详情页没有及时更新。
2. 详情页手动刷新只触发主详情 query，未同步刷新指标总览、交易记录、TopK、ML 监控等独立 query。
3. 后端详情接口虽然已经带有 `node_id`，但当前实现仍通过多节点 fanout 获取 strategies/accounts/positions。一个无关慢节点或离线节点可能拖慢某个单策略详情页。
4. 收益曲线依赖 `snapshot_loop` 入库，默认 10 秒一次。即使前端 3 秒刷新，曲线也不会比后端快照更实时。
5. 目前刷新周期散落在多个组件中，缺少统一的“实时/准实时/低频/历史”分层规则，后续新增卡片容易再次产生错配。

## 设计原则

### 1. 先修低风险确定性问题

第一阶段不改变数据协议，不要求 vnpy 端新增能力，不引入浏览器长连接。优先修复当前轮询模型中明显不合理的周期、查询范围和手动刷新行为。

合理性：当前慢感主要来自前端 query 周期不一致和后端不必要 fanout，不需要事件驱动也能显著改善。

### 2. 详情页按目标节点查询

列表页需要 fanout 所有节点，因为它要构建全局策略列表；详情页已经有 `node_id / engine / strategy_name`，应只查询目标节点。

合理性：详情页的用户意图是“看这个策略”，不应被其他节点的延迟、离线或异常拖慢。单节点查询也能降低 vnpy HTTP 压力。

### 3. 统一刷新语义

按数据性质分层：

| 分层 | 目标周期 | 适用数据 |
| --- | ---: | --- |
| 热数据 | 3 秒 | 策略详情、运行状态、当前持仓、变量 |
| 准实时汇总 | 3 到 5 秒 | 指标总览、当前权益相关 KPI |
| 中频交易数据 | 10 秒 | 成交/委托等交易记录 |
| 低频 ML 数据 | 60 秒 | TopK、IC、预测摘要、策略监控 |
| 历史/静态数据 | 按需或 1 到 5 分钟 | 历史持仓、历史预测、除权信息 |

合理性：不是所有卡片都应该 3 秒刷新。交易实盘状态要快，ML 日频监控和历史查询保持低频，避免给 vnpy 和 SQLite 带来无意义压力。

### 4. 手动刷新应表达“刷新当前页面”

详情页刷新按钮应刷新当前策略详情页中用户能看到的主要数据，而不是只刷新主详情接口。

合理性：用户点击刷新时，心理模型是“这个页面的数据都更新一下”。如果 KPI 或成交仍停留在旧值，会被理解为系统慢或数据不可信。

### 5. 保留事件驱动演进空间

第一阶段继续使用 React Query + HTTP polling，但应把 query key 和刷新策略收敛，为后续 SSE invalidation 做准备。

合理性：后续做 SSE 时，服务端只需推送“哪些 query 失效”，前端复用同一套 query key/invalidation helper，不需要重写页面数据流。

## 优先级 Backlog

### P0 发布阻断级体验修复

#### P0-1 指标总览刷新与详情页对齐

目标：
- 将 `StrategyPerformanceSummaryCard` 从 30 秒刷新调整为 3 到 5 秒。
- `staleTime` 与刷新周期保持一致或更短，避免页面显示过期 KPI。
- Beta、空曲线、缺失资金字段等降级逻辑不变。

推荐实现：
- 第一版不改接口契约，继续调用 performance summary 接口。
- 周期建议先设为 5 秒，低于原 30 秒，同时避免与详情主 query 完全同频造成重复压力。
- 后续如果接口耗时明显，再评估把 summary 的轻量字段并入详情接口或增加服务端短缓存。

验收：
- 策略状态变化后，指标总览不再最长滞后 30 秒。
- 空数据和 warnings 展示不退化。

#### P0-2 手动刷新覆盖当前详情页主要 query

目标：
- 详情页刷新按钮同时刷新：
  - `live-strategy`
  - `live-strategy-performance-summary`
  - `live-trades`
  - `ml-topk-latest`
  - `ml-metrics-history`
  - `ml-metrics-rolling`
  - `ml-prediction-latest`
- 写操作成功后也复用同一套 invalidation 逻辑。

推荐实现：
- 新增前端 helper，例如 `invalidateLiveStrategyDetailQueries(queryClient, { nodeId, engine, strategyName })`。
- `LiveTradingStrategyDetailPage`、`StrategyActions`、`StrategyEditModal`、删除历史记录成功后统一调用。
- 历史持仓、历史预测、除权信息默认不纳入普通手动刷新，除非后续 UI 提供“刷新历史数据”入口。

验收：
- 点击详情页刷新后，当前页主要卡片的 loading/fetching 状态和数据更新时间一致。
- 启停、编辑、删除记录等操作后，指标总览和交易记录不会继续显示旧值。

#### P0-3 后端详情接口改为目标节点查询

目标：
- `get_strategy_detail()` 只访问目标 `node_id` 的 vnpy client。
- 保留未知节点、节点不可达、策略已移除时的离线快照 fallback。
- 列表页 `list_strategy_summaries()` 继续 fanout 所有节点。

推荐实现：
- 使用 `VnpyMultiNodeClient.get_per_node(node_id)` 获取单节点 client。
- 对目标节点并发请求 `get_strategies()`、`get_accounts()`、`get_positions()`。
- 将单节点结果转换为当前 service 层已有的结构，尽量减少下游组装逻辑改动。
- `get_engines(node_id)` 保持单节点查询。

合理性：
- 单策略详情页不应等待其他节点。
- 离线/慢节点风险从“任意节点影响详情页”收敛为“只有当前节点影响当前详情页”。

验收：
- 一个非目标节点超时，不影响另一个节点上的策略详情加载。
- 目标节点不可达时仍能展示历史快照。
- 已有详情页响应结构保持兼容。

### P1 正式体验收敛

#### P1-1 收敛刷新周期常量和 query key

目标：
- 将实盘详情相关刷新周期集中定义，避免组件内散落魔法数字。
- 将常用 query key 生成逻辑集中定义，为后续 SSE invalidation 复用。

推荐实现：
- 新增前端模块，例如 `frontend/src/pages/live-trading/queryKeys.ts` 或 `refreshPolicy.ts`。
- P0/P1 SSE 实施后，刷新常量已收敛为 fallback policy：
  - `LIVE_DETAIL_FALLBACK_REFRESH_MS = 30000`
  - `LIVE_SUMMARY_FALLBACK_REFRESH_MS = 30000`
  - `LIVE_TRADES_FALLBACK_REFRESH_MS = 30000`
  - `LIVE_RISK_FALLBACK_REFRESH_MS = 30000`
  - `ML_MONITOR_FALLBACK_REFRESH_MS = 180000`
  - `HISTORY_*_STALE_MS = 60000/300000`
- 组件只引用常量和 query key factory。

验收：
- 搜索 `refetchInterval` 时，实盘详情页不再出现难以解释的散落数值。
- 后续要调周期时只改一处或少数几处。

#### P1-2 明确收益曲线刷新边界

目标：
- 文档和 UI 语义说明清楚：收益曲线由 `snapshot_loop` 快照驱动，实时性由 `vnpy_poll_interval_seconds` 决定。
- 不在第一阶段默认把后端快照周期强行改小，避免生产环境 SQLite/HTTP 压力不可控。

推荐实现：
- 保持默认 10 秒。
- 在运行时设置说明中建议：
  - 单节点/低策略数场景可调到 2 到 3 秒。
  - 多节点/多策略生产环境先保持 5 到 10 秒。
- 如果后续用户确认需要高频曲线，再单独评估 intraday 曲线粒度、SQLite 写入压力和图表降采样。

验收：
- 用户能理解为什么当前持仓 3 秒刷新，而收益曲线可能 10 秒变化一次。
- 不把曲线刷新慢误判为详情页整体刷新失效。

#### P1-3 增加慢请求可观测性

目标：
- 后端记录策略详情接口耗时、目标节点和失败原因。
- 当目标节点耗时超过阈值时输出 warning 日志。

推荐实现：
- 在 `get_strategy_detail()` 或 router 层增加轻量耗时日志。
- 阈值建议 2 秒。
- 日志中包含 `node_id/engine/strategy_name`，但不记录敏感 token/password。

验收：
- 用户反馈“详情页慢”时，可以从日志判断是前端周期、mlearnweb 处理慢，还是 vnpy 节点响应慢。

### P2 后续增强，不阻断第一阶段交付

#### P2-1 页面级刷新状态优化

目标：
- 刷新按钮 loading 能表达“当前页正在刷新多个数据块”，而不是只绑定主详情 query。
- 可在必要时给单独卡片增加小型刷新时间提示。

验收：
- 用户能分辨“正在刷新”和“数据为空/无变化”。

#### P2-2 混合 SSE invalidation 预研

目标：
- 不在第一阶段实现。
- 记录后续方案：mlearnweb 维持现有轮询或接入 vnpy WS，检测到变化后通过 SSE 推送 query invalidation 事件给前端。

验收：
- 第一阶段代码结构不阻碍后续新增 `/api/live-trading/events`。

## 非目标

- 不实现 SSE / WebSocket。
- 不修改 vnpy 节点或 vnpy_webtrader 协议。
- 不把所有卡片都改成 3 秒刷新。
- 不改变历史持仓仍位于“策略监控”页签的设计。
- 不引入前端自行计算金融指标来绕过后端口径。

## 测试计划

后端：
- 增加/调整 `get_strategy_detail` 测试，覆盖目标节点查询。
- 构造两个节点：目标节点正常、非目标节点超时/报错，详情接口应成功。
- 目标节点不可达时，离线快照 fallback 仍然可用。
- 运行：`python -m pytest mlearnweb/tests/test_backend -q`

前端：
- 构建通过：`cmd /c npm run build`
- 手工验证：
  - 策略详情页刷新按钮会触发指标总览、交易记录、TopK/监控 query 更新。
  - 指标总览最长刷新滞后从 30 秒降到 3 到 5 秒。
  - 历史持仓仍只在“策略监控”页签内展示。

## 验收门槛

- P0 全部完成后，才认为第一阶段“刷新慢体感修复”完成。
- P1 全部完成后，才认为第一阶段“刷新策略收敛”完成。
- P2 作为后续增强，不阻断第一阶段上线。

## 后续事件驱动方向

后续事件驱动方向已合并到统一计划：

- `mlearnweb/docs/plan/live-trading-event-driven-refresh-and-risk-visibility.md`
- 该计划明确：P0/P1 只在 mlearnweb 内实现 SSE invalidation、REST fingerprint 和风险可见性；P2 才接 vnpy WS；P3 才做事件持久化与 ack。
