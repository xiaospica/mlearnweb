from typing import Any, Dict, List, Optional
from datetime import datetime
import socket
import platform
import sys
import numpy as np

from sqlalchemy.orm import Session

from app.models.database import TrainingRecord, TrainingRunMapping, get_db_session
from app.utils.mlflow_reader import mlflow_reader


def _get_cumulative_return_preview(experiment_id: str, run_id: str) -> Optional[Dict[str, Any]]:
    if not run_id or not experiment_id:
        return None
    try:
        report_df = mlflow_reader.load_portfolio_report(experiment_id, run_id)
        if report_df is None or report_df.empty or "return" not in report_df.columns:
            return None

        cum_ret = (1 + report_df["return"]).cumprod()
        total_points = len(cum_ret)
        max_points = 50
        if total_points > max_points:
            step = total_points // max_points
            sampled = cum_ret.iloc[::step].tolist()
        else:
            sampled = cum_ret.tolist()

        final_return = float(cum_ret.iloc[-1]) if len(cum_ret) > 0 else 1.0
        return {
            "values": sampled,
            "final_return": final_return,
            "total_points": total_points,
        }
    except Exception as e:
        print(f"[TrainingService] _get_cumulative_return_preview error: {e}")
        return None


def _get_merged_cumulative_return_preview(experiment_id: str, run_ids: List[str]) -> Optional[Dict[str, Any]]:
    """合并多个子运行的收益率预览"""
    if not run_ids or not experiment_id:
        return None
    
    all_returns = []
    for run_id in run_ids:
        try:
            report_df = mlflow_reader.load_portfolio_report(experiment_id, run_id)
            if report_df is not None and not report_df.empty and "return" in report_df.columns:
                all_returns.extend(report_df["return"].dropna().tolist())
        except Exception as e:
            print(f"[TrainingService] _get_merged_cumulative_return_preview error for run {run_id}: {e}")
            continue
    
    if not all_returns:
        return None
    
    try:
        returns_arr = np.array(all_returns)
        cum_ret = np.cumprod(1 + returns_arr)
        
        total_points = len(cum_ret)
        max_points = 50
        if total_points > max_points:
            step = total_points // max_points
            sampled = cum_ret[::step].tolist()
        else:
            sampled = cum_ret.tolist()
        
        final_return = float(cum_ret[-1]) if len(cum_ret) > 0 else 1.0
        return {
            "values": sampled,
            "final_return": final_return,
            "total_points": total_points,
        }
    except Exception as e:
        print(f"[TrainingService] _get_merged_cumulative_return_preview calculation error: {e}")
        return None


