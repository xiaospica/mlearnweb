# 实盘交易页（/live-trading）重构方案

## Context

mlearnweb 实盘交易总览页 [LiveTradingPage.tsx](../../frontend/src/pages/live-trading/LiveTradingPage.tsx) 当前用 3 列栅格平铺所有策略卡片，跨节点混排，存在四个核心问题：

1. **观感差**：跨节点平铺 + 弱 mode 标识 + 状态点颜色与涨跌色冲突 + 缺少全局 KPI / 排序 / 搜索，长策略列表（>20）扫读困难。
2. **实盘/模拟徽章过弱**：当前仅 11px 描边小标签 + 4px leading 边框，远距不可读。
3. **节点维度缺失**：节点信息只活在 `geekblue` Tag 上，无法一眼数清"local 上几条实盘 / aliyun 上几条模拟 / 哪个节点出故障"。
4. **Cron 调度完全失声**：vnpy_ml_strategy 每个策略每日有 `trigger_time`（21:00 推理）和 `buy_sell_time`（09:26 T+1 下单）两个时点，`variables.last_run_date / last_status / last_duration_ms / last_error` 已记录上次执行情况，但前端列表 API 和 UI 都没暴露这些字段——这是 ML 实盘最关键的健康信号。

参考 vnpy_webtrader、vnpy_ml_strategy（路径 `F:\Quant\vnpy\vnpy_strategy_dev\vnpy_ml_strategy\template.py:122` 的 `trigger_time / buy_sell_time / signal_source_strategy` 字段；`engine.py` 的 `DailyTimeTaskScheduler`）。

**目标**：把页面从「跨节点策略列表」升级为「**节点驾驶舱 + 策略健康面板**」，让运维一眼看清每台节点的状态、所跑策略的 mode、上次调度的健康度。

**用户决策**（已确认）：
- 范围：**前后端一起改**
- Cron 可视化：**时间轴 strip**（卡片底部 28px 全宽水平时间轴）
- Mode 标识：**整卡 tinted bg + leading 6px 色条 + 大写 LIVE/SIM 徽章**（三层视觉编码叠加）

---

## 改造概览

### 1. 后端：StrategySummary / NodeStatus 字段扩展

**新增字段映射**（取自 vnpy 端已有数据，仅做透出与归一化，不需要 vnpy 改动）：

| 字段 | 源 | 类型 |
|---|---|---|
| `trigger_time` | `strategy.parameters.trigger_time` | `Optional[str]` 如 `"21:00"` |
| `buy_sell_time` | `strategy.parameters.buy_sell_time` | `Optional[str]` 如 `"09:26"` |
| `signal_source_strategy` | `strategy.parameters.signal_source_strategy` | `Optional[str]` |
| `last_run_date` | `strategy.variables.last_run_date` | `Optional[str]` `YYYY-MM-DD` |
| `last_status` | `strategy.variables.last_status` | `Literal["ok","failed","empty"] \| None` |
| `last_duration_ms` | `strategy.variables.last_duration_ms` | `Optional[int]` |
| `last_error` | `strategy.variables.last_error` | `Optional[str]` |
| `replay_status` | `strategy.variables.replay_status` | `Optional[str]`（默认 `"idle"` 归一为 None） |
| 节点 `mode` | `client.nodes[i].mode` | `Literal["live","sim","mixed"] \| None` |
| 节点 `latency_ms` | probe 时 `time.perf_counter()` | `Optional[int]` |
| 节点 `app_version` | vnpy `/api/v1/node/health` 响应 | `Optional[str]`（缺失给 None） |

