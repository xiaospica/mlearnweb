from pydantic import BaseModel, Field
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


class RunListItem(BaseModel):
    run_id: str
    run_name: str = ""
    status: str = "UNKNOWN"
    status_code: int = -1
    start_time: Optional[int] = None
    end_time: Optional[int] = None
    lifecycle_stage: str = "active"
    artifact_uri: str = ""


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


class EquityPoint(BaseModel):
    ts: int  # ms since epoch
    strategy_value: Optional[float] = None
    account_equity: Optional[float] = None
    source_label: Optional[str] = None


class LivePosition(BaseModel):
    vt_symbol: str
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
    mode: str = "sim"  # "live" | "sim"
    gateway_name: str = ""


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
    # 5 类配置参数（前端 Stepper 收集，不能为空）
    config_snapshot: Dict[str, Any] = Field(
        ...,
        description="{csi300_record_lgb_task_config, custom_segments, gbdt_model, bt_strategy, record_config}"
    )


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
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class TuningTrialResponse(BaseModel):
    trial_number: int
    state: str
    params: Dict[str, Any] = {}
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
    """选定 trial 后触发 finalize：用其超参跑一次正式训练（写 training_records）"""
    trial_number: int = Field(..., ge=0)
    seed: int = Field(42, ge=0)
    name: Optional[str] = Field(None, description="finalize 产出 training_record 的名称；None 自动生成")
    description: Optional[str] = None


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
