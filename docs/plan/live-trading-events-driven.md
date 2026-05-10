# 实盘策略详情事件中台计划：统一刷新 + 异常可见性

## Summary

这两个需求本质上是同一个架构问题的两面：

- **策略详情统一事件驱动刷新**：解决“前端多个卡片各自轮询、刷新节奏割裂、数据体感慢”的问题。
- **实盘异常可见性**：解决“vnpy 侧策略异常、拒单、撤单、撤单再报、撮合异常、日志错误没有进入前端监控语义”的问题。

统一方案是：在 `mlearnweb live_main` 建一个“实盘事件中台”。后端把 vnpy REST、vnpy WS、mlearnweb 同步 loop、写操作结果、watchdog 状态都归一为内部事件；前端只通过 SSE 接收“刷新事件”，再用 React Query 拉取权威数据。异常可见性则作为这套事件中台上的高优先级业务事件展示出来。

关键判断：

- 前端可以统一事件驱动，避免继续新增卡片轮询。
- 后端不能一步到位完全取消轮询，因为 ML 历史、预测回填、权益快照、参考数据本来就是同步/沉淀型数据。
- P0/P1 不改 vnpy 仓库，先用现有 REST + mlearnweb loop 完成价值闭环。
- P2 接 vnpy `/api/v1/ws`，把热数据升级到接近实时。
- P3 再回 vnpy 侧补结构化字段和历史事件接口。

实施完成后必须同步更新：

- F:\Quant\code\qlib\_strategy\_dev\mlearnweb\docs 下相关开发/架构/测试文档。
- 评估是否需要更新父仓库 AGENTS.md，若新增长期有效的架构规则、开发流程或测试要求，则必须更新。

## Requirements Analysis

### 需求 A：策略详情统一事件驱动刷新

目标不是“把所有数据都通过 WebSocket 推到前端”，而是：

- 前端不再让 `StrategyPerformanceSummaryCard`、`TradesCard`、`MlMonitorPanel`、`LatestTopkCard` 等各自高频 `refetchInterval`。
- 前端统一订阅 `/api/live-trading/events`。
- SSE 收到事件后，按语义 invalidate 对应 query。
- React Query 仍然是读取权威数据的方式。
- SSE 断线时启用低频 fallback polling，保证最终一致。

成功标准：

- 策略详情页所有主要数据块的刷新由同一套事件机制驱动。
- 新增卡片时只需要声明它依赖哪些 `query_groups`，不再自己发明刷新周期。
- 事件驱动完成后，策略详情页不再出现多个 3s/5s/10s/60s 的孤立前端轮询。

### 需求 B：实盘异常可见性

目标不是“多加一个日志面板”，而是：

- 把拒单、撤单、重报、部分成交超时、策略运行失败、回放失败、撮合异常、节点/网关异常归一为风险事件。
- 风险事件进入列表卡片、详情顶部 Alert、策略监控页签。
- 成交仍然是成交，拒单/撤单不能塞进成交表混淆语义。
- 风险事件既能驱动 UI 展示，也能驱动 query 刷新。

成功标准：

- 用户不进入 vnpy 或日志文件，也能在 mlearnweb 中看到“这个策略为什么没按预期成交/运行”。
- 策略详情顶部能看到当前最高风险。
- “策略监控”页签能看到完整风险事件列表。
- 列表卡片能显示风险计数和最高风险等级。

## Data Source Inventory

