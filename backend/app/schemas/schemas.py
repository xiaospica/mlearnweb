from pydantic import BaseModel, Field, model_validator
from typing import Any, Dict, List, Optional
from datetime import datetime


class ExperimentBase(BaseModel):
    name: str = ""
    lifecycle_stage: str = "active"


class ExperimentResponse(ExperimentBase):
    experiment_id: str
    artifact_location: str = ""
    creation_time: Optional[int] = None
    last_update_time: Optional[int] = None
    run_count: int = 0

    class Config:
        from_attributes = True


class ExperimentListResponse(BaseModel):
    success: bool = True
    message: str = ""
    data: Dict[str, Any]


class RunDetailResponse(BaseModel):
    run_id: str
    run_name: str = ""
    status: str = "UNKNOWN"
    status_code: int = -1
    start_time: Optional[int] = None
    end_time: Optional[int] = None
    duration_seconds: Optional[float] = None
    lifecycle_stage: str = "active"
    params: Dict[str, Any] = {}
    metrics: Dict[str, Any] = {}
    tags: Dict[str, str] = {}
    artifacts: List[Dict[str, Any]] = []


class RunLinkSource(BaseModel):
    """run_id 反向引用源（用于 RunListItem.linked_sources）。"""
    type: str  # training_record / tuning_trial / deployment / ml_monitoring
    id: Optional[int] = None
    name: Optional[str] = None
    trial_number: Optional[int] = None
    node_id: Optional[str] = None
    strategy_name: Optional[str] = None
    active: Optional[bool] = None
    subtype: Optional[str] = None


class RunListItem(BaseModel):
    run_id: str
    run_name: str = ""
    status: str = "UNKNOWN"
    status_code: int = -1
    start_time: Optional[int] = None
    end_time: Optional[int] = None
    lifecycle_stage: str = "active"
    artifact_uri: str = ""
    is_linked: bool = False
    linked_sources: List[Dict[str, Any]] = Field(default_factory=list)


class UnlinkedRunItem(BaseModel):
    run_id: str
    run_name: str = ""
    start_time: Optional[int] = None
    end_time: Optional[int] = None
    size_bytes: int = 0


class UnlinkedRunsListResponse(BaseModel):
    experiment_id: str
    total_count: int = 0
    total_size_bytes: int = 0
    items: List[UnlinkedRunItem] = []


class RunCleanupRequest(BaseModel):
    """删除请求 body。

    select="all_unlinked" 时后端实时扫一次再删（避免长时间持有 UI 列表导致漂移）。
    select="manual" 时按 run_ids 删；后端依然会做二次保护校验，避免误删刚被关联的 run。
    """
    select: str = Field("manual", pattern="^(manual|all_unlinked)$")
    run_ids: List[str] = Field(default_factory=list)


class RunCleanupResponse(BaseModel):
    success: bool = True
    message: str = ""
    data: Dict[str, Any]


class RunListResponse(BaseModel):
    success: bool = True
    data: Dict[str, Any]


class ReportDataResponse(BaseModel):
    success: bool = True
    data: Dict[str, Any]


class ChartDataResponse(BaseModel):
    success: bool = True
    data: Dict[str, Any]


class TrainingRecordCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    experiment_id: str = Field(..., min_length=1)
    experiment_name: Optional[str] = None
    config_snapshot: Optional[Dict[str, Any]] = None
    command_line: Optional[str] = None
    category: Optional[str] = "single"
    tags: Optional[List[str]] = None


class TrainingRecordUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    completed_at: Optional[datetime] = None
    duration_seconds: Optional[float] = None
    summary_metrics: Optional[Dict[str, Any]] = None
    tags: Optional[List[str]] = None
    memo: Optional[str] = None
    group_name: Optional[str] = None
    is_favorite: Optional[bool] = None
    log_content: Optional[str] = None
    config_snapshot: Optional[Dict[str, Any]] = None


