"""扫描 MLflow run 关联状态 + 软删未关联 run。

"已关联"覆盖 4 个引用源（任一命中即视为受保护，不可删）：
  1. training_run_mappings.run_id —— 主，正式训练记录
  2. tuning_trials.run_id —— 调参 trial（每 job 70+，独立于 TrainingRecord）
  3. training_records.deployments[*].run_id —— 实盘部署兜底
  4. ml_metric_snapshots.model_run_id / ml_prediction_daily.model_run_id —— 在线监控溯源

软删：把 ``mlruns/{exp_id}/{run_id}/`` 整目录 mv 到 ``mlruns/.trash/{exp_id}/{run_id}/``。
MLflow 标准的 ``lifecycle_stage=deleted`` 改 meta.yaml 只是逻辑删，磁盘没释放，不符合
"清磁盘"诉求。回收站可由用户 ``rm -rf mlruns/.trash`` 真正释放。
"""

from __future__ import annotations

import json
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from sqlalchemy.orm import Session

from app.models.database import TrainingRecord, TrainingRunMapping, TuningJob, TuningTrial
from app.models.ml_monitoring import MLMetricSnapshot, MLPredictionDaily
from app.utils.mlflow_reader import mlflow_reader


# 关联类型常量（与前端 Tag label 对齐）
SOURCE_TRAINING = "training_record"
SOURCE_TUNING = "tuning_trial"
SOURCE_DEPLOYMENT = "deployment"
SOURCE_MONITORING = "ml_monitoring"


@dataclass
class LinkIndex:
    """run_id → list[source_dict] 的反向索引。

    一次性扫表生成，避免 list_runs() 时 N+1 查询。
    """
    by_run_id: Dict[str, List[Dict[str, Any]]] = field(default_factory=dict)

    def add(self, run_id: str, source: Dict[str, Any]) -> None:
        if not run_id:
            return
        self.by_run_id.setdefault(run_id, []).append(source)

    def get(self, run_id: str) -> List[Dict[str, Any]]:
        return self.by_run_id.get(run_id, [])

    def is_linked(self, run_id: str) -> bool:
        return run_id in self.by_run_id


def build_link_index(db: Session) -> LinkIndex:
    """一次性扫描 4 个表，返回 run_id → sources 的反向索引。"""
    idx = LinkIndex()

    # 1. training_run_mappings JOIN training_records（拿 record name 用于 hover）
    rows = (
        db.query(
            TrainingRunMapping.run_id,
            TrainingRecord.id,
            TrainingRecord.name,
        )
        .join(TrainingRecord, TrainingRunMapping.training_record_id == TrainingRecord.id)
        .all()
    )
    for run_id, record_id, record_name in rows:
        idx.add(run_id, {
            "type": SOURCE_TRAINING,
            "id": record_id,
            "name": record_name,
        })

    # 2. tuning_trials JOIN tuning_jobs
    trial_rows = (
        db.query(
            TuningTrial.run_id,
            TuningTrial.trial_number,
            TuningJob.id,
            TuningJob.name,
        )
        .join(TuningJob, TuningTrial.tuning_job_id == TuningJob.id)
        .filter(TuningTrial.run_id.isnot(None))
        .all()
    )
    for run_id, trial_number, job_id, job_name in trial_rows:
        idx.add(run_id, {
            "type": SOURCE_TUNING,
            "id": job_id,
            "name": job_name,
            "trial_number": trial_number,
        })

    # 3. training_records.deployments[*].run_id（JSON 字段，Python 端展开）
    records_with_deploy = (
        db.query(TrainingRecord.id, TrainingRecord.name, TrainingRecord.deployments)
        .filter(TrainingRecord.deployments.isnot(None))
        .all()
    )
    for record_id, record_name, deployments in records_with_deploy:
        if not deployments:
            continue
        for dep in deployments:
            run_id = dep.get("run_id") if isinstance(dep, dict) else None
            if not run_id:
                continue
            idx.add(run_id, {
                "type": SOURCE_DEPLOYMENT,
                "id": record_id,
                "name": record_name,
                "node_id": dep.get("node_id"),
                "strategy_name": dep.get("strategy_name"),
                "active": bool(dep.get("active", False)),
            })

    # 4. ML 在线监控两张表
    for model_cls, label in [(MLMetricSnapshot, "metric"), (MLPredictionDaily, "prediction")]:
        snap_rows = (
            db.query(model_cls.model_run_id)
            .filter(model_cls.model_run_id.isnot(None))
            .distinct()
            .all()
        )
        for (run_id,) in snap_rows:
            idx.add(run_id, {
                "type": SOURCE_MONITORING,
                "subtype": label,
            })

    return idx


def annotate_runs_with_link_status(
    runs: List[Dict[str, Any]],
    link_index: LinkIndex,
) -> List[Dict[str, Any]]:
    """给 mlflow_reader.list_runs() 返回的 run 列表追加 linked_sources 字段。"""
    for run in runs:
        sources = link_index.get(run["run_id"])
        run["linked_sources"] = sources
        run["is_linked"] = len(sources) > 0
    return runs


def _trash_root() -> Path:
    return mlflow_reader.mlruns_dir / ".trash"


def _trash_dir_for(exp_id: str, run_id: str) -> Path:
    return _trash_root() / exp_id / run_id


def _measure_dir_size_bytes(path: Path) -> int:
    """递归累加文件 size。出错的子项跳过，不抛异常。"""
    total = 0
    try:
        for p in path.rglob("*"):
            try:
                if p.is_file():
                    total += p.stat().st_size
            except OSError:
                continue
    except OSError:
        pass
    return total


