# mlearnweb 独立部署路线图

把"mlearnweb 解耦 vnpy 推理侧文件依赖" + "Windows Server 快速部署"两件事合并成一条端到端路线，按依赖排序。

## 当前进度（2026-05-10 架构复核后状态）— 可试部署，正式一键部署未就绪 ⚠️

**结论**：mlearnweb 已具备独立部署骨架（双 uvicorn、单端口前端挂载、live API 反代、NSSM 服务化、一站式脚本雏形），但还不建议作为正式的一键快速部署版本交付。当前适合做服务器试部署，用来暴露环境问题；正式上线前必须先完成下方 P0/P1 backlog。

**状态口径**：
- Phase 1-3 的核心解耦方向基本成立：vnpy 实盘侧主链路已转为 HTTP fanout，不再 import vnpy 模块。
- Phase 4 已完成部署脚手架，但仍需要生产化补强：依赖、配置落点、监听策略、测试状态、Workbench/训练侧解耦还未达到干净服务器一键交付标准。
- 只有 P0 全部完成后，才允许标记为“可正式部署”；P1 全部完成后，才允许标记为“具备一键快速部署能力”。

```mermaid
flowchart LR
    classDef done fill:#22c55e,color:#fff
    classDef warn fill:#f59e0b,color:#111
    classDef block fill:#ef4444,color:#fff

    P1[Phase 1<br/>vnpy IC 闭环<br/>✓ bc28425]:::done
    P2[Phase 2<br/>mlearnweb 删 IC 计算<br/>✓ 1207ea8]:::done
    P31[Phase 3.1<br/>stock_names HTTP<br/>✓ 30a4897 + ad3ac26]:::done
    HF1[Hotfix httpx trust_env<br/>✓ fddb4d7]:::done
    HF2[Hotfix 历史持仓 RPC<br/>✓ afc3152]:::done
    HF3[Hotfix 时间窗口/股票名/TopK<br/>✓ vnpy 9837005+088ac54+cb79540<br/>✓ mlearnweb 2dda7b7+02043dc+43d10ca+7a24699+2914ef6]:::done
    P32[Phase 3.2<br/>predictions HTTP<br/>✓ vnpy 088ac54 + mlearnweb 43d10ca]:::done
    P33[Phase 3.3<br/>corp_actions HTTP<br/>✓ vnpy cb79540 + mlearnweb 7a24699]:::done
    P34[Phase 3.4<br/>sim db fallback 简化<br/>✓ mlearnweb 2914ef6]:::done
    P35[Phase 3.5<br/>config 字段清理<br/>✓ mlearnweb 2914ef6]:::done
    P4[Phase 4<br/>Windows 快速部署骨架<br/>✓ mlearnweb 70eb595<br/>需生产化补强]:::warn
    P0[P0 发布阻断<br/>依赖/配置/监听/测试]:::block
    P1B[P1 正式部署必需<br/>配置收敛/训练侧解耦]:::warn

    P1 --> P2 --> P31 --> HF1 --> HF2 --> HF3 --> P32 --> P33 --> P34 --> P35 --> P4 --> P0 --> P1B
```

### 已完成历史进展（保留记录）

下面是 2026-05-06 前后的阶段性完成记录，说明解耦和部署脚手架已经有基础；但 2026-05-10 架构复核发现，Phase 4 还不能等同于“生产一键部署已就绪”。