**关键实现点**：
- 新增 [`_infer_strategy_schedule(s)`](../../backend/app/services/vnpy/live_trading_service.py)，在 `_infer_strategy_mode` 后调用，统一处理空串→None / 整数强转 / 枚举白名单，**任何字段失败统一退到 None，不抛异常**。
- 5 处 spread：`list_strategy_summaries` 主循环 + 历史曾在线分支、`get_strategy_detail`、`_list_offline_strategies_for_node`、`_offline_detail_from_history`。后两个 offline 路径从 `StrategyEquitySnapshot.raw_variables_json` 反序列化复原，**节点离线时仍能展示「上次成功运行 2026-05-03 ok 312ms」**。
- 不拆 `StrategySchedule` 子对象：响应膨胀 ~12-15KB / 50 策略可接受，前端解构更顺手。
- 不新增 `/grouped` 端点：前端 `Object.groupBy(summaries, s => s.node_id)` 即可。
- 不暴露节点级 cron jobs（如 TushareProApp 20:00 拉数）：vnpy_webtrader 当前未暴露 `apscheduler` 状态；本期只用策略级 `trigger_time / buy_sell_time` 满足覆盖率，节点级 cron 列入 future work。
- `replay_status="running"` 期间，前端展示策略状态以 replay_status 优先于陈旧的 last_status（前端逻辑，不污染后端）。

### 2. 前端：信息架构重构

**新页面骨架**：

```
PageContainer (header: 标题 + 刷新 / 新建 / 密度切换)
  ├─ GlobalKpiStrip (40px)        实盘N · 模拟N · 离线N · 调度异常N · 总权益
  ├─ FilterBar                    mode segmented · node 多选 · status 多选 · sort 下拉 · 搜索框
  ├─ NodeSection × N              按 node_id 分组（单节点时退化为平铺）
  │    ├─ NodeSectionHeader (sticky 56px)
  │    │      leading 8px online 色块 · node_id · base_url · mode · latency · 实盘N模拟M警告K · 折叠 / 在此节点新建
  │    └─ StrategyGrid            Row gutter=12, xs=24 md=12 xl=8 xxl=6
  └─ OfflineFooter                历史快照拼出的「已删 / 节点失联」策略，默认折叠
```

**分组方式选择**：按 `node_id`。理由：节点是运维边界（SSH 隧道、gateway 实例、断联恢复都按节点）；mode 已被卡片视觉编码，分组再按 mode 信息冗余。

**单节点退化**：`nodes.length === 1` 时自动隐藏 NodeSectionHeader，body 直接平铺，但保留新卡 + cron strip。

**状态分支**（顶层早返回）：
1. 加载 → Skeleton
2. 0 节点 → Empty + 跳 yaml 配置链接
3. 全部节点离线 → 红 banner + Sections 默认折叠 + 隐藏新建按钮
4. 单节点 offline → Section header 红条 + body 替换为「显示历史快照」+ 卡片置灰
5. 节点在线但 0 策略 → Section body 内联「在此节点新建策略」CTA

**偏好持久化分层**：
- `sessionStorage`: 节点折叠态（标签页关闭即清，避免第二天错过故障）
- `localStorage`: 密度模式 Comfort/Compact（跨会话稳定）
- url query string: filter / sort（可分享、可书签、可刷新保持）

### 3. StrategyCardV2（核心）

**整卡 320×196px Comfort 模式**：
- 圆角 8px，1px border
- **Leading 6px 色条**：颜色由 mode 决定（live=`--ap-danger` / sim=`--ap-success` / offline=`--ap-text-dim`），饱和度由 state 调（running=100% / inited=60% / 未 init=30% / offline=灰）
- **整卡 tinted bg**：`color-mix(in srgb, {modeColor} 4%, var(--ap-surface))`，dark theme 下 6%
- **大写 LIVE/SIM 徽章**：标题前 11px 700 filled 实色 bg=modeColor + 白字 + 2px 圆角，tooltip 显示 gateway_name
- **State pill 用形状编码**（不再单纯靠颜色）：● running / ◐ inited / ○ uninited / ⚠ offline，避免与 mode 红绿色冲突

**字段层级**（自上而下，padding 14px 16px 14px 18px）：

