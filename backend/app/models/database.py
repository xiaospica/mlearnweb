from sqlalchemy import create_engine, Column, Integer, String, Text, Float, DateTime, JSON, ForeignKey
from sqlalchemy.orm import declarative_base, relationship
from datetime import datetime

from app.core.config import settings

engine = create_engine(settings.database_url.replace("sqlite:///", "sqlite:///"), connect_args={"check_same_thread": False})
Base = declarative_base()


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
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    run_mappings = relationship("TrainingRunMapping", back_populates="training_record", cascade="all, delete-orphan")


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


def init_db():
    Base.metadata.create_all(bind=engine)
    _migrate_add_log_content()


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


def get_db_session():
    from sqlalchemy.orm import sessionmaker, Session
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
