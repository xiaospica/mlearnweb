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