```
┌─ Title row (24px) ──────────────────────────────────┐
│ [LIVE] strategy_name           ●running             │  ← 大写徽章 + Link 标题 + 形状 state pill
├─ Meta row (16px) ───────────────────────────────────┤
│ ml_csi300 · 002594.SZSE        ↪ from parent_v2     │  ← class · vt_symbol · 双轨依赖 chip
├─ Equity block (40px) ───────────────────────────────┤
│ 策略PnL ⓘ                              +1.23%        │
│ 1,234,567.89                          7仓 · 12s     │  ← 22px tabular-nums + 涨跌色 + 持仓数 + fromNow
├─ MiniEquityChart (44px) ────────────────────────────┤
│   ┄┄┄┄┄┄┄ today open dashed baseline ┄┄┄┄┄┄┄         │  ← canvas + 0 基线 + 涨跌色填充
├─ Cron Schedule Strip (28px) ────────────────────────┤
│  09:26●━━━━━━━━━━━━━━━━21:00●━━━━━━┃              │  ← 时间轴 strip，下文详述
│  buy_sell✓                trigger✓  next: 12h 34m   │
├─ Action row (28px) ─────────────────────────────────┤
│  [init] [start] [stop] [delete]                     │
└─────────────────────────────────────────────────────┘
```

**Cron Schedule Strip 实现细节**（28px 全宽 horizontal track，0:00→24:00 横向比例）：
- 1px 灰 baseline 居中
- `trigger_time` 标记：6px 蓝实心圆 + 上方 9px `21:00` + 下方 9px 状态点（绿=ok / 红=failed / 黄=empty / 灰=未跑）
- `buy_sell_time` 标记：6px 紫实心圆 + 上方 9px `09:26`
- **当前时间**：1px 红色 vertical line，前端每 30s 重算位置（dayjs `now.hour()*60+now.minute()` → 百分比）
- **下一次执行倒计时**：右下 9px `next: 12h 34m`，前端 setInterval(1000)
- `last_status='failed'` → 整 strip 浅红 bg + 右侧 ⚠ icon hover 显示 `last_error` 完整堆栈
- `last_run_date !== today` 且当前已过 `trigger_time + 30min` → 状态点闪烁红 dot
- 影子策略（`signal_source_strategy != null`）trigger 圆点改空心，文字 `↪ reuse`

**双轨链接（signal_source_strategy）**：
- 影子策略 meta row 右侧 `↪ from {parent}` 11px chip
- 点击 → 滚动并 highlight 上游卡片，CSS `@keyframes ring-pulse` 闪 2s
- 上游策略卡片右上角 `🔗 N` badge 表示有 N 个下游影子，hover 列出
- `downstream_count` 由前端反向扫描计算（`useMemo` 在 strategies 变化时重算）

**Compact 密度模式**（行式 64px，无 chart 无 cron strip）：策略数 > 20 时自动启用。保留：mode 徽章 / strategy_name / state / equity / last_status icon / 操作按钮。

### 4. 性能与渲染优化

- **单一 nowMs Context**：替代 30 个独立 setInterval，提升到顶层 1 个 timer + Context 广播 `nowMs`，子组件用 `useContextSelector` 仅订阅自己关心的分钟粒度
- **StrategyCardV2 加 React.memo**：自定义比较仅看 `last_update_ts / strategy_value / running / last_status`
- **MiniEquityChart 用 canvas**（已是 lightweight-charts，沿用）
- **节点全离线时暂停 strategiesQuery 轮询**：`enabled: !allOffline`，复用已有信号
- **5s 轮询不变**，列表接口字段膨胀 ~3.6KB / 30 策略可忽略

---

## Critical Files

### 新增（前端）

