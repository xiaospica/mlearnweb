from pydantic_settings import BaseSettings
from typing import List, Optional, Set
from pathlib import Path
import os

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 默认 mlruns 路径: 假定 mlearnweb 作为 qlib_strategy_dev 的子模块部署, 其
# `app/core/config.py` 位于 <repo_root>/mlearnweb/backend/app/core/. 从此处上溯
# 4 层到 qlib_strategy_dev 根, 再进入 mlruns/.  独立部署时用 `.env` 里的
# MLRUNS_DIR 显式覆盖.
_DEFAULT_MLRUNS_DIR = str(Path(_BASE_DIR).parent.parent / "mlruns")


class Settings(BaseSettings):
    mlruns_dir: str = _DEFAULT_MLRUNS_DIR
    database_url: str = f"sqlite:///{os.path.join(_BASE_DIR, 'mlearnweb.db')}"
    cors_origins: List[str] = ["http://localhost:5173", "http://localhost:3000"]

    upload_dir: Path = Path(_BASE_DIR) / "uploads"
    max_image_size_mb: int = 10
    allowed_image_exts: Set[str] = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    orphan_grace_seconds: int = 300

    # vnpy live trading integration
    vnpy_nodes_config_path: str = os.path.join(_BASE_DIR, "vnpy_nodes.yaml")
    vnpy_request_timeout: float = 10.0
    vnpy_poll_interval_seconds: int = 10
    vnpy_snapshot_retention_days: int = 30
    live_trading_ops_password: Optional[str] = None

    # ML strategy live output root (where subprocess writes predictions.parquet
    # per day). Used by backtest-vs-live diff route. Override via env
    # ``ML_LIVE_OUTPUT_ROOT``.
    ml_live_output_root: Optional[str] = None

    # Tushare daily merged snapshots root (vnpy_tushare_pro 每日 20:00 产出
    # daily_merged_YYYYMMDD.parquet). 用于 corp action 检测等数据查询。
    # 单机部署时通常与 vnpy_qmt_sim 共用同一目录。
    daily_merged_root: str = r"D:\vnpy_data\snapshots\merged"

    # Phase 3B: deployment 同步周期（秒）。10 分钟扫描一次 vnpy 节点策略并
    # 反查 bundle_dir → run_id → 写 TrainingRecord.deployments。
    deployment_sync_interval_seconds: int = 600

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()

(settings.upload_dir / "training_records").mkdir(parents=True, exist_ok=True)
