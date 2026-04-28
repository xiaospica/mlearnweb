from sqlalchemy import create_engine, Column, Integer, String, Text, Float, DateTime, JSON, ForeignKey, Boolean, Index, event
from sqlalchemy.orm import declarative_base, relationship
from datetime import datetime

from app.core.config import settings

engine = create_engine(settings.database_url.replace("sqlite:///", "sqlite:///"), connect_args={"check_same_thread": False})
Base = declarative_base()


# SQLite WAL mode: required for two-process access (app.main + app.live_main).
# WAL is a file-level persistent setting, so enabling it on any connection
# applies to the whole database file.
@event.listens_for(engine, "connect")
def _enable_sqlite_wal(dbapi_conn, conn_record):
    try:
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL;")
        cursor.execute("PRAGMA synchronous=NORMAL;")
        cursor.close()
    except Exception as e:
        print(f"[DB] failed to set WAL pragma: {e}")


class TrainingRecord(Base):
    __tablename__ = "training_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    experiment_id = Column(String(64), nullable=False, index=True)
    experiment_name = Column(String(255), nullable=True)
    run_ids = Column(JSON, default=list)
    config_snapshot = Column(JSON, nullable=True)
    status = Column(String(32), default="pending", index=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    duration_seconds = Column(Float, nullable=True)
    command_line = Column(Text, nullable=True)
    hostname = Column(String(255), nullable=True)
    python_version = Column(String(64), nullable=True)
    summary_metrics = Column(JSON, nullable=True)
    tags = Column(JSON, default=list)
    category = Column(String(64), nullable=True, index=True)
    log_content = Column(Text, nullable=True)
    memo = Column(Text, nullable=True)
    group_name = Column(String(64), nullable=True, index=True, default="default")
    is_favorite = Column(Boolean, default=False, index=True)
    # Phase 3B: 部署追踪。list of dict: {node_id, engine, strategy_name, mode,
    # gateway_name, run_id, bundle_dir, first_seen_at, last_seen_at, active}
    # 由 deployment_sync_service 周期扫描 vnpy 节点策略后写入。
    # 详见 vnpy_common/naming.py 命名约定章节。
    deployments = Column(JSON, default=list)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    run_mappings = relationship("TrainingRunMapping", back_populates="training_record", cascade="all, delete-orphan")


class StrategyEquitySnapshot(Base):
    """Time series of per-strategy equity/PnL snapshots, polled by the
    live_trading snapshot_loop in app.live_main.

    ``source_label`` records which of the three fallback tiers produced
    ``strategy_value`` for a given tick:
      - "strategy_pnl"      : taken from vnpy StrategyInfo.variables PnL fields
      - "position_sum_pnl"  : sum of PositionData.pnl matching strategy vt_symbol
      - "account_equity"    : gateway account balance (multi-strategy shared)
    ``account_equity`` is always populated when available so the frontend
    can switch labels without a DB migration.

    Index design (both are required, covered by EXPLAIN QUERY PLAN):
      1. ``ix_ses_identity_ts`` — leftmost-prefix covers _read_curve's
         ``WHERE node_id=? AND engine=? AND strategy_name=? AND ts>=?
         ORDER BY ts DESC``; the trailing ``ts`` column also serves the
         ORDER BY without a filesort.
      2. ``ix_ses_ts`` — single-column ts index for the retention DELETE
         (``WHERE ts < cutoff``) and any future time-window scans that
         don't have identity predicates.
      We intentionally do NOT add a ``(ts, node_id, engine, strategy_name)``
      index: no current query has the ``ts range then identity`` shape, and
      the snapshot_tick loop writes one row per active strategy every
      VNPY_POLL_INTERVAL_SECONDS, so any unused index is pure write overhead.
    """

    __tablename__ = "strategy_equity_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    node_id = Column(String(64), nullable=False)
    engine = Column(String(64), nullable=False)
    strategy_name = Column(String(128), nullable=False)
    ts = Column(DateTime, nullable=False)
    strategy_value = Column(Float, nullable=True)
    source_label = Column(String(32), nullable=True)
    account_equity = Column(Float, nullable=True)
    positions_count = Column(Integer, default=0)
    raw_variables_json = Column(Text, nullable=True)

    __table_args__ = (
        Index("ix_ses_identity_ts", "node_id", "engine", "strategy_name", "ts"),
        Index("ix_ses_ts", "ts"),
    )


class TrainingRunMapping(Base):
    __tablename__ = "training_run_mappings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    training_record_id = Column(Integer, ForeignKey("training_records.id", ondelete="CASCADE"), nullable=False, index=True)
    run_id = Column(String(64), nullable=False, index=True)
    rolling_index = Column(Integer, nullable=True)
    segment_label = Column(String(128), nullable=True)
    train_start = Column(DateTime, nullable=True)
    train_end = Column(DateTime, nullable=True)
    valid_start = Column(DateTime, nullable=True)
    valid_end = Column(DateTime, nullable=True)
    test_start = Column(DateTime, nullable=True)
    test_end = Column(DateTime, nullable=True)

    training_record = relationship("TrainingRecord", back_populates="run_mappings")


class TuningJob(Base):
    """调参作业（auto_tune Optuna study 包装）。

    与 TrainingRecord 父子两级抽象（对齐 MLflow Experiment+Run / Optuna Study+Trial /
    W&B Sweep+Run / Sagemaker HPO Job + Training Job 业界范式）：
    - TuningJob = 搜索过程（N 个 trial 组成）
    - finalized_training_record_id = export 后挂回的"正式训练"，复用现有 TrainingRecord 链路
    """
    __tablename__ = "tuning_jobs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    # status: created/running/searching/finalizing/done/cancelled/failed/zombie
    status = Column(String(32), default="created", index=True)
    # search_mode: single_segment / walk_forward_5p
    search_mode = Column(String(32), default="single_segment", nullable=False)
    # config_snapshot: 5 类参数快照
    # {csi300_record_lgb_task_config, custom_segments, gbdt_model, bt_strategy, record_config}
    config_snapshot = Column(JSON, nullable=False)
    # Optuna study 持久化
    optuna_study_name = Column(String(255), nullable=False)
    optuna_study_db_path = Column(String(512), nullable=False)
    # per-job 隔离工作目录：trials.csv / overrides/ / run_index/ / log
    workdir = Column(String(512), nullable=False)
    # subprocess 进程信息（用于孤儿恢复）
    pid = Column(Integer, nullable=True)
    pid_started_at = Column(Float, nullable=True)  # process create_time（防 PID 复用）
    # 进度
    n_trials_target = Column(Integer, nullable=False, default=0)
    n_trials_done = Column(Integer, default=0)
    n_trials_failed = Column(Integer, default=0)
    best_trial_number = Column(Integer, nullable=True)
    best_objective_value = Column(Float, nullable=True)
    # finalize 阶段产出的 TrainingRecord（与命令行一致的链路）
    finalized_training_record_id = Column(Integer, ForeignKey("training_records.id", ondelete="SET NULL"), nullable=True, index=True)
    # 实时日志：append-only 文本，前端可拉
    log_path = Column(String(512), nullable=True)
    # 时间戳
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    duration_seconds = Column(Float, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)
    # V3.3 队列调度：queue_position NULL 表示不在队列；非 NULL 数字越小越先跑。
    # 配套字段 start_* 持久化创建时的运行参数，便于 scheduler 自动启动时复用
    # （手动 POST /start 也仍然接受 query 参数 override）。
    queue_position = Column(Integer, nullable=True, index=True)
    start_n_jobs = Column(Integer, default=1)
    start_num_threads = Column(Integer, default=20)
    start_seed = Column(Integer, default=42)
    # V3.6: 该 job 的 mlflow experiment_id（前端跳报告页用）
    # 默认 '374089520733232109' 即 rolling_exp，与命令行训练同实验
    experiment_id = Column(String(64), default="374089520733232109", nullable=True)

    trials = relationship("TuningTrial", back_populates="job", cascade="all, delete-orphan")


class TuningTrial(Base):
    """单个 Optuna trial 的持久化（每行一个 trial）。

    SQL 查询/排序/筛选直接在表上做，避免把 70+ trial 塞 JSON 字段导致查询慢。
    """
    __tablename__ = "tuning_trials"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tuning_job_id = Column(Integer, ForeignKey("tuning_jobs.id", ondelete="CASCADE"), nullable=False, index=True)
    trial_number = Column(Integer, nullable=False, index=True)
    # state: running / completed / failed / pruned / metrics_missing / no_run_index
    state = Column(String(32), default="running", index=True)
    # 10 维 GBDT 搜索参数
    params = Column(JSON, nullable=False)
    # 40+ 全量指标（valid/train/test 三段所有口径）
    metrics = Column(JSON, nullable=True)
    # 关键标量列（建索引方便排序，避免 JSON path 查询）
    valid_sharpe = Column(Float, nullable=True, index=True)
    test_sharpe = Column(Float, nullable=True)
    overfit_ratio = Column(Float, nullable=True)
    # 4 个评分公式（仅记录，不参与 Optuna 目标）
    composite_scores = Column(JSON, nullable=True)
    # 硬约束
    hard_constraint_passed = Column(Boolean, default=False)
    hard_constraint_failed_items = Column(JSON, default=list)
    # 关联 mlflow run
    run_id = Column(String(64), nullable=True, index=True)
    run_name = Column(String(255), nullable=True)
    duration_sec = Column(Float, nullable=True)
    error = Column(Text, nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    job = relationship("TuningJob", back_populates="trials")

    __table_args__ = (
        Index("ix_tt_job_trial", "tuning_job_id", "trial_number", unique=True),
        Index("ix_tt_job_sharpe", "tuning_job_id", "valid_sharpe"),
    )


def init_db():
    # Import ML monitoring models here to register them on Base.metadata
    # before create_all runs. Module-level import in __init__.py would
    # cause circular imports (models/__init__ → database → models).
    from . import ml_monitoring  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _migrate_add_log_content()
    _migrate_add_memo()
    _migrate_add_group_favorite()
    _migrate_add_deployments()
    _migrate_strategy_equity_snapshot_indexes()
    _migrate_add_tuning_queue_columns()


def _migrate_strategy_equity_snapshot_indexes():
    """Align indexes on strategy_equity_snapshots with the current model.

    Early versions of this table used ``Column(ts, index=True)`` which caused
    SQLAlchemy to auto-name the single-column index ``ix_strategy_equity_snapshots_ts``.
    We now declare it explicitly as ``ix_ses_ts`` in ``__table_args__`` for
    consistency, but ``Base.metadata.create_all`` does not retroactively add
    or rename indexes on an existing table. This migration rebuilds the
    single-column ts index under the new name idempotently.
    """
    import sqlite3

    db_path = settings.database_url.replace("sqlite:///", "")
    if not db_path or not db_path.endswith(".db"):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='strategy_equity_snapshots'"
        )
        if not cursor.fetchone():
            conn.close()
            return
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='strategy_equity_snapshots'"
        )
        existing = {row[0] for row in cursor.fetchall()}
        if "ix_strategy_equity_snapshots_ts" in existing:
            cursor.execute("DROP INDEX IF EXISTS ix_strategy_equity_snapshots_ts")
            conn.commit()
            print("[DB Migration] Dropped legacy index ix_strategy_equity_snapshots_ts")
        if "ix_ses_ts" not in existing:
            cursor.execute("CREATE INDEX ix_ses_ts ON strategy_equity_snapshots(ts)")
            conn.commit()
            print("[DB Migration] Created index ix_ses_ts on strategy_equity_snapshots(ts)")
        conn.close()
    except Exception as e:
        print(f"[DB Migration] strategy_equity_snapshot indexes warning: {e}")


