"""调参作业（auto_tune Optuna study）管理服务.

职责:
    1. subprocess 生命周期：启动 / 取消 / 孤儿恢复
    2. 增量解析 per-job trials.csv → 同步到 tuning_trials 表
    3. 计算 best trial 并维护 tuning_jobs 进度字段
    4. V3.3 队列调度：scheduler async loop 串行启动 enqueue 的 job

设计:
    - subprocess 用 Popen（不用 asyncio）：与现有同步 FastAPI 风格一致
    - 不常驻同步线程：前端轮询 /progress 时按需触发 csv → DB 同步
    - per-job workdir 隔离（auto_tune/runs/<job_id>/），避免多 job 串扰
    - 队列串行：scheduler 任何时刻最多只启 1 个 job，避免 mlflow file
      backend 并发 race（与多 job 并发的需求区分；并发版本待 mlflow 迁
      SQLite backend 后再考虑）

不在本 service 范围内：
    - SSE 推送（在 router 层用 sse-starlette 实现）
    - 一键部署到 vnpy（POST /deploy 直接转调既有 live_trading 接口）
"""

from __future__ import annotations

import asyncio
import csv
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import psutil
from sqlalchemy import func
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.database import TuningJob, TuningTrial


# 配置：可通过环境变量覆盖（mlearnweb 与 strategy_dev 在同主机时默认即可）
TUNING_PYTHON_EXE = os.environ.get(
    "TUNING_PYTHON_EXE",
    r"E:\ssd_backup\Pycharm_project\python-3.11.0-amd64\python.exe",
)
STRATEGY_DEV_ROOT = Path(
    os.environ.get(
        "STRATEGY_DEV_ROOT",
        r"F:\Quant\code\qlib_strategy_dev",
    )
)
TUNING_RUNS_ROOT = Path(
    os.environ.get(
        "TUNING_RUNS_ROOT",
        r"F:\Quant\code\qlib_strategy_dev\strategy_dev\auto_tune\runs",
    )
)


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------


def get_job_workdir(job_id: int) -> Path:
    """返回 per-job 隔离工作目录（trials.csv / overrides/ / log 等）。"""
    return TUNING_RUNS_ROOT / f"job_{job_id:06d}"


def is_pid_alive(pid: Optional[int], started_at: Optional[float]) -> bool:
    """psutil 双重校验：PID 存在 + 进程 create_time 与记录值一致（防 PID 复用）。"""
    if not pid:
        return False
    try:
        proc = psutil.Process(pid)
        if not proc.is_running():
            return False
        if started_at is None:
            return True  # 没记录 create_time，仅靠 PID 存在
        # 容忍 0.5s 的浮点误差（不同平台 create_time 精度不同）
        return abs(proc.create_time() - started_at) < 0.5
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False


def _write_config_overrides(job: TuningJob, workdir: Path) -> Dict[str, Any]:
    """V2: 把 job.config_snapshot 的 4 类参数写出到 per-job 目录的 4 个 JSON 文件，
    供 run_optuna_search → train script 通过 --*-json 参数读取并 override。

    返回 dict:
        - task_config / custom_segments / bt_strategy / record_config: JSON 路径或 None
        - single_segment: bool（search_mode='single_segment' 时为 True，
                          train script 据此忽略默认 CUSTOM_SEGMENTS）
    """
    cfg = job.config_snapshot or {}
    overrides_dir = workdir / "config_overrides"
    overrides_dir.mkdir(parents=True, exist_ok=True)

    out: Dict[str, Any] = {
        "task_config": None,
        "custom_segments": None,
        "record_config": None,
        "search_space": None,
        "single_segment": job.search_mode == "single_segment",
    }

    def _write(key: str, filename: str) -> Optional[Path]:
        value = cfg.get(key)
        if value is None or (isinstance(value, (list, dict)) and len(value) == 0):
            return None
        path = overrides_dir / filename
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return path

    # 字段名约定（与前端 TuningConfigSnapshot 一致）
    out["task_config"] = _write("task_config", "task_config.json")
    # 单期模式不写 custom_segments（让 --single-segment 标志生效）
    if not out["single_segment"]:
        out["custom_segments"] = _write("custom_segments", "custom_segments.json")
    # V3.1: bt_strategy 已废弃为独立字段，前端直接 merge 到 record_config
    out["record_config"] = _write("record_config", "record_config.json")
    out["search_space"] = _write("search_space", "search_space.json")
    return out


