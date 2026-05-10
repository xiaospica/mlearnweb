# 实盘策略详情指标总览与历史持仓计划

## 2026-05-10 实施范围

本计划独立于 `mlearnweb-independent-deploy-roadmap.md`，只覆盖实盘策略详情页的两项体验补强：

- 在“收益曲线与持仓”页签顶部新增指标总览卡片，展示累计收益、年化收益、总资产、可用资金、仓位占比、Beta、最大回撤等指标。
- 历史持仓浏览保持在“策略监控”页签内；修复方向是让该组件的数据来源更稳健，而不是移动到“收益曲线与持仓”页签。

## 架构决策

- 指标计算放在后端：新增 `GET /api/live-trading/strategies/{node_id}/{engine}/{strategy_name}/performance-summary`，基于 `strategy_equity_snapshots` 和当前策略详情计算，前端只展示。
- 历史持仓日期独立查询：新增 `GET /api/live-trading/strategies/{node_id}/{engine}/{strategy_name}/positions/dates`，优先尝试 vnpy 节点日期索引，失败时回退到本地权益快照日期。
- Beta 不造假：没有基准收益序列时返回 `null`，前端显示 `--`；后续接入基准曲线后再启用真实计算。
- 前端保持实盘工作台风格：`StrategyPerformanceSummaryCard` 使用紧凑 KPI 栅格，不做大面积装饰；`HistoricalPositionsCard` 继续由 `MlMonitorPanel` 承载，并兼容传入 `historyDates` 的老用法。

## 实施清单

- 后端：
  - 新增 performance summary 计算逻辑：累计收益、年化收益、总资产、可用资金、仓位占比、最大回撤、样本数、数据源和 warnings。
  - 新增历史持仓日期列表逻辑，并确保 `/positions/dates` 路由先于 `/positions/{yyyymmdd}` 注册。
  - 为 vnpy client 增加 best-effort 的远端历史持仓日期方法，老节点不支持时降级到本地快照。

- 前端：
  - 新增 `StrategyPerformanceSummaryCard`，放在收益曲线前。
  - 扩展 `liveTradingService` 与 `liveTrading.ts` 类型。
  - 改造 `HistoricalPositionsCard`：未传 `historyDates` 时自行查询日期；组件仍放在“策略监控”页签内。

## 验收标准

- 策略详情主 tab 的顺序为：指标总览 → 收益曲线 → 当前持仓 → TopK/成交/除权/参数等现有卡片；历史持仓只在“策略监控”页签展示。
- 空权益曲线、无可用资金、无 Beta、无历史日期时页面不报错，并以 `--` 或 warning 降级显示。
- `MlMonitorPanel` 内历史持仓继续可用。
- 后端测试覆盖指标计算、空曲线降级、历史日期路由与动态日期路由不冲突。
- 通过：
  - `python -m pytest tests/test_backend/test_live_trading.py -q`
  - `cmd /c npm run build`