| Phase | Commit | 改动总结 | 验证 |
|---|---|---|---|
| **Phase 1** | vnpy `bc28425` | IcBackfillService on_complete 回调 reload metrics.json 到 MetricsCache + ic_forward_window 从 bundle/task.json 自动解析 + 38 单测 | `/api/v1/ml/strategies/.../metrics?days=30` 返回的 ic / rank_ic 字段非 null（实测 -0.13 ~ 0.07） |
| **Phase 2** | mlearnweb `1207ea8` | 删 ml_metrics_backfill_service.py 整文件 + 删 backfill_ml_metrics_ic.py 脚本 + 升级 historical_metrics_sync 同步全字段 + INSERT-IF-MISSING + 13 新单测 | `/metrics/history` 返回 18 天完整 IC 时序 |
| **Phase 3.1** | vnpy `30a4897` + mlearnweb `ad3ac26` | vnpy 加 `/api/v1/reference/stock_names` + mlearnweb stock_name_cache 后台 1h 协程 + 6 新单测 | 持仓中文简称正常显示（青岛港 / 中国海油 / 新和成 等 codepoints 正确） |
| **Hotfix httpx** | mlearnweb `fddb4d7` | client.py `trust_env=False` 避免开发机 http_proxy 拦截 vnpy 节点请求 | 本机有 `http_proxy=127.0.0.1:7890` 时 mlearnweb 直连 8001 不走代理，local 节点 online ✓ |
| **Hotfix 历史持仓** | mlearnweb `afc3152` | get_strategy_positions_on_date_via_rpc 逻辑倒置修复（之前永远走 fallback）+ test_stock_name_cache patch 路径修正 | `/positions/{yyyymmdd}` 返 7 行持仓 + 中文简称（杭州银行 / 南山铝业 等），不再误报"DAILY_MERGED_ALL_PATH 未配置" |

mlearnweb backend 测试套历史记录：**160 全过**（128 原有 + 13 新增 historical_metrics_sync + 6 stock_name_cache + 13 其他）。2026-05-10 复核时重新执行 `tests/test_backend`，剥离本机临时目录权限噪音后仍有 **8 个真实失败**，需要纳入 P0 修复。

vnpy_ml_strategy 测试套：107 / 7 — 7 个 fail 是预存 bug（git stash 验证过），与本次工作无关。Phase 1 新增 38 测全过。

## 优先级定义与整改 Backlog

| 优先级 | 定义 | 出口标准 |
|---|---|---|
| **P0 发布阻断** | 干净服务器无法稳定安装、启动、访问，或测试不绿的问题 | 全部关闭后，才能标记“可正式部署” |
| **P1 正式部署必需** | 影响一键体验、配置收敛、跨仓库解耦完整性的核心问题 | 全部关闭后，才能标记“具备一键快速部署能力” |
| **P2 稳定性/运维增强** | 健康检查、日志、备份、升级、安全提示等运维可观测能力 | 不阻断首轮正式部署，但应进入发布后第一批增强 |
| **P3 后续优化** | 性能、体验、文档美化、代码拆分等非阻断项 | 按实际使用反馈排期 |

### P0 — 发布阻断

| ID | 问题 | 影响 | 验收 |
|---|---|---|---|
| **P0-1** | 补齐 Python 依赖：`matplotlib`、`psutil`、`qlib_strategy_core`、`pyarrow`、`optuna` 等按实际 import / 功能边界进入 `requirements.txt` 或可选 extras；`install_all.ps1` 必须安装 `vendor/qlib_strategy_core` | 干净 venv 可能无法 import `app.main` / `app.live_main`，服务启动失败 | 干净 venv 执行 `python -c "from app.main import app; from app.live_main import app"` 通过 |
| **P0-2** | 修复一键部署配置落点：`.env`、SQLite、uploads、logs 全部收敛到 `DataRoot` 或明确绝对路径；脚本自动写入 `DATABASE_URL`、`FRONTEND_DIST_DIR`、`VNPY_NODES_CONFIG_PATH` | 当前脚本仍需要人工编辑关键字段，且 DB 默认仍可能落在仓库目录 | `install_all.ps1 -DataRoot D:\mlearnweb_data` 后无需手改即可启动并通过 `/health` |
| **P0-3** | 修正服务监听策略：`mlearnweb_research` 生产默认可被内网访问，`mlearnweb_live` 继续仅本机访问；文档与脚本保持一致 | 文档写 `http://<server-ip>:8000/`，但服务绑定 `127.0.0.1` 时远程不可访问 | 内网机器可访问 `http://<server-ip>:8000/`，8100 不对外暴露 |
| **P0-4** | 后端测试恢复全绿：修复 `corp_actions` 测试契约与 `replay_equity_sync` 的 `engine` 参数不一致 | 测试不绿，无法判断部署补强是否引入回归 | `python -m pytest mlearnweb/tests/test_backend -q` 全绿 |

### P1 — 正式部署必需