def _build_subprocess_cmd(
    job: TuningJob,
    n_jobs: int = 1,
    num_threads: int = 20,
    seed: int = 42,
    extra_overrides: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """组装 run_optuna_search subprocess 命令行.

    用 ``-u`` 标志强制 Python 解释器无缓冲（Windows 上 PYTHONUNBUFFERED 不可靠），
    保证 stdout/stderr 立即刷到 mlearnweb 后端 Popen 的 stdout fd（即 subprocess.stdout.log）。
    """
    workdir = get_job_workdir(job.id)
    cmd = [
        TUNING_PYTHON_EXE,
        "-u",  # ⚠️ 强制 unbuffered stdout/stderr，前端实时日志依赖这个
        "-m",
        "strategy_dev.auto_tune.run_optuna_search",
        "--n-trials", str(job.n_trials_target),
        "--n-jobs", str(n_jobs),
        "--num-threads", str(num_threads),
        "--seed", str(seed),
        "--workdir", str(workdir),
        "--study-name", job.optuna_study_name,
        "--description-prefix", f"Workbench job {job.id}",
        # V3.1: trial 的 mlflow run_name / description 继承调参 job
        "--job-name", job.name,
    ]
    if job.description:
        cmd += ["--job-description", job.description]
    # V2/V3: 透传配置 override JSON + 单期标志（V3.1 删除 --bt-strategy-json）
    if extra_overrides:
        if extra_overrides.get("task_config"):
            cmd += ["--task-config-json", str(extra_overrides["task_config"])]
        if extra_overrides.get("custom_segments"):
            cmd += ["--custom-segments-json", str(extra_overrides["custom_segments"])]
        if extra_overrides.get("record_config"):
            cmd += ["--record-config-json", str(extra_overrides["record_config"])]
        if extra_overrides.get("search_space"):
            cmd += ["--search-space-json", str(extra_overrides["search_space"])]
        if extra_overrides.get("single_segment"):
            cmd += ["--single-segment"]
    return cmd


# ---------------------------------------------------------------------------
# Job 生命周期
# ---------------------------------------------------------------------------


def start_job_subprocess(
    db: Session,
    job: TuningJob,
    n_jobs: int = 1,
    num_threads: int = 20,
    seed: int = 42,
) -> TuningJob:
    """启动 Optuna subprocess。幂等：若 job 已 running，返回当前 pid 不重启。

    用户已强调"不影响现有功能"——subprocess 调用与命令行模式 100% 同链路：
    都是启 run_optuna_search.py，区别仅在 --workdir 指向 per-job 目录。
    """
    if job.status == "running" and is_pid_alive(job.pid, job.pid_started_at):
        return job  # 幂等：已在跑，直接返回

    workdir = get_job_workdir(job.id)
    workdir.mkdir(parents=True, exist_ok=True)

    # V2: 把 config_snapshot 拆成 4 个 JSON 文件供 train script 读取
    extra_overrides = _write_config_overrides(job, workdir)
    cmd = _build_subprocess_cmd(
        job, n_jobs=n_jobs, num_threads=num_threads, seed=seed,
        extra_overrides=extra_overrides,
    )
    log_path = workdir / "subprocess.stdout.log"
    job.log_path = str(log_path)
    job.optuna_study_db_path = str(workdir / "optuna_study.db")
    job.workdir = str(workdir)

    log_fp = open(log_path, "ab")
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,  # ⚠️ 必须 DEVNULL（Windows spawn 防 fork bomb）
        stdout=log_fp,
        stderr=subprocess.STDOUT,
        cwd=str(STRATEGY_DEV_ROOT),
        env={
            **os.environ,
            "PYTHONUNBUFFERED": "1",
            # ⚠️ Windows 默认 stdout 是 GBK，必须强制 UTF-8 否则前端日志中文乱码
            "PYTHONIOENCODING": "utf-8",
        },
    )

    # 持久化 pid + create_time
    try:
        psutil_proc = psutil.Process(proc.pid)
        job.pid_started_at = psutil_proc.create_time()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        job.pid_started_at = None
    job.pid = proc.pid
    job.status = "running"
    job.started_at = datetime.now()
    job.error = None
    db.commit()
    db.refresh(job)
    return job


def cancel_job_subprocess(db: Session, job: TuningJob, grace_sec: float = 5.0) -> TuningJob:
    """优雅取消：terminate 整个进程树 → grace → kill。

    Windows 上 subprocess 的 grandchild（run_optuna_search → train script
    → qlib 内部 multiprocessing 等）默认不在父进程的 ProcessGroup 里，
    单独 terminate 父进程不会传递到 grandchild。必须用 psutil.children
    递归收集所有子孙进程，逐一终止。
    """
    if job.status not in ("running", "searching"):
        return job
    if not is_pid_alive(job.pid, job.pid_started_at):
        # 进程已不存在，直接置 cancelled
        job.status = "cancelled"
        _finalize_job_timestamps(job)
        db.commit()
        db.refresh(job)
        return job

    try:
        parent = psutil.Process(job.pid)
        # 收集整棵进程树（含 grandchild）
        try:
            children = parent.children(recursive=True)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            children = []
        all_procs = [parent] + children

        # 全部 terminate（Windows 上 SIGTERM 等价 TerminateProcess）
        for p in all_procs:
            try:
                p.terminate()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        # 等待 grace_sec
        _, alive = psutil.wait_procs(all_procs, timeout=grace_sec)

        # 还活的强 kill
        for p in alive:
            try:
                p.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        if alive:
            psutil.wait_procs(alive, timeout=2.0)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass

    job.status = "cancelled"
    _finalize_job_timestamps(job)
    db.commit()
    db.refresh(job)
    return job


def reconcile_orphans(db: Session) -> Dict[str, int]:
    """FastAPI startup hook：扫所有 status=running 的 job，pid 不存在则置 zombie。

    防止 mlearnweb 后端 --reload 重启后留下的孤儿状态。
    """
    stats = {"checked": 0, "alive": 0, "zombie": 0}
    running_jobs = (
        db.query(TuningJob)
        .filter(TuningJob.status.in_(["running", "searching", "finalizing"]))
        .all()
    )
    stats["checked"] = len(running_jobs)
    for job in running_jobs:
        if is_pid_alive(job.pid, job.pid_started_at):
            stats["alive"] += 1
            continue
        # 进程已死但 status 还是 running → 标 zombie
        job.status = "zombie"
        job.error = (
            f"FastAPI 重启时发现 pid={job.pid} 不存在或 create_time 不匹配；"
            "实际 subprocess 已终止（可能 FastAPI 进程被 kill 时连带 kill）"
        )
        _finalize_job_timestamps(job)
        # 触发一次 csv 同步，把已完成的 trial 数据补完
        try:
            sync_trials_from_csv(db, job)
        except Exception as exc:  # noqa: BLE001
            print(f"[TuningService] zombie job {job.id} csv sync failed: {exc}")
        stats["zombie"] += 1
    db.commit()
    return stats


def _finalize_job_timestamps(job: TuningJob) -> None:
    if job.completed_at is None:
        job.completed_at = datetime.now()
    if job.started_at and job.duration_seconds is None:
        job.duration_seconds = (job.completed_at - job.started_at).total_seconds()


# ---------------------------------------------------------------------------
# trials.csv 增量同步到 tuning_trials 表
# ---------------------------------------------------------------------------


