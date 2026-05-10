from pydantic_settings import BaseSettings
from typing import List, Optional, Set
from pathlib import Path
import os

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_DEFAULT_DATA_ROOT = Path(_BASE_DIR)


def _env_file() -> str:
    """Return the bootstrap env file path.

    Local development keeps using backend/.env. Windows production deployment
    sets MLEARNWEB_ENV_FILE to DataRoot/config/.env through NSSM so runtime
    config is no longer tied to the repository checkout.
    """
    return os.getenv("MLEARNWEB_ENV_FILE", ".env")


class Settings(BaseSettings):
    data_root: Optional[Path] = None
    mlruns_dir: str = ""
    database_url: str = f"sqlite:///{os.path.join(_BASE_DIR, 'mlearnweb.db')}"
    cors_origins: List[str] = ["http://localhost:5173", "http://localhost:3000"]

    # Phase 4 (W4.1) — 生产部署单端口模式. app.main 启动时若该路径存在则
    # mount StaticFiles 提供 SPA fallback, 浏览器只认 :8000 不需要单独的
    # nginx/IIS 服务前端 dist. 留 None 时仅 API, 前端走 Vite dev server (5173).
    # 推荐值: ``<repo_root>/frontend/dist`` (npm run build 产出).
    frontend_dist_dir: Optional[str] = None
    # 反代 /api/live-trading/* 到 :8100 (mlearnweb_live 进程). app.main 启
    # StaticFiles 后浏览器走单端口, /api/live-trading/* 必须穿透到 live_main
    # 才能拿到 vnpy 节点状态 + 实盘数据.
    live_main_internal_url: str = "http://127.0.0.1:8100"

    upload_dir: Path = _DEFAULT_DATA_ROOT / "uploads"
    max_image_size_mb: int = 10
    allowed_image_exts: Set[str] = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    orphan_grace_seconds: int = 300

    # vnpy live trading integration
    vnpy_nodes_config_path: str = os.path.join(_BASE_DIR, "vnpy_nodes.yaml")
    vnpy_request_timeout: float = 10.0
    vnpy_poll_interval_seconds: int = 10
    live_trading_event_fingerprint_interval_seconds: int = 5
    vnpy_snapshot_retention_days: int = 30
    live_trading_ops_password: Optional[str] = None

    # ML strategy live output root (where subprocess writes predictions.parquet
    # per day). Phase 3.2 后所有读路径走 vnpy webtrader HTTP, 此字段仅供
    # ``backtest-vs-live diff`` 路由的本地 fallback (同机部署优化), 跨机部署
    # 留 None 即可. 覆盖: env ``ML_LIVE_OUTPUT_ROOT``.
    ml_live_output_root: Optional[str] = None

    # vnpy_qmt_sim trading_state 目录 (含 sim_<account_id>.db). 历史持仓浏览
    # endpoint 在 vnpy webtrader RPC 不可用时直读此处的 sim_trades 重建持仓
    # (同机部署快路径). 跨机部署留 None — 主路径走 vnpy webtrader
    # /api/v1/position/history 接口, fallback 自动 skip.
    # [A2] 默认 D:/vnpy_data/state/ — 与 replay_history.db 同级便于备份.
    vnpy_sim_db_root: Optional[str] = None

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
    joinquant_export_dir: str = str(_DEFAULT_DATA_ROOT / "joinquant_exports")

    # Optional training-side integration. When strategy_dev_root is empty the
    # tuning workbench is intentionally disabled, while dashboard and
    # live-trading continue to start normally.
    strategy_dev_root: Optional[str] = None
    tuning_python_exe: Optional[str] = None
    tuning_runs_root: Optional[str] = None

    class Config:
        env_file_encoding = "utf-8"
        # 容忍 .env 里残留的旧字段 (e.g. Phase 3.3 删除的 DAILY_MERGED_ROOT,
        # 3.4 删的 DAILY_MERGED_ALL_PATH) — 升级时不强制用户改 .env, 进程
        # 启动不报错. 升级日志里写一行 deprecation 提示即可.
        extra = "ignore"


settings = Settings(_env_file=_env_file())

(settings.upload_dir / "training_records").mkdir(parents=True, exist_ok=True)