| ID | 问题 | 影响 | 验收 |
|---|---|---|---|
| **P1-1** | Workbench/调参功能配置化：未配置 `STRATEGY_DEV_ROOT` 时禁用调参入口，不影响 dashboard / live-trading 启动 | 当前调参路径默认依赖开发机 `F:\Quant\code\qlib_strategy_dev` 与特定 Python | 未配置训练侧路径时，研究展示和实盘监控仍可用，Workbench 显示明确禁用提示 |
| **P1-2** | 清理前端默认训练配置里的 `F:\Quant...` 硬编码，改为后端配置模板或明确“仅开发默认” | 一键部署后用户可能误以为 Workbench 可直接训练，实际会指向不存在路径 | 生产构建中不再把开发机绝对路径作为默认可执行配置 |
| **P1-3** | 明确研究侧依赖：`MLRUNS_DIR` 是外部只读挂载；未配置时研究页降级显示，不阻断 live-trading | 研究侧和实盘侧部署耦合，mlruns 缺失可能造成误判 | `MLRUNS_DIR` 不存在时，live-trading 正常启动，研究页展示可操作的配置提示 |

### P2 — 稳定性/运维增强

| ID | 问题 | 影响 | 验收 |
|---|---|---|---|
| **P2-1** | 升级 `/health` 为部署自检：返回 frontend mount、DB 可写、vnpy nodes yaml、mlruns 可读、live proxy 状态 | 当前 `/health` 只能证明进程活着，不能证明部署可用 | `/health` 能定位常见配置错误，并保持机器可读 JSON |
| **P2-2** | 增加部署 smoke test：干净 venv import `app.main/app.live_main`、构建前端、校验 `/health` | 缺少可重复的发布前验证入口 | CI/本地均可运行 smoke test，覆盖一键部署关键路径 |

### P3 — 后续优化

- 前端大 chunk 拆分，降低生产首屏包体和构建警告。
- 文档 mermaid / 排错细化，补充 HTTPS/Caddy/autossh 独立专题。
- 按实际运维反馈补充备份、升级、日志轮转和告警 playbook。

## Context

**目标**：mlearnweb 能作为**独立项目**部署到一台干净 Windows Server 2022 上，30 分钟内跑通；运行期不直读 vnpy 推理机的任何文件，所有数据走 HTTP（vnpy_webtrader 端点）。

**现实约束**：mlearnweb / vnpy 推理 / 训练是三个职能，可能在三台不同机器上：
- 训练机（研究侧）：跑 mlflow 实验、训练后产 bundle
- vnpy 推理机：拉 bundle 实盘运行、写 metrics.json + predictions.parquet 到本地磁盘
- 监控机（mlearnweb）：HTTP 拉 vnpy webtrader 数据 + 文件挂载 mlruns 用于研究侧 UI

**2026-05-10 复核后的剩余阻塞**：下表保留早期阻塞项与当前优先级的对应关系，具体整改以“优先级定义与整改 Backlog”为准。

| # | 问题 | 影响 | 当前归类 |
|---|---|---|---|
| ~~A~~ | ~~`_trigger_ic_backfill` 没传 on_complete~~ | ~~IC 写盘后 cache 不刷~~ | ✅ Phase 1 修复 |
| ~~B~~ | ~~`forward_window` 默认 2 写死~~ | ~~跨策略 IC 全错~~ | ✅ Phase 1 修复 |
| ~~C~~ | ~~mlearnweb 自算 IC~~ | ~~误工~~ | ✅ Phase 2 修复 |
| **D** | 少量同机 fallback / 历史工具仍带本机路径语义，需要明确“可选优化”或禁用 | 跨机部署语义容易误读 | P1 / P2 |
| **E** | 部署脚本已有骨架，但依赖、配置落点、监听策略仍未生产化 | 干净 Windows Server 可能无法稳定安装或远程访问 | P0 |
| **F** | `install_all.ps1` 已存在，但还不是无需手工编辑的真一键 | 30 分钟快速部署目标不可验收 | P0 |
| **G** | 单端口生产入口已有，但脚本与手册对可访问地址的口径不一致 | 运维起完服务后可能打不开 UI | P0 |
| **H** | README / 部署文档已有，但需同步反映“试部署 vs 正式部署”状态 | 项目第一印象与真实就绪度不一致 | P2 / P3 |

---

## Phase 1 — vnpy 端补全 IC 反馈链路 + forward_window 自动解析

