# mlearnweb 独立部署路线图

把"mlearnweb 解耦 vnpy 推理侧文件依赖" + "Windows Server 快速部署"两件事合并成一条端到端路线，按依赖排序。

## 当前进度（2026-05-06）— 全部完成 ✅

```mermaid
flowchart LR
    classDef done fill:#22c55e,color:#fff

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
    P4[Phase 4<br/>Windows 快速部署<br/>✓ mlearnweb 70eb595]:::done

    P1 --> P2 --> P31 --> HF1 --> HF2 --> HF3 --> P32 --> P33 --> P34 --> P35 --> P4
```

### 已完成（端到端本地自测通过 — 跑 run_ml_headless.py + 浏览器验证）

| Phase | Commit | 改动总结 | 验证 |
|---|---|---|---|
| **Phase 1** | vnpy `bc28425` | IcBackfillService on_complete 回调 reload metrics.json 到 MetricsCache + ic_forward_window 从 bundle/task.json 自动解析 + 38 单测 | `/api/v1/ml/strategies/.../metrics?days=30` 返回的 ic / rank_ic 字段非 null（实测 -0.13 ~ 0.07） |
| **Phase 2** | mlearnweb `1207ea8` | 删 ml_metrics_backfill_service.py 整文件 + 删 backfill_ml_metrics_ic.py 脚本 + 升级 historical_metrics_sync 同步全字段 + INSERT-IF-MISSING + 13 新单测 | `/metrics/history` 返回 18 天完整 IC 时序 |
| **Phase 3.1** | vnpy `30a4897` + mlearnweb `ad3ac26` | vnpy 加 `/api/v1/reference/stock_names` + mlearnweb stock_name_cache 后台 1h 协程 + 6 新单测 | 持仓中文简称正常显示（青岛港 / 中国海油 / 新和成 等 codepoints 正确） |
| **Hotfix httpx** | mlearnweb `fddb4d7` | client.py `trust_env=False` 避免开发机 http_proxy 拦截 vnpy 节点请求 | 本机有 `http_proxy=127.0.0.1:7890` 时 mlearnweb 直连 8001 不走代理，local 节点 online ✓ |
| **Hotfix 历史持仓** | mlearnweb `afc3152` | get_strategy_positions_on_date_via_rpc 逻辑倒置修复（之前永远走 fallback）+ test_stock_name_cache patch 路径修正 | `/positions/{yyyymmdd}` 返 7 行持仓 + 中文简称（杭州银行 / 南山铝业 等），不再误报"DAILY_MERGED_ALL_PATH 未配置" |

mlearnweb backend 测试套：**160 全过**（128 原有 + 13 新增 historical_metrics_sync + 6 stock_name_cache + 13 其他）。

vnpy_ml_strategy 测试套：107 / 7 — 7 个 fail 是预存 bug（git stash 验证过），与本次工作无关。Phase 1 新增 38 测全过。

## Context

**目标**：mlearnweb 能作为**独立项目**部署到一台干净 Windows Server 2022 上，30 分钟内跑通；运行期不直读 vnpy 推理机的任何文件，所有数据走 HTTP（vnpy_webtrader 端点）。

**现实约束**：mlearnweb / vnpy 推理 / 训练是三个职能，可能在三台不同机器上：
- 训练机（研究侧）：跑 mlflow 实验、训练后产 bundle
- vnpy 推理机：拉 bundle 实盘运行、写 metrics.json + predictions.parquet 到本地磁盘
- 监控机（mlearnweb）：HTTP 拉 vnpy webtrader 数据 + 文件挂载 mlruns 用于研究侧 UI

**剩余阻塞**（按危险度）：

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| ~~A~~ | ~~`_trigger_ic_backfill` 没传 on_complete~~ | ~~IC 写盘后 cache 不刷~~ | ✅ Phase 1 修复 |
| ~~B~~ | ~~`forward_window` 默认 2 写死~~ | ~~跨策略 IC 全错~~ | ✅ Phase 1 修复 |
| ~~C~~ | ~~mlearnweb 自算 IC~~ | ~~误工~~ | ✅ Phase 2 修复 |
| **D** | mlearnweb 直读 `D:\ml_output\predictions.parquet` (Phase 3.2) / `daily_merged` 检测 corp_actions (Phase 3.3) / `sim db` fallback (Phase 3.4) | 跨机部署不可行；同机部署也是同步血泪 | ⏳ |
| **E** | [deploy/install_services.ps1:45-47](../../deploy/install_services.ps1#L45) 默认值是开发者工作站路径 | 干净 Windows Server 上 fail-fast 退出 | ⏳ Phase 4 |
| **F** | 没有 install.ps1 一站式脚本（venv / pip / npm build / 防火墙 / Defender 排除散落各处） | 30 分钟一键部署做不到 | ⏳ Phase 4 |
| **G** | 前端没有生产入口（vite 反代是 dev-only），运维起完不知道开哪个 URL | 默认体验差 | ⏳ Phase 4 |
| **H** | mlearnweb 仓库根缺 README；docs 多用 ASCII art 而非 mermaid | 项目第一印象差 | ⏳ Phase 4 |

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
