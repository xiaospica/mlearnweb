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
