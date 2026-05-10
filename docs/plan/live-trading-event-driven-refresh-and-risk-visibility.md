# 实盘事件驱动刷新与风险可见性统一计划

## Summary

本计划合并原“策略详情刷新事件化”和“实盘异常可见性”两条线。P0/P1 在 `mlearnweb` 内完成价值闭环；P2/P3 在不修改 vnpy 仓库的前提下，由 `app.live_main` 接入 vnpy `/api/v1/ws` 并新增 mlearnweb 侧事件持久化。

交付目标：
- 后端将 strategy variables、orders、trades、node health 归一为实时风险事件。
- 浏览器通过 `/api/live-trading/events` SSE 接收 query invalidation，不接收完整业务对象。
- React Query 继续作为权威数据读取层。
- 策略详情页卡片停止各自高频轮询，SSE 断线后启用低频 fallback polling。

## Interfaces

新增只读接口：
- `GET /api/live-trading/strategies/{node_id}/{engine}/{name}/orders`
- `GET /api/live-trading/strategies/{node_id}/{engine}/{name}/risk-events`
- `GET /api/live-trading/events`
- `GET /api/live-trading/risk-events`

新增确认接口：
- `POST /api/live-trading/risk-events/{event_id}/ack`

SSE payload 只包含语义刷新信息：
- `event_type`
- `node_id`
- `engine`
- `strategy_name`
- `severity`
- `reason`
- `query_groups`
- `ts`

Query group 固定集合：
- `strategy_detail`
- `performance_summary`
- `trades`
- `risk_events`
- `ml_latest`
- `ml_metrics`
- `history_dates`
- `corp_actions`
- `strategy_list`
- `nodes`

## Risk Rules

实时风险事件 P0/P1 不落表。当前 severity 规则：
- `last_status=failed` -> `error`
- `replay_status=error` -> `error`
- `REJECTED` / `拒单` / `ORDER_JUNK` -> `error`
- 重报链路相关 `CANCELLED` -> `warning`
- 普通 `CANCELLED` -> `info`
- 超过 5 分钟仍未终态的 `PARTTRADED` -> `warning`
- 节点 offline / gateway disconnected -> `critical`

订单归因使用 `reference={strategy_name}:{seq}`，`R` 后缀识别撤单再报。

## P2/P3 Status

已在 mlearnweb 侧实现：
- P2：`ws_collector_service.py` 为每个 enabled node 连接 `/api/v1/ws?token=...`，处理 `strategy/order/trade/position/account/log` topic，统一发布内部 `LiveTradingEvent`。
- P2 fallback：WS connected 的节点暂停 REST fingerprint 热路径；WS disconnected 时 REST fingerprint 自动继续覆盖该节点。
- P3：新增 `live_trading_events` SQLite 表，支持 dedupe、最近事件查询、风险过滤和 `ack_at/ack_by`。
- P3 风险查询：策略级 `/risk-events` 返回“事件表 + 当前状态补偿”，默认隐藏已确认事件，`include_ack=true` 可查看。

仍未纳入：
- 不修改 vnpy 仓库，不新增 vnpy 侧结构化字段。
- 不实现复杂用户体系；ack 继续受 `X-Ops-Password` 保护。