def _migrate_add_group_favorite():
    """数据库迁移：添加 group_name 和 is_favorite 字段"""
    import sqlite3
    db_path = settings.database_url.replace("sqlite:///", "")
    if not db_path or not db_path.endswith(".db"):
        return
    
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(training_records)")
        columns = [col[1] for col in cursor.fetchall()]
        
        if "group_name" not in columns:
            cursor.execute("ALTER TABLE training_records ADD COLUMN group_name TEXT DEFAULT 'default'")
            conn.commit()
            print("[DB Migration] Added group_name column to training_records table")
        
        if "is_favorite" not in columns:
            cursor.execute("ALTER TABLE training_records ADD COLUMN is_favorite INTEGER DEFAULT 0")
            conn.commit()
            print("[DB Migration] Added is_favorite column to training_records table")
        
        conn.close()
    except Exception as e:
        print(f"[DB Migration] Warning: {e}")


def _migrate_add_memo():
    """数据库迁移：添加 memo 字段"""
    import sqlite3
    db_path = settings.database_url.replace("sqlite:///", "")
    if not db_path or not db_path.endswith(".db"):
        return
    
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(training_records)")
        columns = [col[1] for col in cursor.fetchall()]
        
        if "memo" not in columns:
            cursor.execute("ALTER TABLE training_records ADD COLUMN memo TEXT")
            conn.commit()
            print("[DB Migration] Added memo column to training_records table")
        
        conn.close()
    except Exception as e:
        print(f"[DB Migration] Warning: {e}")


