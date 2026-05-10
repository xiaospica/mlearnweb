# 实盘事件驱动刷新与风险可见性统一计划

## Summary

本计划合并原“策略详情刷新事件化”和“实盘异常可见性”两条线。P0/P1 在 `mlearnweb` 内完成价值闭环：不修改 vnpy 仓库，不接 vnpy WS，不新增事件持久化表。

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

## P2/P3 Deferred

后续阶段再做：
- P2：vnpy `/api/v1/ws` collector，REST fingerprint 降级为 fallback。
- P3：`live_trading_events` SQLite 持久化、ack、历史过滤、vnpy 侧结构化字段增强。