- [components/NodeSection.tsx](../../frontend/src/pages/live-trading/components/NodeSection.tsx) — 节点分组容器，sticky header + 折叠 + 密度感知。props: `node, strategies, density, collapsed, onToggle`
- [components/NodeSectionHeader.tsx](../../frontend/src/pages/live-trading/components/NodeSectionHeader.tsx) — 56px header，base_url / mode / latency / chip 计数 / 节点级动作
- [components/StrategyCardV2.tsx](../../frontend/src/pages/live-trading/components/StrategyCardV2.tsx) — 取代现有 inline `StrategyCard`，支持 density prop
- [components/StrategyCardCompact.tsx](../../frontend/src/pages/live-trading/components/StrategyCardCompact.tsx) — 64px 行式视图
- [components/CronScheduleStrip.tsx](../../frontend/src/pages/live-trading/components/CronScheduleStrip.tsx) — 28px 时间轴 strip，核心新组件
- [components/GlobalKpiStrip.tsx](../../frontend/src/pages/live-trading/components/GlobalKpiStrip.tsx) — 顶部 40px KPI 横条
- [components/FilterBar.tsx](../../frontend/src/pages/live-trading/components/FilterBar.tsx) — mode + node + status + sort + search
- [hooks/useNowMs.ts](../../frontend/src/pages/live-trading/hooks/useNowMs.ts) — 顶层单一 timer + Context 广播 `nowMs`
- [hooks/useNextRunCountdown.ts](../../frontend/src/pages/live-trading/hooks/useNextRunCountdown.ts) — 倒计时 hook（消费 useNowMs）
- [hooks/useStrategyFilters.ts](../../frontend/src/pages/live-trading/hooks/useStrategyFilters.ts) — filter state ↔ url query（`useSearchParams`）
- [hooks/useDensity.ts](../../frontend/src/pages/live-trading/hooks/useDensity.ts) — localStorage 密度偏好
- [hooks/useNodeCollapse.ts](../../frontend/src/pages/live-trading/hooks/useNodeCollapse.ts) — sessionStorage 折叠状态
- [utils/groupByNode.ts](../../frontend/src/pages/live-trading/utils/groupByNode.ts) — 分组 + 节点级聚合（liveCount / simCount / failedCount）
- [utils/scheduleParse.ts](../../frontend/src/pages/live-trading/utils/scheduleParse.ts) — `trigger_time/buy_sell_time` 字符串 → dayjs，含跨日逻辑

### 修改

- [pages/live-trading/LiveTradingPage.tsx](../../frontend/src/pages/live-trading/LiveTradingPage.tsx) — 删除 inline StrategyCard，改成 `nodes.map(node => <NodeSection ...>)`。state 接入 useStrategyFilters / useDensity。删 Segmented，引入 FilterBar。包一层 `<NowMsContext.Provider>`
- [types/liveTrading.ts](../../frontend/src/types/liveTrading.ts) — `StrategySummary` 加 8 个 optional 调度字段；`StrategyMode` 改为 `'live' | 'sim' | 'mixed'`；`NodeStatus` 加 `mode` / `latency_ms` / `app_version`；新增 `LastStatus` literal
- [pages/live-trading/components/NodeStatusBar.tsx](../../frontend/src/pages/live-trading/components/NodeStatusBar.tsx) — 标记 deprecated（被 NodeSectionHeader + GlobalKpiStrip 替代），保留代码不删，下个 sprint 清理

### 新增/修改（后端）

- [backend/app/services/vnpy/live_trading_service.py](../../backend/app/services/vnpy/live_trading_service.py) — 新增 `_infer_strategy_schedule(s)`；5 处 spread（list 主循环 + 历史曾在线分支 + get_strategy_detail + 两个 offline helper）；后两处加 `json.loads(last.raw_variables_json or "{}")` 复原
- [backend/app/services/vnpy/client.py](../../backend/app/services/vnpy/client.py) — `probe_nodes()` 用 `time.perf_counter()` 包 `get_node_health()` 测 latency，附 `mode`/`latency_ms`/`app_version`
- [backend/app/services/vnpy/registry.py](../../backend/app/services/vnpy/registry.py) — `validate_node_mode` 白名单加 `"mixed"`（如尚未支持）
- [backend/app/schemas/schemas.py](../../backend/app/schemas/schemas.py) — `StrategySummary` 加 8 个 optional 字段；`NodeStatus` 加 `mode`/`latency_ms`/`app_version`；`StrategyDetail` 因继承自动获得新字段

### 测试

- [tests/test_backend/test_live_trading.py](../../tests/test_backend/test_live_trading.py) — `FakeVnpyClient.strategies_fanout` 一个策略加全调度字段、另一个保持空作为非 ML 策略降级用例；`probe_nodes` fake 加 `mode/latency_ms/app_version`
- 新增用例：(1) 非 ML 策略 summary 8 字段全 None；(2) `last_status="weird"` 归一为 None；(3) `last_status="OK"` 大写归一为 None；(4) `last_duration_ms="1234"` 字符串强转为 int；(5) 离线 fallback 从 `raw_variables_json` 复原 `last_run_date`；(6) `replay_status="idle"` 归一为 None

---

## 风险与权衡

