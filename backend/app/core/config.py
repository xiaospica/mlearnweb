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

    # vnpy_qmt_sim trading_state 目录（含 sim_<account_id>.db）。
    # 历史持仓浏览 endpoint 直读此处的 sim_trades 重建任意日期 EOD 持仓。
    # 同机部署假设：mlearnweb backend 与 vnpy 同机；跨机部署需后续升级到
    # vnpy_webtrader 暴露 /api/v1/positions/history 接口 + mlearnweb fanout。
    vnpy_sim_db_root: str = r"F:\Quant\vnpy\vnpy_strategy_dev\vnpy_qmt_sim\.trading_state"

    # 历史持仓重建用的活动 daily_merged_all_new.parquet (含 pct_chg / close)
    daily_merged_all_path: str = r"D:\vnpy_data\stock_data\daily_merged_all_new.parquet"

    # Phase 3B: deployment 同步周期（秒）。10 分钟扫描一次 vnpy 节点策略并
    # 反查 bundle_dir → run_id → 写 TrainingRecord.deployments。
    deployment_sync_interval_seconds: int = 600

    # P1-3 Plan A: vnpy 节点 watchdog 周期 probe + 连续 offline 邮件告警。
    # interval=探活周期（秒），threshold=连续 offline N 次后才发告警邮件（防抖）。
    # 60s × 3 次 ≈ 3 分钟检测窗。recovery 邮件按状态切换发，不依赖 N。
    watchdog_probe_interval_seconds: int = 60
    watchdog_offline_threshold: int = 3

    # SMTP 配置 (mlearnweb 进程发邮件用; vnpy 进程独立用 vt_setting.json email.*)
    # 任一字段缺失 → watchdog 不发邮件, 仅日志记录 (并非 fatal).
    smtp_server: Optional[str] = None
    smtp_port: int = 465
    smtp_username: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_sender: Optional[str] = None
    smtp_receiver: Optional[str] = None
    smtp_use_ssl: bool = True   # 465 → SSL; 587/25 → STARTTLS (use_ssl=False)

    # 聚宽（JoinQuant）持仓 JSON 导出目录。同机部署假设：与 strategy_dev/result/
    # 同一文件系统，复用旧 notebook 路径方便老脚本兼容。文件命名
    # ``joinquant_positions_record{record_id}_{ts}.json``，DB 用
    # ``joinquant_exports`` 表索引。env 覆盖：JOINQUANT_EXPORT_DIR。
    joinquant_export_dir: str = str(Path(_BASE_DIR).parent.parent / "strategy_dev" / "result")

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()

(settings.upload_dir / "training_records").mkdir(parents=True, exist_ok=True)