class TrainingRecordResponse(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    experiment_id: str
    experiment_name: Optional[str] = None
    run_ids: List[str] = []
    config_snapshot: Optional[Dict[str, Any]] = None
    status: str = "pending"
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    duration_seconds: Optional[float] = None
    command_line: Optional[str] = None
    hostname: Optional[str] = None
    python_version: Optional[str] = None
    summary_metrics: Optional[Dict[str, Any]] = None
    tags: List[str] = []
    category: Optional[str] = None
    memo: Optional[str] = None
    group_name: Optional[str] = "default"
    is_favorite: bool = False
    # Phase 3B 部署追踪。详见 vnpy_common/naming.py 命名约定章节。
    deployments: List[Dict[str, Any]] = []
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class RunMappingCreate(BaseModel):
    run_id: str = Field(..., min_length=1)
    rolling_index: Optional[int] = None
    segment_label: Optional[str] = None
    train_start: Optional[str] = None
    train_end: Optional[str] = None
    valid_start: Optional[str] = None
    valid_end: Optional[str] = None
    test_start: Optional[str] = None
    test_end: Optional[str] = None


class ApiResponse(BaseModel):
    success: bool = True
    message: str = ""
    data: Any = None


class GroupCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)


class GroupUpdate(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)


class BatchGroupUpdate(BaseModel):
    record_ids: List[int] = Field(default_factory=list)
    group_name: str = Field(..., min_length=1, max_length=64)


class GroupInfoResponse(BaseModel):
    name: str
    count: int
    is_system: bool


class InSampleBacktestRequest(BaseModel):
    run_id: str = Field(..., min_length=1)
    experiment_id: str = Field(..., min_length=1)
    segments: Optional[List[str]] = ["train", "valid", "test"]
    topk: Optional[int] = None
    n_drop: Optional[int] = None
    save_figures: Optional[bool] = True


class InSampleBacktestSegmentResult(BaseModel):
    pred_shape: Optional[List[int]] = None
    n_stocks: Optional[int] = None
    time_range: Optional[List[str]] = None
    risk_metrics: Dict[str, Any] = {}
    indicator_dict: Dict[str, Any] = {}


class InSampleBacktestResponse(BaseModel):
    success: bool = True
    message: str = ""
    data: Optional[Dict[str, Any]] = None


# ======================================================================
# Live trading (vnpy) schemas
# ======================================================================


class NodeStatus(BaseModel):
    node_id: str
    base_url: str
    enabled: bool = True
    online: bool = False
    last_probe_ts: Optional[int] = None
    last_error: Optional[str] = None
    # 节点级元数据，由 probe_nodes 填充；详见 vnpy_common/naming.py 命名约定章节
    mode: Optional[str] = None  # "live" | "sim"
    latency_ms: Optional[int] = None  # health 探活耗时；离线时 None
    app_version: Optional[str] = None  # vnpy 端 /api/v1/node/health 响应字段，缺失时 None


class EquityPoint(BaseModel):
    ts: int  # ms since epoch
    strategy_value: Optional[float] = None
    account_equity: Optional[float] = None
    source_label: Optional[str] = None


class LivePosition(BaseModel):
    vt_symbol: str
    name: Optional[str] = ""  # 股票中文简称（从 stock_list.parquet 查），查不到为空
    direction: str
    volume: float = 0
    price: Optional[float] = None  # avg cost
    pnl: Optional[float] = None
    yd_volume: Optional[float] = None
    frozen: Optional[float] = None


class StrategyIdentity(BaseModel):
    node_id: str
    engine: str
    strategy_name: str


class StrategySummary(BaseModel):
    node_id: str
    engine: str
    strategy_name: str
    class_name: Optional[str] = None
    vt_symbol: Optional[str] = None
    author: Optional[str] = None
    inited: bool = False
    trading: bool = False
    running: bool = False  # inited AND trading
    strategy_value: Optional[float] = None
    source_label: Optional[str] = None
    account_equity: Optional[float] = None
    positions_count: int = 0
    last_update_ts: Optional[int] = None
    mini_curve: List[EquityPoint] = []
    capabilities: List[str] = []
    # 实盘 / 模拟 标识（详见 vnpy_common/naming.py 命名约定）
    mode: Optional[str] = "sim"  # "live" | "sim" | None (offline)
    gateway_name: Optional[str] = ""
    # 节点离线时从 mlearnweb.db 拼出的离线视图标识
    node_offline: Optional[bool] = None
    offline_reason: Optional[str] = None
    # ---- 调度元数据（由 _infer_strategy_schedule 填充）-----------------------
    # 策略 cron 触发时间（来自 strategy.parameters，ML 策略才有）
    trigger_time: Optional[str] = None  # "21:00"
    buy_sell_time: Optional[str] = None  # "09:26"
    # 双轨依赖：影子策略 signal_source_strategy 指向上游策略名
    signal_source_strategy: Optional[str] = None
    # 上次执行结果（来自 strategy.variables）
    last_run_date: Optional[str] = None  # "YYYY-MM-DD"
    last_status: Optional[str] = None  # "ok" | "failed" | "empty"
    last_duration_ms: Optional[int] = None
    last_error: Optional[str] = None
    # 回放状态（双轨影子策略 / 历史回放进度）
    replay_status: Optional[str] = None  # "running" | "completed" | "error" 等；"idle" 归一为 None