def _safe_float(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        f = float(v)
        if f != f:  # NaN
            return None
        return f
    except (TypeError, ValueError):
        return None


def _safe_int(v: Any) -> Optional[int]:
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _safe_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if v is None or v == "":
        return False
    return str(v).strip().lower() in ("true", "1", "yes")


def _safe_dt(v: Any) -> Optional[datetime]:
    if v is None or v == "":
        return None
    try:
        return datetime.fromisoformat(str(v))
    except ValueError:
        return None


def _csv_row_to_trial_fields(row: Dict[str, str]) -> Dict[str, Any]:
    """run_optuna_search 写 trials.csv 的列 → tuning_trials 表字段。"""
    # 10 个搜索参数
    params_keys = [
        "learning_rate", "num_leaves", "max_depth", "min_child_samples",
        "lambda_l1", "lambda_l2", "colsample_bytree", "subsample",
        "subsample_freq", "early_stopping_rounds",
    ]
    params: Dict[str, Any] = {}
    for k in params_keys:
        v = row.get(k, "")
        if v == "":
            continue
        if k in ("num_leaves", "max_depth", "min_child_samples",
                 "subsample_freq", "early_stopping_rounds"):
            params[k] = _safe_int(v)
        else:
            params[k] = _safe_float(v)

    # 全量指标进 metrics JSON（除参数 + 元数据列）
    excluded = set(params_keys) | {
        "trial_number", "trial_state", "run_id", "run_name",
        "started_at", "duration_sec", "subprocess_returncode", "error",
        "hard_constraint_passed", "hard_constraint_failed_items",
        "composite_score", "objective_value",
        "num_threads", "seed",
    }
    metrics = {k: _safe_float(v) for k, v in row.items() if k not in excluded and v != ""}

    # 4 评分列（来自 trials_summary 阶段计算的；run_optuna_search 写时仅有 composite_score）
    composite_scores: Dict[str, Optional[float]] = {
        "single": _safe_float(row.get("composite_score")),
    }

    failed_items = row.get("hard_constraint_failed_items", "")
    failed_list = [s for s in failed_items.split(";") if s] if failed_items else []

    return {
        "trial_number": _safe_int(row.get("trial_number")),
        "state": row.get("trial_state") or "unknown",
        "params": params,
        "metrics": metrics,
        "valid_sharpe": _safe_float(row.get("valid_sharpe")),
        "test_sharpe": _safe_float(row.get("test_sharpe")),
        "overfit_ratio": _safe_float(row.get("overfit_ratio")),
        "composite_scores": composite_scores,
        "hard_constraint_passed": _safe_bool(row.get("hard_constraint_passed")),
        "hard_constraint_failed_items": failed_list,
        "run_id": row.get("run_id") or None,
        "run_name": row.get("run_name") or None,
        "duration_sec": _safe_float(row.get("duration_sec")),
        "error": row.get("error") or None,
        "started_at": _safe_dt(row.get("started_at")),
    }


def sync_trials_from_csv(db: Session, job: TuningJob) -> int:
    """增量同步 per-job trials.csv 到 tuning_trials 表，返回新增/更新行数。

    幂等：trial_number 唯一索引，存在则 update，不存在则 insert。
    """
    csv_path = Path(job.workdir) / "trials.csv" if job.workdir else None
    if not csv_path or not csv_path.is_file():
        return 0

    try:
        with csv_path.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
    except OSError:
        return 0

    if not rows:
        return 0

    # 拉一次现有 trial map（trial_number → row）
    existing = {
        t.trial_number: t
        for t in db.query(TuningTrial).filter(TuningTrial.tuning_job_id == job.id).all()
    }

    n_changed = 0
    # 按 trial_number 去重统计：csv 同 trial 通常有 running + completed 多行；
    # 用户取消后重启 job 还会再次累加，所以 csv 行数 ≠ unique trial 数。
    # 用 dict 记每个 trial 的最终 state（"最后一行 wins" — csv 顺序就是写入顺序）
    final_state_by_trial: Dict[int, str] = {}
    best_value: Optional[float] = None
    best_number: Optional[int] = None

    for row in rows:
        fields = _csv_row_to_trial_fields(row)
        trial_number = fields["trial_number"]
        if trial_number is None:
            continue
        # 记最终状态 + 取最优（同 trial 多行时按 csv 顺序最后一次为准）
        final_state_by_trial[trial_number] = fields["state"]
        if fields["state"] == "completed":
            vs = fields["valid_sharpe"]
            if vs is not None and (best_value is None or vs > best_value):
                best_value = vs
                best_number = trial_number

        if trial_number in existing:
            t = existing[trial_number]
            for k, v in fields.items():
                if k == "trial_number":
                    continue
                setattr(t, k, v)
            flag_modified(t, "params")
            flag_modified(t, "metrics")
            flag_modified(t, "composite_scores")
            flag_modified(t, "hard_constraint_failed_items")
            n_changed += 1
        else:
            t = TuningTrial(tuning_job_id=job.id, **fields)
            db.add(t)
            # 关键修复：trials.csv 一个 trial 通常有 2 行（先 running 后 completed），
            # 把刚 add 的对象塞进 existing，下一行同 trial_number 走 UPDATE 分支，
            # 避免 commit 时 UNIQUE(tuning_job_id, trial_number) 冲突
            existing[trial_number] = t
            n_changed += 1

    # 按 unique trial_number 计数（不是 csv 行数）
    failed_states = {"failed", "metrics_missing", "no_run_index", "empty_run_index", "no_sharpe"}
    job.n_trials_done = sum(1 for s in final_state_by_trial.values() if s == "completed")
    job.n_trials_failed = sum(1 for s in final_state_by_trial.values() if s in failed_states)
    if best_number is not None:
        job.best_trial_number = best_number
        job.best_objective_value = best_value
    db.commit()
    return n_changed


def reconcile_job_status(db: Session, job: TuningJob) -> TuningJob:
    """根据 subprocess 是否存活 + trials 完成数，更新 job.status。

    在 GET /progress、GET /trials 等读端点调用前执行。
    """
    if job.status not in ("running", "searching"):
        return job
    if is_pid_alive(job.pid, job.pid_started_at):
        # 还在跑，仅同步 csv
        sync_trials_from_csv(db, job)
        return job

    # 进程已退出 → 同步最后一次 csv，标 done/failed
    sync_trials_from_csv(db, job)
    if job.n_trials_done >= job.n_trials_target:
        job.status = "done"
    elif job.n_trials_done > 0:
        # 部分完成（subprocess 异常退出但已有 trial 数据）
        job.status = "done"  # 算成功，因为有 trial 可用
    else:
        job.status = "failed"
        if not job.error:
            job.error = "subprocess 退出但未产生任何完成的 trial（看 subprocess.stdout.log 排查）"
    _finalize_job_timestamps(job)
    db.commit()
    db.refresh(job)
    return job


# ---------------------------------------------------------------------------
# 查询 helper
# ---------------------------------------------------------------------------


def get_job_progress(db: Session, job: TuningJob) -> Dict[str, Any]:
    """轻量进度（前端定期拉，避免 trials 表整体重传）"""
    reconcile_job_status(db, job)
    log_path = Path(job.log_path) if job.log_path else None
    last_offset = log_path.stat().st_size if log_path and log_path.is_file() else 0
    duration = None
    if job.started_at:
        end = job.completed_at or datetime.now()
        duration = (end - job.started_at).total_seconds()
    return {
        "job_id": job.id,
        "status": job.status,
        "n_trials_target": job.n_trials_target,
        "n_trials_done": job.n_trials_done,
        "n_trials_failed": job.n_trials_failed,
        "best_trial_number": job.best_trial_number,
        "best_objective_value": job.best_objective_value,
        "last_log_offset": last_offset,
        "duration_seconds": duration,
    }


def _read_tail(path: Path, tail_bytes: int) -> str:
    if not path.is_file():
        return ""
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            if size > tail_bytes:
                f.seek(size - tail_bytes)
            data = f.read()
        return data.decode("utf-8", errors="replace")
    except OSError:
        return ""


# ---------------------------------------------------------------------------
# Finalize：用 best trial 跑正式训练（写 training_records 表，与命令行同链路）
# ---------------------------------------------------------------------------


def finalize_job(
    db: Session,
    job: TuningJob,
    trial_number: int,
) -> int:
    """把指定 trial 已有的训练记录关联到 job（零成本，不重新训练）。

    设计变更（V3.5）：搜索过程中每个 trial subprocess 启动 train script 时
    没传 --training-record-id，走"单次模式" → 已经创建了独立 training_record
    + 5 期 run mapping。Finalize 不需要再跑一次完整训练（15 min），只需要
    通过 trial.run_id 在 training_run_mappings 反查回该 record，挂到
    job.finalized_training_record_id 即可。

    用户体验：
        点 Finalize → 立即返回 training_record_id → 跳训练记录页看 SHAP /
        收益曲线 / IC 分析等（与命令行训练同详情页）→ 走部署链路。

    异常路径：
        若 trial 没 run_id 或 mlearnweb 当时挂了导致没创建 training_record，
        抛 ValueError；用户可看 stdout 排查或重跑该 trial。
    """
    from app.models.database import TrainingRunMapping

    trial = (
        db.query(TuningTrial)
        .filter(
            TuningTrial.tuning_job_id == job.id,
            TuningTrial.trial_number == trial_number,
        )
        .first()
    )
    if not trial:
        raise ValueError(f"trial {trial_number} 不存在于 job {job.id}")
    if not trial.run_id:
        raise ValueError(
            f"trial {trial_number} 缺 run_id（mlflow run 未关联到 trial 行）；"
            f"请检查 trials.csv 的 run_id 列是否正确写入"
        )

    # 反查 training_run_mappings：trial 的 run_id（5 期之一）映射到该 trial
    # 创建的那条 training_record
    mapping = (
        db.query(TrainingRunMapping)
        .filter(TrainingRunMapping.run_id == trial.run_id)
        .first()
    )
    if not mapping:
        raise ValueError(
            f"trial {trial_number} run_id={trial.run_id} 在 training_run_mappings "
            f"中找不到对应记录；可能 mlearnweb 后端在该 trial 跑时不可用导致未写入。"
            f"建议重跑该 trial 或手动用命令行模式训练。"
        )

    record_id = mapping.training_record_id
    job.finalized_training_record_id = record_id
    db.commit()
    db.refresh(job)

    print(
        f"[TuningService] finalize job={job.id} trial={trial_number} "
        f"→ 索引到 training_record={record_id} (run_id={trial.run_id[:12]}...)"
    )
    return record_id


# ---------------------------------------------------------------------------
# Deploy：从工作台一键部署到 vnpy 实盘
# ---------------------------------------------------------------------------


# vnpy 实盘后端（mlearnweb 第二个进程）
LIVE_BACKEND_URL = os.environ.get(
    "MLEARNWEB_LIVE_URL",
    "http://localhost:8100",
)


MLRUNS_ROOT = Path(
    os.environ.get(
        "MLRUNS_ROOT",
        r"F:\Quant\code\qlib_strategy_dev\mlruns",
    )
)


def _build_deployment_manifest(
    db: Session, job: TuningJob
) -> Dict[str, Any]:
    """V3.6: 从 finalized training_record 实时计算 deployment manifest.

    替代之前依赖 finalize_best.export 预生成 deployment_manifest.json 的链路
    （V3.5 finalize 不再 subprocess，自然也不会预生成 json）。

    取最后一期（最新 test）run 作 production run；bundle_dir 指向其 artifacts/。
    """
    from app.models.database import TrainingRecord, TrainingRunMapping

    if not job.finalized_training_record_id:
        raise ValueError("job 尚未 finalize；请先 POST /finalize")
    rec = (
        db.query(TrainingRecord)
        .filter(TrainingRecord.id == job.finalized_training_record_id)
        .first()
    )
    if not rec:
        raise ValueError(
            f"finalized_training_record_id={job.finalized_training_record_id} 已不存在"
        )

    # 取该 record 下 rolling_index 最大的 mapping（即最后一期 = 最新 test 期）
    mapping = (
        db.query(TrainingRunMapping)
        .filter(TrainingRunMapping.training_record_id == rec.id)
        .order_by(TrainingRunMapping.rolling_index.desc().nulls_last())
        .first()
    )
    if not mapping or not mapping.run_id:
        raise ValueError(
            f"training_record={rec.id} 没有任何 run mapping；无法定位 mlflow run"
        )

    bundle_dir = MLRUNS_ROOT / rec.experiment_id / mapping.run_id / "artifacts"
    return {
        "schema_version": 1,
        "mlflow_run_id": mapping.run_id,
        "mlflow_experiment_id": rec.experiment_id,
        "bundle_dir": str(bundle_dir),
        "tuning_job_id": job.id,
        "training_record_id": rec.id,
    }


def deploy_job_to_vnpy(
    db: Session,
    job: TuningJob,
    *,
    node_id: str,
    engine: str,
    class_name: str,
    strategy_name: str,
    vt_symbol: Optional[str] = None,
    setting_overrides: Optional[Dict[str, Any]] = None,
    ops_password: Optional[str] = None,
) -> Dict[str, Any]:
    """V3.6: 从 finalized training_record 实时算 manifest，转调 vnpy live_trading API.

    重构要点：
        - 不依赖 deployment_manifest.json（V3.5 后 finalize 不再生成它）
        - 实时反查 training_run_mappings 拿最新一期 mlflow run + bundle_dir
        - HTTP 调 8100 加 retry（vnpy 节点重启 / 网络抖动场景）
    """
    import time as _time
    import httpx

    manifest = _build_deployment_manifest(db, job)

    # 拼 vnpy setting
    setting: Dict[str, Any] = {
        "mlflow_run_id": manifest["mlflow_run_id"],
        "bundle_dir": manifest["bundle_dir"],
        "tuning_job_id": job.id,
        "training_record_id": manifest["training_record_id"],
    }
    if setting_overrides:
        setting.update(setting_overrides)

    # 转调既有 vnpy create_strategy API
    headers = {}
    if ops_password:
        headers["X-Ops-Password"] = ops_password
    body = {
        "class_name": class_name,
        "strategy_name": strategy_name,
        "vt_symbol": vt_symbol,
        "setting": setting,
    }
    url = f"{LIVE_BACKEND_URL}/api/live-trading/strategies/{node_id}/{engine}"

    # V3.6: retry 3 次（指数退避），覆盖 vnpy 节点重启 / 短暂网络抖动场景
    last_exc: Optional[Exception] = None
    for attempt in range(3):
        try:
            with httpx.Client(timeout=30.0) as client:
                resp = client.post(url, json=body, headers=headers)
                resp.raise_for_status()
                result = resp.json()
            return {
                "training_record_id": job.finalized_training_record_id,
                "node_id": node_id,
                "engine": engine,
                "strategy_name": strategy_name,
                "vnpy_response": result,
                "manifest": manifest,
            }
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.HTTPStatusError) as exc:
            last_exc = exc
            print(
                f"[Deploy] attempt {attempt + 1}/3 failed: {type(exc).__name__}: {exc}"
            )
            if attempt < 2:
                _time.sleep(1.0 * (attempt + 1))  # 1s, 2s
    # 3 次都失败
    raise RuntimeError(
        f"vnpy 节点 {node_id} 不可达（重试 3 次后仍失败）: {last_exc}"
    ) from last_exc