def _migrate_add_log_content():
    """数据库迁移：添加 log_content 字段"""
    import sqlite3
    db_path = settings.database_url.replace("sqlite:///", "")
    if not db_path or not db_path.endswith(".db"):
        return

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(training_records)")
        columns = [col[1] for col in cursor.fetchall()]

        if "log_content" not in columns:
            cursor.execute("ALTER TABLE training_records ADD COLUMN log_content TEXT")
            conn.commit()
            print("[DB Migration] Added log_content column to training_records table")

        conn.close()
    except Exception as e:
        print(f"[DB Migration] Warning: {e}")


def _migrate_add_deployments():
    """Phase 3B 迁移：在 training_records 加 deployments JSON 列。

    存储 list[dict] 部署追踪信息，由 deployment_sync_service 周期写入。
    详见 vnpy_common/naming.py 命名约定章节。
    """
    import sqlite3
    db_path = settings.database_url.replace("sqlite:///", "")
    if not db_path or not db_path.endswith(".db"):
        return

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(training_records)")
        columns = [col[1] for col in cursor.fetchall()]

        if "deployments" not in columns:
            cursor.execute("ALTER TABLE training_records ADD COLUMN deployments JSON")
            conn.commit()
            print("[DB Migration] Added deployments column to training_records table")

        conn.close()
    except Exception as e:
        print(f"[DB Migration] Warning: {e}")