| 页面区域                  | 当前数据源                                                         | 刷新诉求 | 是否前端事件驱动 | 后端事件来源                                                 |
| --------------------- | ------------------------------------------------------------- | ---- | -------- | ------------------------------------------------------ |
| 详情页 header 状态         | `getStrategy()`，vnpy strategy/account/position + SQLite curve | 热数据  | 是        | strategy REST fingerprint；P2 用 vnpy `strategy` WS      |
| 参数/variables          | `getStrategy()`                                               | 热数据  | 是        | strategy changed                                       |
| 当前持仓                  | `getStrategy()` 中 positions                                   | 热数据  | 是        | position/order/trade/account changed                   |
| 收益曲线                  | SQLite `strategy_equity_snapshots`                            | 准实时  | 是        | `snapshot_loop` 写库；P2 用 account/position/trade 触发      |
| 指标总览                  | `performance-summary`，后端从详情/曲线/账户计算                           | 准实时  | 是        | strategy/equity/position/account changed               |
| 交易记录                  | `/trades`，vnpy trades + orders 归因                             | 热数据  | 是        | order/trade changed                                    |
| 风险事件                  | 新增 `/risk-events`                                             | 热数据  | 是        | order/log/strategy/node risk changed                   |
| 最新 TopK               | ML latest prediction / SQLite fallback                        | 中低频  | 是        | `ml_snapshot_loop` 写库；strategy last\_run\_date changed |
| ML 指标 history/rolling | SQLite `ml_metric_snapshots`                                  | 中低频  | 是        | `ml_snapshot_loop` / historical\_metrics\_sync 写库      |
| 历史预测                  | SQLite / prediction parquet                                   | 按需   | 部分是      | historical\_predictions\_sync 完成后刷新日期/summary          |
| 历史持仓日期                | vnpy history dates / equity snapshot fallback                 | 按需   | 部分是      | 新日期出现或历史 sync 完成                                       |
| 指定日历史持仓               | vnpy history endpoint                                         | 按需   | 否，高缓存    | 用户选择日期时查询                                              |
| 除权事件                  | 当前持仓 symbols + reference data                                 | 低频   | 依赖持仓变化   | 持仓集合变化时刷新，另保留日级缓存                                      |
| Backtest diff         | 用户手动触发                                                        | 按需   | 否        | 不纳入自动事件刷新                                              |

结论：

- **所有前端 query 都可以纳入统一事件 invalidation。**
- **不是所有后端数据都需要 vnpy WS。** ML、历史、参考数据更适合由 mlearnweb 同步 loop 发布“数据已更新”事件。
- **热交易数据优先接 vnpy WS。** 策略状态、订单、成交、持仓、账户、日志最适合 P2 从 vnpy WS 进入事件中台。

## Target Architecture

### 事件分层

1. **事件来源层**
   - P1：mlearnweb 内部 loop 和 REST fingerprint。
   - P2：vnpy `/api/v1/ws`。
   - 写操作：init/start/stop/edit/delete 成功后立即发布事件。
   - watchdog：节点 offline/recovery 发布事件。
2. **事件归一层**
   - 把不同来源统一为 `LiveTradingEvent`。
   - 做策略归因、severity 分类、去重、节流。
   - 对风险事件生成 `RiskEvent` 视图。
3. **事件分发层**
   - `/api/live-trading/events` SSE。
   - 只推 invalidation 事件，不推完整业务数据。
   - 前端根据 event type 映射到 React Query invalidation。
4. **权威数据读取层**
   - 仍然使用现有 REST API 获取策略详情、指标总览、成交、ML 监控、历史持仓等。
   - 事件只负责“什么时候刷新”。

### SSE Payload

后端不要发送 React Query key，避免后端耦合前端实现。发送语义 group：

```json
{
  "event_id": "node-engine-strategy-1770000000000",
  "event_type": "strategy.order_trade.changed",
  "node_id": "local",
  "engine": "MlStrategy",
  "strategy_name": "demo_strategy",
  "severity": "warning",
  "reason": "order_rejected",
  "query_groups": ["strategy_detail", "performance_summary", "trades", "risk_events"],
  "ts": 1770000000000
}
```

前端映射：

| query\_group          | invalidate                                             |
| --------------------- | ------------------------------------------------------ |
| `strategy_detail`     | `strategyDetail(nodeId, engine, strategyName)`         |
| `performance_summary` | `strategyPerformanceSummary(...)`                      |
| `trades`              | `trades(...)`                                          |
| `risk_events`         | 新增 `riskEvents(...)`                                   |
| `ml_latest`           | `mlTopkLatest(...)`、`mlPredictionLatest(...)`          |
| `ml_metrics`          | `mlMetricsHistory(...)`、`mlMetricsRolling(...)`        |
| `history_dates`       | `historicalPositionDates(...)`、prediction date queries |
| `corp_actions`        | 当前持仓 symbols 变化时刷新 corp actions                        |
| `strategy_list`       | `strategies()`                                         |
| `nodes`               | `nodes()`                                              |

### 风险事件模型

新增前后端共享类型，最小字段：

```text
StrategyRiskEvent
- event_id
- node_id
- engine
- strategy_name
- severity: info | warning | error | critical
- category: strategy | order | trade | log | node | gateway
- title
- message
- status
- vt_orderid
- vt_symbol
- reference
- is_resubmit
- event_ts
- source: rest_fingerprint | vnpy_ws | watchdog | strategy_variables
```

P0/P1 实时计算，不落表；P2/P3 再持久化。

### 生产代理要求