def get_log_tail(job: TuningJob, tail_bytes: int = 16384, source: str = "tuning") -> str:
    """返回 subprocess 日志末尾若干字节（前端日志面板用）.

    Args:
        source:
            - "tuning": 仅 tuning.log（structured logger，trial 完成事件等关键日志）
            - "stdout": 仅 subprocess.stdout.log（原始 stdout，含 startup 信息）
            - "all":    两个合并展示（tuning.log 优先，stdout 兜底）
    """
    if not job.workdir:
        # 兼容旧 job 没记 workdir
        if job.log_path and Path(job.log_path).is_file():
            return _read_tail(Path(job.log_path), tail_bytes)
        return ""

    workdir = Path(job.workdir)
    tuning_log = workdir / "tuning.log"
    stdout_log = workdir / "subprocess.stdout.log"

    if source == "tuning":
        return _read_tail(tuning_log, tail_bytes)
    if source == "stdout":
        return _read_tail(stdout_log, tail_bytes)
    # "all": 拼接，per-source 各取一半 tail
    half = max(tail_bytes // 2, 4096)
    parts = []
    tuning_text = _read_tail(tuning_log, half)
    if tuning_text:
        parts.append(f"=== tuning.log (last {half} bytes) ===\n{tuning_text}")
    stdout_text = _read_tail(stdout_log, half)
    if stdout_text:
        parts.append(f"\n=== subprocess.stdout.log (last {half} bytes) ===\n{stdout_text}")
    return "\n".join(parts) if parts else ""


# ---------------------------------------------------------------------------
# V3.3 搜索任务队列调度
# ---------------------------------------------------------------------------


def _runner_busy(db: Session) -> Optional[TuningJob]:
    """检查是否有 job 在占用 runner（mlflow file backend 一次只能有 1 个跑）。

    返回正在跑的 job（pid 仍存活），None 表示 runner 空闲。已死的 running job
    会被忽略（应由 reconcile_orphans 标 zombie，不阻塞队列）。
    """
    busy = (
        db.query(TuningJob)
        .filter(TuningJob.status.in_(["running", "searching", "finalizing"]))
        .all()
    )
    for job in busy:
        if is_pid_alive(job.pid, job.pid_started_at):
            return job
    return None


def enqueue_job(db: Session, job: TuningJob) -> TuningJob:
    """把 job 加入队尾。queue_position = max(existing) + 1，没有就是 1。

    仅 status='created' 的草稿 job 允许入队 — 队列语义是"待启动的 job 等
    scheduler 自动跑"，已 done/cancelled/failed/zombie 的应由用户手动决策
    （重启 / 删除 / 检查），不应被自动调度污染。
    """
    if job.queue_position is not None:
        return job  # 幂等
    if job.status != "created":
        raise ValueError(
            f"job 状态 {job.status} 不允许入队（仅 created 草稿可入队；"
            f"已运行过的 job 请用 重新启动 按钮）"
        )
    max_pos = db.query(func.max(TuningJob.queue_position)).scalar()
    job.queue_position = (max_pos or 0) + 1
    db.commit()
    db.refresh(job)
    return job


def dequeue_job(db: Session, job: TuningJob) -> TuningJob:
    """把 job 移出队列（不影响其 status）。"""
    if job.queue_position is None:
        return job
    job.queue_position = None
    db.commit()
    db.refresh(job)
    return job


def reorder_queue(db: Session, job_ids: List[int]) -> List[TuningJob]:
    """按 job_ids 顺序重排队列：依次赋 queue_position = 1, 2, 3, ...

    未在 job_ids 里的队列 job 会被踢出（queue_position=None），实现"全量替换"
    语义；前端前先 GET 当前队列即可知道全集。
    """
    # 当前队列里的全部 job
    current = (
        db.query(TuningJob)
        .filter(TuningJob.queue_position.isnot(None))
        .all()
    )
    current_map = {j.id: j for j in current}

    # 验证 job_ids 都存在且符合可入队状态（仅 created 草稿）
    new_jobs: List[TuningJob] = []
    for jid in job_ids:
        j = current_map.get(jid) or db.query(TuningJob).filter(TuningJob.id == jid).first()
        if not j:
            raise ValueError(f"job {jid} 不存在")
        if j.status != "created":
            raise ValueError(f"job {jid} 状态 {j.status} 不允许入队（仅 created 草稿可入队）")
        new_jobs.append(j)

    # 先把所有当前队列 job 的 queue_position 清空
    for j in current:
        j.queue_position = None
    db.flush()

    # 按 job_ids 顺序重新赋 1..N
    for idx, j in enumerate(new_jobs, start=1):
        j.queue_position = idx
    db.commit()
    return new_jobs


def get_queued_jobs(db: Session) -> List[TuningJob]:
    """返回当前队列里的全部 job（按 queue_position ASC）。"""
    return (
        db.query(TuningJob)
        .filter(TuningJob.queue_position.isnot(None))
        .order_by(TuningJob.queue_position.asc(), TuningJob.id.asc())
        .all()
    )


def try_start_next_queued_job(db: Session) -> Optional[TuningJob]:
    """scheduler 单次 tick：runner 空闲且有队首 → 启动队首并出队，否则 no-op。

    返回启动的 job，None 表示 no-op。
    """
    if _runner_busy(db):
        return None
    next_job = (
        db.query(TuningJob)
        .filter(
            TuningJob.queue_position.isnot(None),
            TuningJob.status == "created",
        )
        .order_by(TuningJob.queue_position.asc(), TuningJob.id.asc())
        .first()
    )
    if not next_job:
        return None

    # 出队（即使后续 start 失败也不再重试，避免死循环）
    print(
        f"[QueueScheduler] auto-starting queued job {next_job.id} "
        f"(queue_position={next_job.queue_position}, name={next_job.name!r})"
    )
    next_job.queue_position = None
    db.commit()

    try:
        return start_job_subprocess(
            db,
            next_job,
            n_jobs=next_job.start_n_jobs or 1,
            num_threads=next_job.start_num_threads or 20,
            seed=next_job.start_seed or 42,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[QueueScheduler] start failed for job {next_job.id}: {exc}")
        next_job.status = "failed"
        next_job.error = f"队列调度启动失败: {exc}"
        db.commit()
        return None


# ---------------------------------------------------------------------------
# V3.7 跨期验证 + 多 seed 复跑（post-search 验证作为衍生 job）
# ---------------------------------------------------------------------------


def create_verification_job(
    db: Session,
    source_job: TuningJob,
    trial_numbers: List[int],
    custom_segments: List[Dict[str, Any]],
    seed: int = 42,
    num_threads: int = 20,
    reproduce_seeds: Optional[List[int]] = None,
) -> TuningJob:
    """V3.7: 创建跨期验证衍生 job（单期搜索 → walk-forward 验证作为新 job）。

    设计：验证不再是源 job 内 inplace 子进程，而是新 TuningJob：
        - parent_job_id 指向源 job
        - derived_trial_numbers 记录用户选的源 trial 编号
        - config_snapshot 继承源 + 必填 custom_segments
        - search_mode='walk_forward_5p' 但走 post_search_runner（不走 optuna）
        - subprocess 立即启动；前端跳到新 job 的 MonitorPage

    需要 source job 有 trials.csv + overrides/trial_NNNN.json 文件（验证子进程
    通过 finalize_best.cmd_walk_forward 读这两个反查每个 trial 的 GBDT 超参）。
    """
    import shutil

    # ---- 校验 ----
    if not trial_numbers:
        raise ValueError("trial_numbers 不能为空")
    if not custom_segments or len(custom_segments) < 2:
        raise ValueError("custom_segments 必须至少 2 期（建议 5 期跨多个 regime）")
    if not source_job.workdir:
        raise ValueError(f"源 job {source_job.id} 缺 workdir（搜索未启动过？）")

    source_workdir = Path(source_job.workdir)
    source_trials_csv = source_workdir / "trials.csv"
    source_overrides = source_workdir / "overrides"
    if not source_trials_csv.is_file():
        raise ValueError(
            f"源 job {source_job.id} 缺 trials.csv（路径 {source_trials_csv}）；"
            f"无法反查 trial 超参"
        )
    if not source_overrides.is_dir():
        raise ValueError(f"源 job {source_job.id} 缺 overrides/ 目录")

    # 校验所选 trial_numbers 在源中存在
    existing_trials = {
        t.trial_number
        for t in db.query(TuningTrial)
        .filter(TuningTrial.tuning_job_id == source_job.id)
        .all()
    }
    missing = set(trial_numbers) - existing_trials
    if missing:
        raise ValueError(f"源 job 中以下 trial 不存在: {sorted(missing)}")

    # ---- 创建衍生 job DB 行 ----
    n_total = len(trial_numbers)
    if reproduce_seeds:
        # 复跑会再做 trial × seed 次额外训练，但 trials.csv 仍是 N 行（每 trial 聚合）
        verification_name = (
            f"{source_job.name} - 跨期验证+复跑 ({n_total} trial × {len(reproduce_seeds)} seed)"
        )
    else:
        verification_name = f"{source_job.name} - 跨期验证 ({n_total} trial × 5 期)"

    # config_snapshot 继承源 + 用户指定的 custom_segments
    base_cfg = source_job.config_snapshot or {}
    new_cfg = dict(base_cfg)  # shallow copy（含 task_config / record_config 等）
    new_cfg["custom_segments"] = custom_segments

    description = (
        f"由源 job #{source_job.id} 衍生：对 trial {trial_numbers} 跑 walk-forward 验证；"
        f"用源 job 的 task_config / record_config + 用户指定的 {len(custom_segments)} 期"
    )
    if reproduce_seeds:
        description += f"；同时跑 multi-seed reproduce (seeds={reproduce_seeds})"

    study_name = f"verification_job_{int(time.time() * 1000)}"
    derived_job = TuningJob(
        name=verification_name,
        description=description,
        status="created",
        search_mode="walk_forward_5p",
        config_snapshot=new_cfg,
        optuna_study_name=study_name,
        optuna_study_db_path="",  # 验证模式不用 optuna
        workdir="",  # start_job_subprocess 会填
        n_trials_target=n_total,
        start_n_jobs=1,
        start_num_threads=num_threads,
        start_seed=seed,
        experiment_id=source_job.experiment_id,
        parent_job_id=source_job.id,
        derived_trial_numbers=list(trial_numbers),
    )
    db.add(derived_job)
    db.commit()
    db.refresh(derived_job)

    # ---- 准备衍生 job 的 workdir ----
    # V3.7 修：仅复制 overrides/ 文件（每 trial 一个 JSON 含完整 SEARCH_PARAM_KEYS），
    # 不复制源 trials.csv —— 否则 sync_trials_from_csv 会把源 70 行旧数据当成
    # 验证 job 的 progress（n_trials_done=70）。验证 job 自己的 trials.csv 由
    # cmd_walk_forward 跑完后写入（5 行）。
    derived_workdir = get_job_workdir(derived_job.id)
    derived_workdir.mkdir(parents=True, exist_ok=True)
    (derived_workdir / "overrides").mkdir(exist_ok=True)
    (derived_workdir / "run_index").mkdir(exist_ok=True)

    for tnum in trial_numbers:
        src = source_overrides / f"trial_{tnum:04d}.json"
        if not src.is_file():
            raise ValueError(
                f"源 job {source_job.id} 缺 overrides/trial_{tnum:04d}.json；"
                f"无法获取 trial {tnum} 的 GBDT 超参"
            )
        shutil.copy(src, derived_workdir / "overrides" / src.name)

    # ---- 启动 subprocess（reproduce_seeds 通过环境编码传入 start_job_subprocess）----
    derived_job.workdir = str(derived_workdir)
    db.commit()

    start_verification_subprocess(
        db, derived_job,
        trial_numbers=trial_numbers,
        seed=seed,
        num_threads=num_threads,
        reproduce_seeds=reproduce_seeds,
    )
    return derived_job


def start_verification_subprocess(
    db: Session,
    job: TuningJob,
    trial_numbers: List[int],
    seed: int = 42,
    num_threads: int = 20,
    reproduce_seeds: Optional[List[int]] = None,
) -> Dict[str, Any]:
    """V3.7: 启动验证 job 的 post_search_runner 子进程.

    与旧 start_walk_forward_subprocess 区别：
        - 这是衍生 job 自己的 subprocess（写自己 workdir 的 walk_forward.csv 和
          trials.csv），不是源 job 内 inplace 跑
        - 把验证 job 的 task_config / custom_segments / record_config 写成 JSON
          文件，透传给 train script
        - 用 job.pid 而不是内存 registry（与正常搜索 job 一致，复用 reconcile_orphans）
    """
    if not job.workdir:
        raise ValueError(f"verification job {job.id} 缺 workdir")
    workdir = Path(job.workdir)

    # 写出 task_config / custom_segments / record_config JSON（透传给 train script）
    cfg = job.config_snapshot or {}
    overrides_dir = workdir / "config_overrides"
    overrides_dir.mkdir(parents=True, exist_ok=True)
    config_args: List[str] = []

    def _write(key: str, fname: str) -> Optional[Path]:
        v = cfg.get(key)
        if v is None or (isinstance(v, (list, dict)) and len(v) == 0):
            return None
        p = overrides_dir / fname
        p.write_text(json.dumps(v, ensure_ascii=False, indent=2), encoding="utf-8")
        return p

    if (p := _write("task_config", "task_config.json")) is not None:
        config_args += ["--task-config-json", str(p)]
    if (p := _write("custom_segments", "custom_segments.json")) is not None:
        config_args += ["--custom-segments-json", str(p)]
    if (p := _write("record_config", "record_config.json")) is not None:
        config_args += ["--record-config-json", str(p)]
    # V3.7: 把验证 job 自身的 name / description 透传，让每个子训练的 run_name
    # / description 跟搜索 job 风格一致（"<job-name> #<trial> walkforward s<seed>"）
    if job.name:
        config_args += ["--job-name", job.name]
    if job.description:
        config_args += ["--job-description", job.description]

    cmd = [
        TUNING_PYTHON_EXE,
        "-u",
        "-m",
        "strategy_dev.auto_tune.post_search_runner",
        "--workdir", str(workdir),
        "--trial-ids", ",".join(str(t) for t in trial_numbers),
        "--seed", str(seed),
        "--num-threads", str(num_threads),
    ] + config_args
    if reproduce_seeds:
        cmd += ["--reproduce-seeds", ",".join(str(s) for s in reproduce_seeds)]

    # V3.7 修：日志写到 subprocess.stdout.log（与搜索 job 一致）
    # 让 MonitorPage 的实时日志面板能直接读到（不必为验证 job 区分 log 文件名）
    log_path = workdir / "subprocess.stdout.log"
    job.log_path = str(log_path)
    log_fp = open(log_path, "ab")
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=log_fp,
        stderr=subprocess.STDOUT,
        cwd=str(STRATEGY_DEV_ROOT),
        env={
            **os.environ,
            "PYTHONUNBUFFERED": "1",
            "PYTHONIOENCODING": "utf-8",
        },
    )
    try:
        psutil_proc = psutil.Process(proc.pid)
        job.pid_started_at = psutil_proc.create_time()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        job.pid_started_at = None
    job.pid = proc.pid
    job.status = "running"
    job.started_at = datetime.now()
    job.error = None
    db.commit()
    db.refresh(job)

    print(
        f"[TuningService] verification job {job.id} 已启动 pid={proc.pid} "
        f"trial_numbers={trial_numbers} reproduce_seeds={reproduce_seeds} log={log_path}"
    )
    return {
        "job_id": job.id,
        "status": "started",
        "pid": proc.pid,
        "log_path": str(log_path),
        "trial_numbers": trial_numbers,
        "reproduce_seeds": reproduce_seeds,
    }


def get_derived_jobs(db: Session, parent_job_id: int) -> List[TuningJob]:
    """V3.7: 返回某 source job 的所有衍生验证 job（按创建时间倒序）。"""
    return (
        db.query(TuningJob)
        .filter(TuningJob.parent_job_id == parent_job_id)
        .order_by(TuningJob.created_at.desc())
        .all()
    )


def get_walk_forward_subprocess_status(job: TuningJob) -> Dict[str, Any]:
    """V3.7: 查衍生 job 的 verification 子进程是否还活着（用 job.pid 而非内存 registry）。"""
    if not job.pid:
        return {"running": False, "pid": None}
    alive = is_pid_alive(job.pid, job.pid_started_at)
    return {"running": alive, "pid": job.pid}


def _parse_walk_forward_csv(workdir: Path) -> List[Dict[str, Any]]:
    """读 walk_forward.csv → list of dict（每个 trial 一行，含跨期 valid/test sharpe 等）"""
    csv_path = workdir / "walk_forward.csv"
    if not csv_path.is_file():
        return []
    rows: List[Dict[str, Any]] = []
    try:
        with csv_path.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                parsed: Dict[str, Any] = {}
                for k, v in row.items():
                    if v == "" or v is None:
                        parsed[k] = None
                    elif k in ("valid_sharpe_per_period", "test_sharpe_per_period"):
                        # 这两列是 JSON 序列化的 list
                        try:
                            parsed[k] = json.loads(v)
                        except (TypeError, ValueError):
                            parsed[k] = None
                    elif k in ("trial_id", "n_periods", "cross_period_pass_count",
                               "worst_period_idx", "subprocess_returncode"):
                        parsed[k] = _safe_int(v)
                    elif k in ("seed", "duration_sec"):
                        parsed[k] = _safe_float(v)
                    elif k == "all_positive":
                        parsed[k] = _safe_bool(v)
                    elif k in ("run_name", "run_ids", "error"):
                        parsed[k] = v
                    else:
                        parsed[k] = _safe_float(v)
                rows.append(parsed)
    except OSError:
        return []
    return rows


def _parse_reproduce_csv(workdir: Path) -> List[Dict[str, Any]]:
    """读 reproduce.csv → list of dict（每个 (trial_id, seed) 组合一行）。"""
    csv_path = workdir / "reproduce.csv"
    if not csv_path.is_file():
        return []
    rows: List[Dict[str, Any]] = []
    try:
        with csv_path.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                parsed: Dict[str, Any] = {}
                for k, v in row.items():
                    if v == "" or v is None:
                        parsed[k] = None
                    elif k in ("trial_id", "seed", "subprocess_returncode"):
                        parsed[k] = _safe_int(v)
                    elif k == "hard_constraint_passed":
                        parsed[k] = _safe_bool(v)
                    elif k in ("run_name", "run_id", "error", "hard_constraint_failed_items"):
                        parsed[k] = v
                    else:
                        parsed[k] = _safe_float(v)
                rows.append(parsed)
    except OSError:
        return []
    return rows


def _aggregate_reproduce_by_trial(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """对 reproduce 行按 trial_id 聚合 (mean / std / min / max of valid_sharpe + test_sharpe)。"""
    import statistics

    by_trial: Dict[int, List[Dict[str, Any]]] = {}
    for r in rows:
        tid = r.get("trial_id")
        if tid is None:
            continue
        by_trial.setdefault(int(tid), []).append(r)

    agg: List[Dict[str, Any]] = []
    for tid, sub_rows in sorted(by_trial.items()):
        def _vals(key: str) -> List[float]:
            return [r[key] for r in sub_rows if r.get(key) is not None]

        # reproduce.csv 仅记录 test_sharpe（cmd_reproduce 的当前实现）；
        # valid_sharpe 列可能不在；如果未来加上则同步聚合
        def _stats(key: str) -> Dict[str, Optional[float]]:
            vals = _vals(key)
            if not vals:
                return {"n": 0, "mean": None, "std": None, "min": None, "max": None, "median": None}
            return {
                "n": len(vals),
                "mean": sum(vals) / len(vals),
                "std": statistics.pstdev(vals) if len(vals) >= 2 else 0.0,
                "min": min(vals),
                "max": max(vals),
                "median": statistics.median(vals),
            }

        hard_pass_count = sum(1 for r in sub_rows if r.get("hard_constraint_passed"))
        agg.append({
            "trial_id": tid,
            "n_seeds": len(sub_rows),
            "hard_pass_count": hard_pass_count,
            "test_sharpe": _stats("test_sharpe"),
            "test_max_drawdown": _stats("test_max_drawdown"),
            "test_annualized_return": _stats("test_annualized_return"),
            "overfit_ratio": _stats("overfit_ratio"),
            "rows": sub_rows,
        })
    return agg


def get_walk_forward_results(job: TuningJob) -> Dict[str, Any]:
    """读 walk_forward.csv + reproduce.csv（如有）返 JSON 给前端渲染。"""
    if not job.workdir:
        return {
            "job_id": job.id,
            "running": False,
            "walk_forward": [],
            "reproduce": [],
            "reproduce_aggregate": [],
            "summary_md": None,
        }
    workdir = Path(job.workdir)
    wf_rows = _parse_walk_forward_csv(workdir)
    rep_rows = _parse_reproduce_csv(workdir)
    rep_agg = _aggregate_reproduce_by_trial(rep_rows) if rep_rows else []

    summary_md_path = workdir / "walk_forward_summary.md"
    summary_md = (
        summary_md_path.read_text(encoding="utf-8") if summary_md_path.is_file() else None
    )

    status = get_walk_forward_subprocess_status(job)
    return {
        "job_id": job.id,
        "running": status["running"],
        "pid": status["pid"],
        "walk_forward": wf_rows,
        "reproduce": rep_rows,
        "reproduce_aggregate": rep_agg,
        "summary_md": summary_md,
    }


def get_walk_forward_log(job: TuningJob, tail_bytes: int = 16384) -> str:
    """读 walk_forward.stdout.log 末尾。"""
    if not job.workdir:
        return ""
    return _read_tail(Path(job.workdir) / "walk_forward.stdout.log", tail_bytes)


# ---------------------------------------------------------------------------
# V3.3 队列 scheduler async loop（接续）
# ---------------------------------------------------------------------------


async def queue_scheduler_loop(get_db_session_func, interval_sec: float = 30.0) -> None:
    """后台 asyncio 任务：每 interval_sec 秒 tick 一次队列调度。

    设计要点：
        - 单 worker uvicorn + 单事件循环 → 不用锁
        - 串行启动：runner busy 时跳过，等下一 tick
        - 例外不破坏循环：单次 tick 异常打印继续，不抛
    """
    print(f"[QueueScheduler] 启动 (interval={interval_sec}s)")
    while True:
        try:
            db = next(get_db_session_func())
            try:
                try_start_next_queued_job(db)
            finally:
                db.close()
        except Exception as exc:  # noqa: BLE001
            print(f"[QueueScheduler] tick error: {exc}")
        await asyncio.sleep(interval_sec)