def list_unlinked_runs(
    db: Session,
    experiment_id: str,
) -> Dict[str, Any]:
    """扫描某实验下所有 run，返回未关联的 run 列表 + 估算磁盘占用。

    用于前端 Modal 弹窗预览（不分页，因为通常未关联 < 几百条）。
    """
    exp_dir = mlflow_reader.mlruns_dir / experiment_id
    if not exp_dir.exists():
        return {"experiment_id": experiment_id, "items": [], "total_size_bytes": 0}

    link_index = build_link_index(db)
    items: List[Dict[str, Any]] = []
    total_bytes = 0

    for item in exp_dir.iterdir():
        if not item.is_dir() or not (item / "meta.yaml").exists():
            continue
        run_id = item.name
        if link_index.is_linked(run_id):
            continue
        # 读 meta.yaml 给前端展示 run_name + start_time
        try:
            meta = mlflow_reader._load_yaml(item / "meta.yaml")
        except Exception:
            meta = {}
        size_bytes = _measure_dir_size_bytes(item)
        total_bytes += size_bytes
        items.append({
            "run_id": meta.get("run_id", run_id),
            "run_name": meta.get("run_name", ""),
            "start_time": meta.get("start_time"),
            "end_time": meta.get("end_time"),
            "size_bytes": size_bytes,
        })

    items.sort(key=lambda x: x.get("start_time") or 0, reverse=True)
    return {
        "experiment_id": experiment_id,
        "items": items,
        "total_count": len(items),
        "total_size_bytes": total_bytes,
    }


def soft_delete_runs(
    db: Session,
    experiment_id: str,
    run_ids: List[str],
) -> Dict[str, Any]:
    """把指定 run 整目录 mv 到 mlruns/.trash/{exp_id}/{run_id}/。

    安全网：mv 之前重新 build_link_index()，过滤掉刚被关联的 run（防竞态）。
    返回 per-run 结果，便于前端展示哪些成功/跳过/失败。
    """
    if not run_ids:
        return {"deleted": [], "skipped": [], "failed": [], "freed_bytes": 0}

    exp_dir = mlflow_reader.mlruns_dir / experiment_id
    if not exp_dir.exists():
        return {
            "deleted": [],
            "skipped": [],
            "failed": [{"run_id": rid, "reason": "experiment_dir_not_found"} for rid in run_ids],
            "freed_bytes": 0,
        }

    # 二次校验：避免 UI 列表生成后到点击删除之间，run 刚被某个流程关联
    fresh_index = build_link_index(db)
    trash_root = _trash_root()
    trash_root.mkdir(parents=True, exist_ok=True)
    deleted_at_iso = time.strftime("%Y-%m-%dT%H:%M:%S")

    deleted: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    failed: List[Dict[str, Any]] = []
    freed_bytes = 0

    for run_id in run_ids:
        src = exp_dir / run_id
        if not src.exists() or not src.is_dir():
            failed.append({"run_id": run_id, "reason": "run_dir_not_found"})
            continue

        if fresh_index.is_linked(run_id):
            skipped.append({
                "run_id": run_id,
                "reason": "now_linked",
                "linked_sources": fresh_index.get(run_id),
            })
            continue

        size_bytes = _measure_dir_size_bytes(src)
        dst = _trash_dir_for(experiment_id, run_id)

        # 同名碰撞：追加时间戳后缀
        if dst.exists():
            dst = dst.with_name(f"{run_id}__{int(time.time())}")

        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            # 写一份删除元数据，便于回收站查看与潜在的恢复
            try:
                (dst / ".cleanup_meta.json").write_text(
                    json.dumps({
                        "experiment_id": experiment_id,
                        "run_id": run_id,
                        "deleted_at": deleted_at_iso,
                        "size_bytes": size_bytes,
                        "original_path": str(src),
                    }, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
            except OSError:
                pass  # 元数据写失败不影响删除主流程
            deleted.append({"run_id": run_id, "size_bytes": size_bytes, "trash_path": str(dst)})
            freed_bytes += size_bytes
        except OSError as exc:
            failed.append({"run_id": run_id, "reason": f"move_failed: {exc}"})

    return {
        "experiment_id": experiment_id,
        "deleted": deleted,
        "skipped": skipped,
        "failed": failed,
        "freed_bytes": freed_bytes,
        "trash_root": str(trash_root),
    }


def list_trash(experiment_id: Optional[str] = None) -> Dict[str, Any]:
    """列出 mlruns/.trash 内容（可选按 experiment 过滤），便于将来加"清空回收站"功能。"""
    trash_root = _trash_root()
    if not trash_root.exists():
        return {"items": [], "total_size_bytes": 0}

    items: List[Dict[str, Any]] = []
    total_bytes = 0
    exp_dirs = [trash_root / experiment_id] if experiment_id else [
        d for d in trash_root.iterdir() if d.is_dir()
    ]
    for exp_dir in exp_dirs:
        if not exp_dir.exists() or not exp_dir.is_dir():
            continue
        for run_dir in exp_dir.iterdir():
            if not run_dir.is_dir():
                continue
            meta_path = run_dir / ".cleanup_meta.json"
            meta: Dict[str, Any] = {}
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    meta = {}
            size_bytes = meta.get("size_bytes") or _measure_dir_size_bytes(run_dir)
            total_bytes += size_bytes
            items.append({
                "experiment_id": exp_dir.name,
                "run_id": run_dir.name,
                "deleted_at": meta.get("deleted_at"),
                "size_bytes": size_bytes,
                "trash_path": str(run_dir),
            })

    items.sort(key=lambda x: x.get("deleted_at") or "", reverse=True)
    return {"items": items, "total_size_bytes": total_bytes, "trash_root": str(trash_root)}