当前 `app.main` 的 `_live_proxy.py` 会把上游响应读成 `upstream.content` 再返回，SSE 会被缓冲，生产单端口下不可用。

因此 P1 必须修复：

- `/api/live-trading/events` 走 `StreamingResponse` 透传。
- 过滤 hop-by-hop headers。
- 保持连接不断流，支持心跳。
- Vite dev proxy 和生产 proxy 都要验证 SSE。

## Priority Backlog

### P0：需求合并与异常可见基础

目标：先把两个需求统一成一个工程计划，并让异常数据有正式 API 和 UI 入口。

- **P0-1 合并计划文档**
  - 新增或重写计划文档为 `live-trading-event-driven-refresh-and-risk-visibility.md`。
  - 明确弃用“刷新事件计划”和“异常可见性计划”割裂表达。
  - 在 `live-trading-detail-refresh-phase1.md` 的 P2 后续方向中引用该统一计划。
- **P0-2 新增后端订单与风险事件只读接口**
  - `GET /api/live-trading/strategies/{node_id}/{engine}/{name}/orders`
  - `GET /api/live-trading/strategies/{node_id}/{engine}/{name}/risk-events`
  - 使用目标节点读取 orders/trades/strategy variables，不做多节点 fanout。
  - 按 `reference={strategy_name}:{seq}` 归因；`R` 后缀识别撤单再报。
- **P0-3 风险 severity 规则**
  - `last_status=failed` → `error`
  - `replay_status=error` → `error`
  - `REJECTED` / `拒单` / `ORDER_JUNK` → `error`
  - `CANCELLED` 且与重报链路相关 → `warning`
  - `PARTTRADED` 长时间未终态 → `warning`
  - 节点 offline / gateway disconnected → `critical`
  - 普通成交、普通日志不进入高危 Alert。
- **P0-4 前端风险可见性**
  - 新增 `riskEvents` query key 和 `liveTradingService.listStrategyRiskEvents()`。
  - 策略详情顶部显示最高风险 Alert。
  - “策略监控”页签新增 `RiskEventsCard`，放在 ML 监控 KPI 和历史持仓附近。
  - 策略列表卡片显示风险计数和最高 severity。
  - 成交表保持只展示成交，不混入订单异常。

### P1：SSE 事件中台与前端统一刷新

目标：先不依赖 vnpy WS，完成“前端统一事件驱动刷新”，减少策略详情多点高频轮询。

- **P1-1 后端事件总线**
  - 在 live\_main 进程内新增 in-memory event bus。
  - 支持 publish、subscribe、heartbeat、按连接清理。
  - 每个 SSE 连接使用独立 bounded queue。
  - 对同一 `(node_id, engine, strategy_name, query_group)` 做 500-1000ms coalesce。
  - `critical/error` 风险事件立即发送，不被普通节流延迟。
- **P1-2 SSE endpoint**
  - 新增 `GET /api/live-trading/events`。
  - 支持心跳事件，建议 15s 一次。
  - 支持断线重连；前端不依赖精确顺序，只依赖最终 invalidate。
  - 修复生产 `_live_proxy.py` 对 SSE 的 streaming 透传，否则单端口部署不可用。
- **P1-3 mlearnweb 内部事件生产者**
  - 写操作成功后发布 `strategy.state.changed`。
  - `snapshot_loop` 写入权益快照后发布 `strategy.equity.changed`。
  - `ml_snapshot_loop` 写入 metrics/prediction 后发布 `strategy.ml.changed`。
  - historical metrics/predictions sync 插入新数据后发布 `strategy.history.changed`。
  - replay equity sync 写入后发布 `strategy.equity.changed`。
  - watchdog offline/recovery 发布 `node.changed`。
  - 删除历史记录成功后发布 `strategy.history.changed` 和 `strategy.equity.changed`。
- **P1-4 REST fingerprint detector**
  - 用现有 REST 监控热数据变化，作为 vnpy WS 前的过渡事件源。
  - fingerprint 包含：
    - 策略 `inited/trading/last_status/last_error/replay_status`
    - 当前持仓摘要：symbol、volume、market\_value、pnl
    - 订单摘要：vt\_orderid、status、traded、status\_msg、reference
    - 风险摘要：最高 severity、风险计数
  - 只有 fingerprint 变化时发布事件。
  - detector 周期默认 3-5s，可用 runtime setting 调整。