class StrategyDetail(StrategySummary):
    parameters: Dict[str, Any] = {}
    variables: Dict[str, Any] = {}
    curve: List[EquityPoint] = []
    positions: List[LivePosition] = []


class StrategyEngineInfo(BaseModel):
    app_name: str
    display_name: Optional[str] = None
    event_type: Optional[str] = None
    capabilities: List[str] = []


class StrategyCreateRequest(BaseModel):
    engine: str = Field(..., min_length=1)
    class_name: str = Field(..., min_length=1)
    strategy_name: str = Field(..., min_length=1)
    vt_symbol: Optional[str] = None
    setting: Dict[str, Any] = Field(default_factory=dict)


class StrategyEditRequest(BaseModel):
    setting: Dict[str, Any] = Field(default_factory=dict)


class LiveTradingListResponse(BaseModel):
    success: bool = True
    message: str = ""
    data: Any = None
    warning: Optional[str] = None


# ---------------------------------------------------------------------------
# Tuning Workbench (auto_tune)
# ---------------------------------------------------------------------------


class TuningJobCreate(BaseModel):
    """创建调参 Job 请求体"""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    search_mode: str = Field("single_segment", pattern="^(single_segment|walk_forward_5p)$")
    n_trials: int = Field(70, ge=1, le=500)
    n_jobs: int = Field(1, ge=1, le=4, description="并行 trial 数；mlflow file backend 建议 1")
    num_threads: int = Field(20, ge=1, le=64, description="单 trial LightGBM num_threads")
    seed: int = Field(42, ge=0)
    # V3.3: 创建后立即入队（搜索任务队列；scheduler 在没有 job 在跑时自动启动队首）
    enqueue: bool = Field(False, description="True=创建后立即入队等待 scheduler 自动启动；False=仅创建草稿")
    # 5 类配置参数（前端 Stepper 收集，不能为空）
    config_snapshot: Dict[str, Any] = Field(
        ...,
        description="{csi300_record_lgb_task_config, custom_segments, gbdt_model, bt_strategy, record_config}"
    )

    @model_validator(mode="after")
    def _validate_search_space_consistency(self) -> "TuningJobCreate":
        """V3.6: 校验 search_space 的所有 key 都存在于 gbdt_model.kwargs.

        Optuna trial 采样后会用 search_space 里的 key 覆盖 gbdt_model.kwargs；
        若 search_space 含某 key 但 gbdt_model.kwargs 没有，覆盖结果是有意为之，
        但用户更常见的是手滑写错 key（如 lr vs learning_rate），导致 baseline
        没有该字段、Optuna 也搜不到 → silent fail。
        """
        cfg = self.config_snapshot or {}
        gbdt = cfg.get("gbdt_model") or {}
        ss = cfg.get("search_space") or {}
        if not ss:
            return self  # 没设搜索空间不校验
        if not isinstance(ss, dict):
            return self  # 类型由 dataset_class 字段单独校验
        gbdt_kwargs_keys = set((gbdt.get("kwargs") or {}).keys())
        ss_keys = set(ss.keys())
        unknown = ss_keys - gbdt_kwargs_keys
        if unknown:
            raise ValueError(
                f"search_space 含 {sorted(unknown)} 等参数，但 gbdt_model.kwargs "
                f"中没有对应基线值（baseline keys: {sorted(gbdt_kwargs_keys)}）。"
                f"请在 gbdt_model.kwargs 里加上这些参数的基线值，或从 search_space "
                f"里删掉拼写错误的 key。"
            )
        return self