### 改动 V1.1: IcBackfillService 跑完后刷新 MetricsCache

**文件**：[F:/Quant/vnpy/vnpy_strategy_dev/vnpy_ml_strategy/engine.py](../../../../vnpy/vnpy_strategy_dev/vnpy_ml_strategy/engine.py)

`_trigger_ic_backfill` 创建 IcBackfillService 时传 `on_complete` 回调：

```python
def _trigger_ic_backfill(self, strategy_name: str, output_root: str) -> None:
    ...
    if svc is None:
        svc = IcBackfillService(
            strategy_name=strategy_name,
            output_root=output_root,
            ...
            on_complete=lambda result: self._reload_metrics_after_ic_backfill(
                strategy_name, output_root, result
            ),
        )
        ...

def _reload_metrics_after_ic_backfill(
    self,
    strategy_name: str,
    output_root: str,
    result: IcBackfillResult,
) -> None:
    """run_ic_backfill 子进程改完磁盘 metrics.json 后, 把最近 max_history 天
    的 metrics.json 重新加载到 MetricsCache, 让 webtrader 读到新的 IC."""
    if not result.success or result.computed == 0:
        return
    try:
        from .monitoring.cache_loader import reload_history_from_disk
        reload_history_from_disk(
            self._metrics_cache,
            strategy_name=strategy_name,
            output_root=output_root,
            max_days=self._metrics_cache._max_history,
        )
        logger.info(
            "[ic_backfill][%s] reloaded %d days metrics from disk into cache",
            strategy_name, result.computed,
        )
    except Exception as exc:
        logger.warning(
            "[ic_backfill][%s] reload cache failed: %s", strategy_name, exc,
        )
```

`run_ic_backfill_now()` 同款处理。

### 改动 V1.2: 新增 cache_loader 工具

**新增**：`vnpy_ml_strategy/monitoring/cache_loader.py`

```python
"""扫 output_root/{strategy}/{day}/metrics.json 把历史指标加载回 MetricsCache.
给 IcBackfillService.on_complete 用 — 子进程改完磁盘后通知主进程重新读盘."""
def reload_history_from_disk(
    cache: MetricsCache,
    *,
    strategy_name: str,
    output_root: str,
    max_days: int = 30,
) -> int:
    """返回成功加载的 metrics.json 文件数. 错误的文件 skip + log warn."""
```

按日期降序扫最近 `max_days` 个目录，read JSON，调 `cache.update`。

### 改动 V1.3: `IcBackfillService.forward_window` 自动从 bundle/task.json 解析

**文件**：[F:/Quant/vnpy/vnpy_strategy_dev/vnpy_ml_strategy/template.py](../../../../vnpy/vnpy_strategy_dev/vnpy_ml_strategy/template.py)

加一个属性：

```python
@property
def ic_forward_window(self) -> int:
    """从 bundle/task.json 的 dataset.label[0] 表达式解析 forward window.

    样例 label "Ref($close, -11) / Ref($close, -1) - 1" → 11
          "Ref($close, -2) / Ref($close, -1) - 1"  → 2 (Alpha158 默认)
    解析失败 raise — 不沉默用错误默认值算出错误 IC.
    """
    if self._cached_ic_forward_window is not None:
        return self._cached_ic_forward_window
    task_path = Path(self.bundle_dir) / "task.json"
    task_json = json.loads(task_path.read_text(encoding="utf-8"))
    label_expr = task_json["dataset"]["kwargs"]["handler"]["kwargs"]["label"][0]
    match = re.match(
        r"^\s*Ref\(\$close,\s*-(\d+)\)\s*/\s*Ref\(\$close,\s*-1\)\s*-\s*1\s*$",
        label_expr,
    )
    if not match:
        raise ValueError(
            f"label 表达式不匹配 N 日 forward return 模板: {label_expr!r}"
        )
    self._cached_ic_forward_window = int(match.group(1))
    return self._cached_ic_forward_window
```