- **P1-5 前端统一 invalidation hook**
  - 新增 `useLiveTradingInvalidations()`。
  - 在 live-trading 页面入口挂载一次。
  - 收到 SSE 后按 `query_groups` 调用 `liveTradingRefresh.ts` helper。
  - 新增 `eventsConnected` 状态。
  - SSE connected 时禁用策略详情卡片高频 `refetchInterval`。
  - SSE disconnected 时启用 fallback polling：
    - detail/list：30s
    - trades/risk：30s
    - ML：2-5min
    - history：按需，不自动轮询
- **P1-6 清理前端刷新策略**
  - `StrategyPerformanceSummaryCard` 不再自带 5s 常态轮询。
  - `TradesCard` 不再自带 10s 常态轮询。
  - `MlMonitorPanel` 不再自带 60s 常态轮询。
  - `LatestTopkCard` 不再自带 60s 常态轮询。
  - `CorpActionsCard` 只在持仓 symbols 变化或低频 fallback 时刷新。
  - 历史持仓/历史预测保持按需查询，不变成高频实时刷新。

### P2：接入 vnpy WS，升级热数据事件源

目标：把 P1 的 REST fingerprint 逐步替换为 vnpy 主动事件，降低延迟和 REST 压力。

- **P2-1 vnpy WS collector**
  - mlearnweb live\_main 为每个 enabled node 维护 `/api/v1/ws?token=...`。
  - 复用 `_PerNodeClient` 登录逻辑或抽出 token 管理。
  - 支持断线重连、指数退避、token 过期重登。
  - 单节点 WS 失败不影响其他节点和 REST fallback。
- **P2-2 topic 处理**
  - `strategy` → `strategy.state.changed`
  - `order` → `strategy.order_trade.changed` + `strategy.risk.changed`
  - `trade` → `strategy.order_trade.changed` + `strategy.position.changed`
  - `position` → `strategy.position.changed`
  - `account` → `strategy.equity.changed`
  - `log` → 解析策略名后生成 `strategy.risk.changed` 或 node log event
- **P2-3 归因与降噪**
  - order/trade 优先用 `reference` 归因。
  - log 优先解析 `[{strategy_name}]`。
  - 无法归因的 log 只作为节点级风险，不刷新所有策略详情。
  - 高频 account/position 事件按策略维度节流，避免指标总览和曲线被刷爆。
  - 订单/拒单/critical 风险不被普通节流吞掉。
- **P2-4 fallback 策略**
  - WS connected：REST fingerprint 降频或暂停。
  - WS disconnected：REST fingerprint 自动恢复。
  - 启动后先做一次 REST baseline，避免 WS 连接前状态为空。

### P3：事件持久化与 vnpy 侧结构化增强

目标：让风险事件可追溯、可确认，并减少 mlearnweb 字符串解析。

- **P3-1 新增** **`live_trading_events`** **表**
  - 保存风险事件、订单事件、策略状态关键事件。
  - 支持 dedupe key。
  - 支持最近 N 天查询。
  - 支持 `ack_at/ack_by` 后续人工确认。
- **P3-2 风险事件历史 API**
  - `/risk-events` 从实时计算升级为“事件表 + 当前状态补偿”。
  - 支持 severity、category、时间范围过滤。
- **P3-3 vnpy 侧增强**
  - order/log payload 显式携带 `strategy_name`。
  - AutoResubmitMixin 暴露 `resubmit_count/reject_count/cancel_count/last_order_error`。
  - vnpy\_qmt\_sim 对撮合阻塞、资金不足、持仓不足、涨跌停拒单输出结构化 `risk_reason`。
  - vnpy webtrader 增加短期事件历史接口，用于 mlearnweb 重启补拉。

## Query Invalidation Mapping

| event\_type                    | query\_groups                                                            | 前端刷新范围                  |
| ------------------------------ | ------------------------------------------------------------------------ | ----------------------- |
| `node.changed`                 | `nodes`, `strategy_list`                                                 | 节点条、列表、当前详情离线态          |
| `strategy.state.changed`       | `strategy_detail`, `performance_summary`, `strategy_list`, `risk_events` | header、参数变量、状态、风险       |
| `strategy.position.changed`    | `strategy_detail`, `performance_summary`, `corp_actions`                 | 当前持仓、仓位、可用资金、除权依赖       |
| `strategy.equity.changed`      | `strategy_detail`, `performance_summary`, `strategy_list`                | 收益曲线、指标总览、列表 mini curve |
| `strategy.order_trade.changed` | `trades`, `risk_events`, `strategy_detail`, `performance_summary`        | 成交、订单异常、持仓/资金派生         |
| `strategy.risk.changed`        | `risk_events`, `strategy_detail`, `strategy_list`                        | 顶部 Alert、风险卡片、列表角标      |
| `strategy.ml.changed`          | `ml_latest`, `ml_metrics`, `strategy_detail`                             | TopK、ML KPI、调度状态        |
| `strategy.history.changed`     | `history_dates`, `ml_metrics`, `ml_latest`                               | 历史持仓日期、历史预测、回填数据        |