class TuningJobResponse(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    status: str
    search_mode: str
    n_trials_target: int
    n_trials_done: int
    n_trials_failed: int
    best_trial_number: Optional[int] = None
    best_objective_value: Optional[float] = None
    finalized_training_record_id: Optional[int] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    duration_seconds: Optional[float] = None
    error: Optional[str] = None
    config_snapshot: Optional[Dict[str, Any]] = None
    # V3.3 队列调度
    queue_position: Optional[int] = None
    start_n_jobs: Optional[int] = None
    start_num_threads: Optional[int] = None
    start_seed: Optional[int] = None
    # V3.6 mlflow experiment_id（前端跳报告页用，不再硬编码）
    experiment_id: Optional[str] = None
    # V3.7 衍生 job：parent_job_id 是源单期搜索 job；derived_trial_numbers 是验证的 trial 列表
    parent_job_id: Optional[int] = None
    derived_trial_numbers: Optional[List[int]] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class TuningQueueReorderRequest(BaseModel):
    """队列重排请求体：按数组顺序重新分配 queue_position（1, 2, 3, ...）。"""
    job_ids: List[int] = Field(..., description="按期望顺序排列的 job_id 数组")


class TuningJobUpdateRequest(BaseModel):
    """V3.7: PATCH job 元信息（仅支持 name + description 重命名/编辑）。"""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None


class CustomSegment(BaseModel):
    """V3.7: walk-forward 单期时间分段。"""
    train: List[str] = Field(..., min_length=2, max_length=2, description="[start, end]")
    valid: List[str] = Field(..., min_length=2, max_length=2)
    test: List[str] = Field(..., min_length=2, max_length=2)


class TuningWalkForwardRequest(BaseModel):
    """V3.7 跨期验证：创建衍生 TuningJob，强制必填 custom_segments.

    与之前（V3.4）的区别：不再在源 job 内 inplace 跑 subprocess，而是创建一个
    新的 TuningJob（parent_job_id 指向源 job），用户可在 job 列表里独立
    管理验证任务（取消 / 删除 / 查看进度）。
    """
    trial_numbers: List[int] = Field(
        ..., min_length=1, description="要验证的 trial number 列表（建议 Top-3~5）"
    )
    custom_segments: List[CustomSegment] = Field(
        ...,
        min_length=2,
        description="walk-forward 时间分段（≥2 期，建议 5 期跨多个 regime）；"
        "源 job 无 custom_segments 时前端必须先填",
    )
    seed: int = Field(42, ge=0, description="walk_forward 用的单 seed")
    num_threads: int = Field(20, ge=1, le=64)
    reproduce_seeds: Optional[List[int]] = Field(
        default=None,
        description="如非空则在 walk_forward 后再跑 multi-seed reproduce",
    )


class TuningTrialResponse(BaseModel):
    trial_number: int
    state: str
    params: Dict[str, Any] = {}
    # V3.8: 全量指标 JSON（含 test_max_drawdown / IC 系列等）—— Pareto 散点图
    # 第二根 X 轴 (test_max_drawdown) 等可视化场景需要
    metrics: Optional[Dict[str, Any]] = None
    valid_sharpe: Optional[float] = None
    test_sharpe: Optional[float] = None
    overfit_ratio: Optional[float] = None
    composite_scores: Dict[str, Optional[float]] = Field(default_factory=dict)
    hard_constraint_passed: bool = False
    hard_constraint_failed_items: List[str] = Field(default_factory=list)
    run_id: Optional[str] = None
    duration_sec: Optional[float] = None
    error: Optional[str] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class TuningProgressResponse(BaseModel):
    """轻量进度响应（前端定期拉，避免 trials 表整体重传）"""
    job_id: int
    status: str
    n_trials_target: int
    n_trials_done: int
    n_trials_failed: int
    best_trial_number: Optional[int] = None
    best_objective_value: Optional[float] = None
    last_log_offset: int = 0
    duration_seconds: Optional[float] = None


class TuningFinalizeRequest(BaseModel):
    """V3.5 finalize：把 trial 的现有 training_record 关联到 job（零成本，不重训）。

    通过 trial.run_id 反查 training_run_mappings 即可，无需 seed/name/description
    （旧字段 V3.5 已移除，因为 finalize 不再创建新 record）。
    """
    trial_number: int = Field(..., ge=0)


class TuningDeployRequest(BaseModel):
    """从工作台一键部署到 vnpy 实盘"""
    node_id: str = Field(..., min_length=1)
    engine: str = Field(..., min_length=1)
    class_name: str = Field(..., min_length=1)
    strategy_name: str = Field(..., min_length=1)
    vt_symbol: Optional[str] = None
    setting_overrides: Dict[str, Any] = Field(
        default_factory=dict,
        description="覆盖 deployment_manifest 之外的 vnpy setting 字段"
    )