def _migrate_add_tuning_queue_columns():
    """V3.3 + V3.6 迁移：tuning_jobs 加 queue_position + start_* + experiment_id 列。"""
    import sqlite3
    db_path = settings.database_url.replace("sqlite:///", "")
    if not db_path or not db_path.endswith(".db"):
        return
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(tuning_jobs)")
        columns = [col[1] for col in cursor.fetchall()]
        adds = [
            ("queue_position", "INTEGER"),
            ("start_n_jobs", "INTEGER DEFAULT 1"),
            ("start_num_threads", "INTEGER DEFAULT 20"),
            ("start_seed", "INTEGER DEFAULT 42"),
            ("experiment_id", "VARCHAR(64) DEFAULT '374089520733232109'"),
        ]
        for col_name, col_def in adds:
            if col_name not in columns:
                cursor.execute(f"ALTER TABLE tuning_jobs ADD COLUMN {col_name} {col_def}")
                print(f"[DB Migration] Added {col_name} column to tuning_jobs table")
        # 索引（queue_position 用于 scheduler 查队首；ALTER 加列不会自动建索引）
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS ix_tuning_jobs_queue_position "
            "ON tuning_jobs(queue_position)"
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[DB Migration] tuning_jobs queue cols: {e}")


def get_db_session():
    from sqlalchemy.orm import sessionmaker, Session
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