[engine.py:683](../../../../vnpy/vnpy_strategy_dev/vnpy_ml_strategy/engine.py#L683) 改为：

```python
forward_window = strat.ic_forward_window  # 让属性 raise, 不沉默用 2
```

如果策略没正确配置 bundle，这里会 raise，外层 `_trigger_ic_backfill` 包 try/except + log error，不阻塞主流程（但能在日志里看见 stack trace）。

### 改动 V1.4: 单测

**新增**：
- `vnpy_ml_strategy/test/test_cache_loader.py`：mock 磁盘文件，验证 reload 后 cache 含正确的 metrics
- `vnpy_ml_strategy/test/test_template_ic_forward_window.py`：覆盖 11/2/20/失败 label

**修改**：现有 `test_ic_backfill.py`（如有）加 on_complete 回调验证用例

### 工时
| 任务 | 工时 |
|---|---|
| V1.1 + V1.2 | 2h |
| V1.3 | 1h |
| V1.4 单测 | 2h |
| 端到端跑 `run_ml_headless.py` 验证（含人工 wait forward window）| 1h |
| **Phase 1 小计** | **6h** |

---

## Phase 2 — mlearnweb 删 IC 计算逻辑

Phase 1 完成后 vnpy 端能保证 metrics 含正确 IC，mlearnweb 改为纯拉取。

### 改动 M2.1: 删 `_FORWARD_DAYS` + `_load_close_lookup` + IC corr

**文件**：[backend/app/services/vnpy/ml_metrics_backfill_service.py](../../backend/app/services/vnpy/ml_metrics_backfill_service.py)

- 删 [L41](../../backend/app/services/vnpy/ml_metrics_backfill_service.py#L41) `_FORWARD_DAYS = 11`
- 删 [L84-100](../../backend/app/services/vnpy/ml_metrics_backfill_service.py#L84) `_load_close_lookup()`
- 删 [L68-81](../../backend/app/services/vnpy/ml_metrics_backfill_service.py#L68) `_next_trade_day()`
- 删 IC corr 计算段（搜索 `pearson` / `spearman` 调用点）

### 改动 M2.2: 简化 backfill 为纯 HTTP 拉取

`backfill_metrics_for_strategy()` / `backfill_all_strategies()` 内部改为：
- `client.get_ml_metrics_history(strategy_name, days=N)` 走 HTTP
- UPSERT 到 `ml_metric_snapshots`
- 保留 `_set_if_not_none` 语义（vnpy 端没填的 IC=null 不覆盖前次真值）

顶部 docstring 重写，反映新职责（mlearnweb 仅负责拉 + 跨天聚合）。

### 改动 M2.3: 删 `scripts/backfill_ml_metrics_ic.py`

整个文件删除（早期一次性脚本，跟 service 同款设计错误）。

### 改动 M2.4: 测试

**新增**：[tests/test_backend/test_ml_metrics_pull.py](../../tests/test_backend/test_ml_metrics_pull.py) — mock VnpyMultiNodeClient.get_ml_metrics_history 返回含 IC 的 metrics 列表，端到端验证 UPSERT。

**删除**：现有测试中涉及 `_load_close_lookup` / `_FORWARD_DAYS` 的用例（grep 确认）。

### 工时
| 任务 | 工时 |
|---|---|
| M2.1-M2.3 删代码 + 改 service | 1.5h |
| M2.4 测试 | 1h |
| **Phase 2 小计** | **2.5h** |

---

## Phase 3 — mlearnweb 解耦其他 D:\ 文件依赖

### 改动 M3.1: stock_names 走 HTTP

**vnpy 端**：新增 `vnpy_webtrader/routes_reference.py` 暴露 `GET /api/v1/reference/stock_names` 全量返回（~5000 行 ~500KB，gzip）；vnpy 端已有 `stock_name_lookup.py` 现成 lookup，包一层 endpoint 即可。

**mlearnweb 端**：[ml_aggregation_service.py:286-309](../../backend/app/services/ml_aggregation_service.py#L286) `_resolve_stock_list_path()` 改为 `_fetch_stock_names_via_http()`：1h 内存缓存，HTTP 失败时返回空 dict（前端 fallback 显示 ts_code）。

### 改动 M3.2: predictions/{yyyymmdd} HTTP 化

**vnpy 端**：实现 [`routes_ml.py:60`](../../../../vnpy/vnpy_strategy_dev/vnpy_webtrader/routes_ml.py#L60) Phase 2.7 — 当前返回 501，要落地实现：从 `output_root/{name}/{yyyymmdd}/predictions.parquet` 读 + 转 JSON。新增 `GET /api/v1/ml/strategies/{name}/prediction/dates` 列出可用日期。

**mlearnweb 端**：[ml_aggregation_service.py:380-439](../../backend/app/services/ml_aggregation_service.py#L380) `get_all_predictions_by_date()` 改为 fanout HTTP；删 `D:\ml_output` 扫盘逻辑。

### 改动 M3.3: corp_actions HTTP 化

**vnpy 端**：新增 `vnpy_webtrader` 端点 `GET /api/v1/market/corp_actions?since=&vt_symbols=` — 在 vnpy 推理机本地读 daily_merged 检测除权事件，返回列表。

**mlearnweb 端**：[corp_actions_service.py](../../backend/app/services/corp_actions_service.py) 整体改为 HTTP 客户端 + 跨日聚合展示。

### 改动 M3.4: sim db fallback 简化

[historical_positions_service.py](../../backend/app/services/vnpy/historical_positions_service.py) fallback 路径删 `daily_merged_all_path` 在 fallback 用法，改用最后 trade price 近似（精度 ±1-3%；HTTP 主路径不受影响，仍精确）。

### 改动 M3.5: config.py 字段清理

**文件**：[backend/app/core/config.py](../../backend/app/core/config.py)

- 🗑️ 删 `daily_merged_root`（M3.3 后无人读）
- 🗑️ 删 `daily_merged_all_path`（M3.4 后无人读）
- 🔶 `vnpy_sim_db_root` 改 `Optional[str] = None`（仅同机部署快路径）
- 🔶 `ml_live_output_root` 改 `Optional[str] = None`（M3.2 后变可选）

`.env.example` 同步清理 + 注释说明"如同机部署可选优化"。

### 工时

| 任务 | vnpy 端 | mlearnweb 端 |
|---|---|---|
| M3.1 stock_names | 1.5h | 1h |
| M3.2 predictions | 4h | 2h |
| M3.3 corp_actions | 2h | 1.5h |
| M3.4 sim db fallback | - | 1h |
| M3.5 config 清理 + .env | - | 0.5h |
| 单测 | 1.5h | 2h |
| **Phase 3 小计** | **9h** | **8h** |

---

## Phase 4 — Windows 快速部署 L1

Phase 1+2+3 完成后，mlearnweb 不读任何 vnpy 文件路径，可作为独立项目部署。

### 改动 W4.1: `app.main` 挂前端 + 内部反代到 :8100

**文件**：[backend/app/main.py](../../backend/app/main.py)、[backend/app/core/config.py](../../backend/app/core/config.py)、`backend/app/routers/_live_proxy.py`（新）

- `Settings` 加 `frontend_dist_dir: Optional[str] = None`，env `FRONTEND_DIST_DIR` 覆盖
- `app.main` 末尾按需挂 `StaticFiles(directory=frontend_dist_dir, html=True)` 提供 SPA fallback
- 新增 `/api/live-trading/*` 反代路由（httpx.AsyncClient stream 透传到 :8100），让浏览器只认 :8000 单端口
- mount 顺序：API 路由 → 反代路由 → StaticFiles

### 改动 W4.2: `/health` 升级展示功能可用性

```python
@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "frontend_mounted": ...,
        "features": {
            "core": True,
            "ml_monitoring": <vnpy 节点可达 + IC 数据非空率 > 0>,
            "joinquant_export": Path(settings.joinquant_export_dir).exists(),
            "historical_positions": <HTTP 主路径可达>,
        },
    }
```

### 改动 W4.3: `install_services.ps1` 完全去硬编码

**文件**：[deploy/install_services.ps1](../../deploy/install_services.ps1)

- 默认 `MLearnwebRoot` 用 `(Resolve-Path "$PSScriptRoot\..").Path`
- `PythonExe` 默认 `$null`，自动 `(Get-Command python).Source`
- `LogRoot` 改强制参数（无默认值）

### 改动 W4.4: 新增 `install_all.ps1` 一站式脚本

**新增**：[deploy/install_all.ps1](../../deploy/install_all.ps1)

强制参数 `-DataRoot <path>`（运行时数据 + 配置 + 日志根，e.g. `D:\mlearnweb_data`）；可选 `-PipIndexUrl` / `-SkipFirewall` / `-SkipFrontend`。

11 步幂等：
1. 管理员权限 + PowerShell 5.1+ 检查
2. `Get-Command` 校验 Python 3.11 / Node 18+ / Git / NSSM
3. 创建 `$DataRoot\{config,logs,db}` 子目录
4. venv 创建（已存在跳过）
5. `pip install -r requirements.txt`
6. `npm install` + `npm run build`（dist/ 已新于 src/ 跳过）
7. 复制 `.env.example` → `$DataRoot\config\.env`（已存在跳过）
8. 调 `install_services.ps1 -PythonExe <venv python> -LogRoot $DataRoot\logs`
9. 防火墙规则（LocalSubnet 限定）
10. Defender 排除（关键 — SQLite WAL 性能）
11. 启动服务 + `Invoke-WebRequest /health` 输出 JSON

### 改动 W4.5: 新增 `uninstall_all.ps1`

含 `-Purge` 模式（删 $DataRoot 内容）；默认保留数据。

### 改动 W4.6: 新增 README + DEPLOYMENT_WINDOWS.md

**新增**：
- `mlearnweb/README.md` — 一句话定位 + mermaid 顶层架构图 + 快速开始两栏（开发 / 生产）+ docs 索引
- `mlearnweb/docs/DEPLOYMENT_WINDOWS.md` — Windows 专章（前置依赖 winget/choco 命令 + install_all.ps1 用法 + 排错 5 项）

### 改动 W4.7: ARCHITECTURE.md / DEPLOYMENT.md mermaid 化

- ARCHITECTURE.md 双进程 ASCII 框图 → mermaid `flowchart TB`
- DEPLOYMENT.md 拓扑 ASCII art → mermaid `flowchart`；升级流程 ASCII → `sequenceDiagram`
- 删除 [DEPLOYMENT.md:248](../DEPLOYMENT.md#L248) stale "deps.py SECRET_KEY" 段（已 grep 确认 backend 无 SECRET_KEY 引用）
- DEPLOYMENT.md 顶部加 banner 链接 DEPLOYMENT_WINDOWS.md

### 工时

| 任务 | 工时 |
|---|---|
| W4.1 StaticFiles + 反代 | 2h |
| W4.2 /health 升级 | 1h |
| W4.3 install_services 去硬编码 | 1h |
| W4.4 install_all.ps1 | 4h |
| W4.5 uninstall_all.ps1 | 1h |
| W4.6 README + DEPLOYMENT_WINDOWS | 3h |
| W4.7 ARCHITECTURE / DEPLOYMENT mermaid 化 | 2h |
| **Phase 4 小计** | **14h** |

---

## 总工时估算

| Phase | 工时 |
|---|---|
| Phase 1（vnpy 端 IC 闭环）| 6h |
| Phase 2（mlearnweb 删 IC）| 2.5h |
| Phase 3（其他 D:\ 解耦，双端）| 17h |
| Phase 4（Windows 快速部署）| 14h |
| **总计** | **~40h** |

---

## 落地顺序（关键路径）

```mermaid
flowchart LR
    P1[Phase 1<br/>vnpy IC 闭环] --> P2[Phase 2<br/>mlearnweb 删 IC]
    P2 --> P3[Phase 3<br/>其他 D:\ 解耦]
    P3 --> P4[Phase 4<br/>Windows 部署]

    P1 -.独立验证<br/>run_ml_headless.py.-> V1[端到端 IC 通]
    P2 -.独立验证<br/>vnpy 端正常 + mlearnweb 拉到 IC.-> V2[前端 IC 图非空]
    P3 -.独立验证<br/>干净机器无 D:\ 路径仍能跑.-> V3[跨机部署 OK]
    P4 -.独立验证<br/>install_all.ps1 一键.-> V4[30 分钟部署]
```

每个 Phase 独立可验证、独立可发布。**不要一次合 4 个 PR**——分批合并降低回归风险。

---

## 端到端验证

### Phase 1 完成验证
```powershell
# 在 vnpy 推理机
cd F:\Quant\vnpy\vnpy_strategy_dev
python run_ml_headless.py
# 等推理周期 + IcBackfillService debounce 60s
# 验证：
curl http://127.0.0.1:8001/api/v1/ml/strategies/csi300_v1_a/metrics?days=30 | python -m json.tool
# 期望：返回 metrics 列表，30 天前几日的 IC 字段非 null（已被 backfill 填回）
```

### Phase 2 完成验证
mlearnweb backend 重启后 `historical_metrics_sync_loop` 5 min 周期跑一次 → 浏览器开实盘策略详情 → 策略监控 Tab → IC 趋势图非空。

### Phase 3 完成验证
干净 Windows VM（无 `D:\vnpy_data\` 目录）+ `.env` 不配 `DAILY_MERGED_*` → mlearnweb 启动后所有功能正常（IC 图 + 历史持仓 + corp_actions 全 HTTP）。

### Phase 4 完成验证
Windows Server 2022 全新 VM：
```powershell
winget install Python.Python.3.11 OpenJS.NodeJS.LTS Git.Git
choco install nssm
git clone --recursive <repo> C:\mlearnweb_test
cd C:\mlearnweb_test\mlearnweb\deploy
.\install_all.ps1 -DataRoot D:\mlearnweb_data
# 计时：从 git clone 到浏览器看见 UI ≤ 30 分钟
```

---

## 验收标准

### Phase 1
- ✅ `run_ml_headless.py` 跑完后 webtrader `/metrics` 端点返回的 IC 字段非 null
- ✅ 11 日 / 20 日 label 策略各自用对应的 forward_window
- ✅ vnpy 单测全过

### Phase 2
- ✅ `_FORWARD_DAYS = 11` / `_load_close_lookup` / IC corr 代码 grep 无结果
- ✅ `scripts/backfill_ml_metrics_ic.py` 删除
- ✅ mlearnweb 单测 ≥ 128 - 删掉的 + 新加的（应保持 ≥ 128）
- ✅ 实盘策略详情页 IC 图正常加载

### Phase 3
- ✅ `daily_merged_root` / `daily_merged_all_path` config 字段删除
- ✅ `vnpy_sim_db_root` / `ml_live_output_root` 改 Optional[str] = None
- ✅ 干净机器无 D:\vnpy_data 时所有功能正常

### Phase 4
- ✅ 单条命令 `.\install_all.ps1 -DataRoot ...` 完成全部安装
- ✅ 浏览器 `http://server:8000` 直接见 UI
- ✅ ps1 脚本无任何硬编码绝对路径
- ✅ `mlearnweb/README.md` 存在含 mermaid 架构图
- ✅ `ARCHITECTURE.md` / `DEPLOYMENT.md` 框图 mermaid 化

---

## 风险与权衡

1. **Phase 1 跨工程改动**：vnpy 工程 commit 与 mlearnweb commit 时序错位会临时不一致。**缓解**：先合 Phase 1（vnpy 端 IC 闭环），跑 1-2 天验证 metrics IC 非空，再合 Phase 2（mlearnweb 删 IC）。

2. **过渡期 IC 数据**：Phase 2 删 mlearnweb IC 计算前，已存在的 `ml_metric_snapshots.ic` 是 mlearnweb 之前算的。Phase 1 完成后 vnpy 端的 `ic_backfill_scan_days` 默认 30 天，30 天后所有数据自然由 vnpy 端覆盖。算法等价（vendor 同源），数值差小数末位不告警。

3. **forward_window 解析失败**：Phase 1 V1.3 让 `ic_forward_window` 属性 raise，外层捕获后 IC backfill skip。比沉默用 2 算错好得多。

4. **Phase 4 install_all.ps1 跑 pip install 默认 PyPI**：国内服务器慢。`-PipIndexUrl https://pypi.tuna.tsinghua.edu.cn/simple` 解决。

5. **跨网部署 vnpy 节点 autossh 隧道**：Phase 4 不解决，留 L2 文档化（NSSM 包 ssh / Tailscale）。

6. **HTTPS / 域名证书**：留 L2 引入 Caddy。

---

## L2 / L3 留作后续（不在本路线图内）

- HTTPS：引入 Caddy for Windows + Caddyfile
- 自动备份：deploy/backup.ps1 + Task Scheduler
- autossh on Windows：NSSM 包 ssh / Tailscale 文档
- Sentry / Prometheus / Grafana
- CI/CD：.github/workflows
- 容器化：Windows containers / podman-machine