1. **A 股红涨绿跌 vs 实盘 tint 红色冲突**：实盘 tinted bg 是 4% alpha 浅粉，与权益数值的纯红 `--ap-market-up` 饱和度差 20×，区分度足够。**先按红/绿上线**，看用户反馈再决定是否改琥珀/青中性配色。

2. **老版本 vnpy 字段缺失**：CTA / SignalStrategyPlus 等非 ML 策略 `parameters` 没有 `trigger_time`，新字段全 None。`<CronScheduleStrip>` 在 `trigger_time === null` 时**整条不渲染**（保留 28px 占位防止卡片高度跳动）；有 trigger 但无 `last_run_date` 时显示空心圆 + "未运行"灰字。

3. **`replay_status="running"` 期间字段不一致**：vnpy template.py 在 pipeline 入口先重置 `last_error=""` 不重置 `last_status`。前端展示如果 `replay_status === "running"`，**优先渲染"运行中"chip 而非 last_status 旧值**，逻辑写在 `<CronScheduleStrip>` 内。

4. **节点 mixed 模式**：`NodeConfig.mode` 当前 `validate_node_mode` 只认 live/sim。registry 加 "mixed" 白名单。`_infer_strategy_mode` 已按 gateway 前缀强制覆盖（QMT_SIM* → sim / QMT → live），mixed 节点的策略仍正确分类。

5. **probe latency 抖动**：health 端点偶发慢响应（>1s）会让节点显示性能差。本期不做 EMA 平滑，前端展示 raw latency；后续如需稳定可在 client 端 ringbuffer 算 `EMA(alpha=0.3)`。

6. **30 个倒计时 timer 性能**：用顶层 `useNowMs` Context 广播替代每卡 setInterval，30 timers → 1 timer。

7. **不留兼容层**：`NodeStatusBar` 标记 deprecated 但保留代码、下 sprint 清理；不写 `node.mode ?? 'sim'` 之类兜底——后端契约一旦改完，前端类型直接用新签名。

---

## 验证

### 后端单测
```powershell
cd mlearnweb; python -m pytest tests/test_backend/test_live_trading.py -v
```
覆盖：6 个新调度字段归一化用例 + 离线 raw_variables_json 复原 + probe latency。

### 后端冒烟（双进程都要起）
```powershell
cd mlearnweb/backend
python -m uvicorn app.live_main:app --port 8100 --reload
# curl 验证字段已出现在响应中：
curl http://127.0.0.1:8100/api/live-trading/strategies | python -m json.tool | findstr "trigger_time last_status latency_ms"
curl http://127.0.0.1:8100/api/live-trading/nodes      | python -m json.tool | findstr "mode latency_ms"
```
要求：ML 策略含全部 8 个字段；非 ML 策略全 None；节点响应含 mode/latency。

### 前端类型检查 + dev 启动
```powershell
cd mlearnweb/frontend; npm run build  # 含 tsc -b，类型不通过会失败
cd mlearnweb/frontend; npm run dev     # 浏览器开 http://localhost:5173/live-trading
```

### 端到端浏览器自测（CLAUDE.md 强制）
golden path：
1. 多节点（local + 至少 1 远端）+ 多策略（实盘 1 + 模拟 2）+ 至少 1 个非 ML 策略 + 1 对双轨（上游 + 影子）
2. 节点分组渲染正确，单节点时退化为平铺
3. LIVE / SIM 徽章三米可见，整卡 tint 与 leading 色条到位
4. CronScheduleStrip：`now` red line 位置每 30s 移动；trigger / buy_sell 圆点 + 状态色正确；倒计时每秒减少
5. 影子策略点击 `↪ from parent` 滚动并闪烁上游卡片
6. mock 一次 `last_status="failed"`：strip 整条浅红 + ⚠ icon hover 显示 last_error
7. 节点 offline：Section header 红条 + body 灰显历史
8. filter / sort 切换 → url query 同步；刷新页面状态保留
9. 折叠态 sessionStorage、密度 localStorage 验证
10. 30+ 策略性能：DevTools Performance 录 5s，Long Task 应 < 50ms

regressions：
- `/live-trading/:nodeId/:engine/:name` 详情页不变，进出双向通畅
- `useOpsPassword` 写操作仍正常（init/start/stop/delete）
- 新建策略 wizard 入口仍可触达