## Acceptance Criteria

- 策略详情页新增风险可见性后，用户能看到：
  - 策略运行失败
  - replay 失败
  - 拒单
  - 撤单
  - 撤单再报
  - 部分成交未终态
  - 节点/网关异常
- SSE connected 时，策略详情各卡片不再各自高频轮询。
- SSE disconnected 时，页面进入低频 fallback polling，不会长期 stale。
- 生产单端口模式 `:8000` 下 SSE 可用，不被 `_live_proxy.py` 缓冲。
- 历史持仓仍在“策略监控”页签，不回到“收益曲线与持仓”页签。
- 前端右键新标签打开策略详情的行为不受影响。
- 不要求 P1 修改 vnpy 仓库。
- P2 接入 vnpy WS 后，拒单/成交/持仓/策略状态变化能接近实时触发前端刷新。

## **Documentation Updates After Implementation**

实施完成后必须更新以下文档：

- mlearnweb/docs/ARCHITECTURE.md
  - 补充实盘事件中台架构。
  - 说明 SSE、event bus、vnpy WS collector、REST fallback 的关系。
- mlearnweb/docs/mlearnweb-technical-design.md
  - 补充事件模型、query group 映射、风险事件模型。
  - 说明为什么 SSE 只推 invalidation，不推业务大对象。
- mlearnweb/docs/DEVELOPMENT.md
  - 补充新增 live-trading 卡片时如何接入 query group。
  - 明确不要在策略详情卡片中新增独立高频轮询。
- mlearnweb/docs/TESTING.md
  - 补充 SSE、event bus、risk events、vnpy WS fallback 的测试方法。
- mlearnweb/README.md
  - 只在必要时补充“实盘事件驱动监控”能力入口，避免 README 过度展开。
- 父仓库 AGENTS.md
  - 若实现后形成长期规则，需增加：
    - live-trading 前端卡片刷新必须走统一 event invalidation。
    - 不允许新增孤立高频 refetchInterval。
    - 风险事件必须在后端归一，前端不直接解析 vnpy 原始 payload。
    - 前端不得直接连接 vnpy WS。

## Test Plan

### 后端测试

- risk normalization：
  - `REJECTED` → error
  - `CANCELLED` → warning
  - `PARTTRADED` 未终态 → warning
  - `strategy:2R` → `is_resubmit=true`
  - 非当前策略 reference 不进入结果
- risk API：
  - 空订单/空策略变量返回空列表，不 500
  - 节点不可达返回 warning，不影响页面整体
- event bus：
  - 多 SSE client 都能收到事件
  - client 断开后 queue 被清理
  - heartbeat 正常发送
  - coalesce 不丢 critical risk event
- live proxy：
  - `/api/live-trading/events` 在 app.main 单端口代理下保持 streaming
- loop producer：
  - snapshot 写库后发布 equity event
  - ml snapshot 写库后发布 ml event
  - watchdog offline/recovery 发布 node event
- 命令：
  - `python -m pytest tests/test_backend -q`

### 前端测试

- SSE hook：
  - 收到 `strategy.equity.changed` 后刷新曲线和指标总览
  - 收到 `strategy.order_trade.changed` 后刷新交易和风险卡片
  - 收到 `strategy.ml.changed` 后刷新 TopK 和 ML 监控
  - SSE 断线后 fallback polling 生效
- 风险 UI：
  - 详情顶部显示最高风险 Alert
  - “策略监控”页签显示 `RiskEventsCard`
  - 策略列表显示风险计数/最高 severity
  - 无风险时正常降级
- 回归：
  - `cmd /c npm run build`

## Assumptions

- P0/P1 不修改 vnpy 仓库，不依赖 vnpy WS。
- P1 的目标是取消前端策略详情多点高频轮询，不是取消所有后端同步 loop。
- P2 才接 vnpy WS，并保留 REST fingerprint fallback。
- P3 才新增事件持久化和 vnpy 结构化增强。
- SSE 只推刷新事件，不推完整业务对象。
- React Query 继续作为前端权威数据读取层。
- 风险事件和刷新事件共用同一事件中台，但 UI 展示和 query invalidation 分别处理。