class TrainingService:

    @staticmethod
    def create_record(
        db: Session,
        name: str,
        experiment_id: str,
        experiment_name: Optional[str] = None,
        description: Optional[str] = None,
        config_snapshot: Optional[Dict[str, Any]] = None,
        command_line: Optional[str] = None,
        category: str = "single",
        tags: Optional[List[str]] = None,
    ) -> TrainingRecord:
        record = TrainingRecord(
            name=name,
            description=description,
            experiment_id=experiment_id,
            experiment_name=experiment_name,
            config_snapshot=config_snapshot,
            command_line=command_line,
            category=category,
            tags=tags or [],
            status="running",
            started_at=datetime.utcnow(),
            hostname=socket.gethostname(),
            python_version=f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        )
        db.add(record)
        db.commit()
        db.refresh(record)
        return record

    @staticmethod
    def list_records(
        db: Session,
        page: int = 1,
        page_size: int = 20,
        status: Optional[str] = None,
        category: Optional[str] = None,
        search: str = "",
        include_preview: bool = True,
    ) -> Dict[str, Any]:
        query = db.query(TrainingRecord)
        if status:
            query = query.filter(TrainingRecord.status == status)
        if category:
            query = query.filter(TrainingRecord.category == category)
        if search:
            query = query.filter(TrainingRecord.name.contains(search))

        total = query.count()
        records = (
            query.order_by(TrainingRecord.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        return {
            "total": total,
            "page": page,
            "page_size": page_size,
            "items": [_record_to_dict(r, include_preview=include_preview) for r in records],
        }

    @staticmethod
    def get_record(db: Session, record_id: int) -> Optional[Dict[str, Any]]:
        record = db.query(TrainingRecord).filter(TrainingRecord.id == record_id).first()
        if not record:
            return None
        data = _record_to_dict(record)
        mappings = (
            db.query(TrainingRunMapping)
            .filter(TrainingRunMapping.training_record_id == record_id)
            .order_by(TrainingRunMapping.rolling_index.asc().nullslast())
            .all()
        )
        data["run_mappings"] = [
            {
                "id": m.id,
                "run_id": m.run_id,
                "rolling_index": m.rolling_index,
                "segment_label": m.segment_label,
                "train_start": m.train_start.isoformat() if m.train_start else None,
                "train_end": m.train_end.isoformat() if m.train_end else None,
                "valid_start": m.valid_start.isoformat() if m.valid_start else None,
                "valid_end": m.valid_end.isoformat() if m.valid_end else None,
                "test_start": m.test_start.isoformat() if m.test_start else None,
                "test_end": m.test_end.isoformat() if m.test_end else None,
            }
            for m in mappings
        ]
        return data

    @staticmethod
    def update_record(db: Session, record_id: int, update_data: Dict[str, Any]) -> Optional[TrainingRecord]:
        record = db.query(TrainingRecord).filter(TrainingRecord.id == record_id).first()
        if not record:
            return None
        for key, value in update_data.items():
            if hasattr(record, key) and value is not None:
                setattr(record, key, value)
        db.commit()
        db.refresh(record)
        return record

    @staticmethod
    def delete_record(db: Session, record_id: int) -> bool:
        record = db.query(TrainingRecord).filter(TrainingRecord.id == record_id).first()
        if not record:
            return False
        db.delete(record)
        db.commit()
        return True

    @staticmethod
    def add_run_mapping(
        db: Session,
        training_record_id: int,
        run_id: str,
        rolling_index: Optional[int] = None,
        segment_label: Optional[str] = None,
        train_start: Optional[str] = None,
        train_end: Optional[str] = None,
        valid_start: Optional[str] = None,
        valid_end: Optional[str] = None,
        test_start: Optional[str] = None,
        test_end: Optional[str] = None,
    ) -> TrainingRunMapping:
        def parse_dt(s: Optional[str]) -> Optional[datetime]:
            if not s:
                return None
            try:
                return datetime.fromisoformat(s.replace("Z", "+00:00").replace("+00:00", ""))
            except (ValueError, AttributeError):
                return None

        mapping = TrainingRunMapping(
            training_record_id=training_record_id,
            run_id=run_id,
            rolling_index=rolling_index,
            segment_label=segment_label,
            train_start=parse_dt(train_start),
            train_end=parse_dt(train_end),
            valid_start=parse_dt(valid_start),
            valid_end=parse_dt(valid_end),
            test_start=parse_dt(test_start),
            test_end=parse_dt(test_end),
        )
        db.add(mapping)

        record = db.query(TrainingRecord).filter(TrainingRecord.id == training_record_id).first()
        if record:
            current_ids = record.run_ids or []
            if run_id not in current_ids:
                current_ids.append(run_id)
                record.run_ids = current_ids
                record.updated_at = datetime.utcnow()

        db.commit()
        db.refresh(mapping)
        return mapping


def _record_to_dict(record: TrainingRecord, include_preview: bool = False) -> Dict[str, Any]:
    try:
        run_ids = record.run_ids or []
        data = {
            "id": record.id,
            "name": record.name,
            "description": record.description,
            "experiment_id": record.experiment_id,
            "experiment_name": record.experiment_name,
            "run_ids": run_ids,
            "run_count": len(run_ids),
            "config_snapshot": record.config_snapshot,
            "status": record.status,
            "started_at": record.started_at.isoformat() if record.started_at else None,
            "completed_at": record.completed_at.isoformat() if record.completed_at else None,
            "duration_seconds": record.duration_seconds,
            "command_line": record.command_line,
            "hostname": record.hostname,
            "python_version": record.python_version,
            "summary_metrics": record.summary_metrics,
            "tags": record.tags or [],
            "category": record.category,
            "memo": record.memo,
            "created_at": record.created_at.isoformat() if record.created_at else None,
            "updated_at": record.updated_at.isoformat() if record.updated_at else None,
        }

        if include_preview and run_ids and record.experiment_id:
            try:
                if len(run_ids) > 1:
                    preview = _get_merged_cumulative_return_preview(record.experiment_id, run_ids)
                else:
                    preview = _get_cumulative_return_preview(record.experiment_id, run_ids[0])
                if preview:
                    data["cumulative_return_preview"] = preview
            except Exception as e:
                print(f"[TrainingService] _record_to_dict preview error: {e}")

        return data
    except Exception as e:
        print(f"[TrainingService] _record_to_dict error: {e}")
        return {
            "id": record.id if hasattr(record, 'id') else None,
            "name": record.name if hasattr(record, 'name') else "Unknown",
            "error": str(e),
        }
