"""调参作业（auto_tune Optuna study）管理服务.

职责:
    1. subprocess 生命周期：启动 / 取消 / 孤儿恢复
    2. 增量解析 per-job trials.csv → 同步到 tuning_trials 表
    3. 计算 best trial 并维护 tuning_jobs 进度字段

设计:
    - subprocess 用 Popen（不用 asyncio）：与现有同步 FastAPI 风格一致
    - 不常驻同步线程：前端轮询 /progress 时按需触发 csv → DB 同步
    - per-job workdir 隔离（auto_tune/runs/<job_id>/），避免多 job 串扰

不在本 service 范围内：
    - SSE 推送（在 router 层用 sse-starlette 实现）
    - 一键部署到 vnpy（POST /deploy 直接转调既有 live_trading 接口）
"""

from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import psutil
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
        "bt_strategy": None,
        "record_config": None,
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
    out["bt_strategy"] = _write("bt_strategy", "bt_strategy.json")
    out["record_config"] = _write("record_config", "record_config.json")
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
    ]
    # V2: 透传 4 类配置 override JSON + 单期标志
    if extra_overrides:
        if extra_overrides.get("task_config"):
            cmd += ["--task-config-json", str(extra_overrides["task_config"])]
        if extra_overrides.get("custom_segments"):
            cmd += ["--custom-segments-json", str(extra_overrides["custom_segments"])]
        if extra_overrides.get("bt_strategy"):
            cmd += ["--bt-strategy-json", str(extra_overrides["bt_strategy"])]
        if extra_overrides.get("record_config"):
            cmd += ["--record-config-json", str(extra_overrides["record_config"])]
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
    n_done = 0
    n_failed = 0
    best_value: Optional[float] = None
    best_number: Optional[int] = None

    for row in rows:
        fields = _csv_row_to_trial_fields(row)
        trial_number = fields["trial_number"]
        if trial_number is None:
            continue
        if fields["state"] == "completed":
            n_done += 1
            vs = fields["valid_sharpe"]
            if vs is not None and (best_value is None or vs > best_value):
                best_value = vs
                best_number = trial_number
        elif fields["state"] in ("failed", "metrics_missing", "no_run_index", "empty_run_index", "no_sharpe"):
            n_failed += 1

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
            n_changed += 1

    job.n_trials_done = n_done
    job.n_trials_failed = n_failed
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
    seed: int = 42,
    num_threads: int = 20,
    name: Optional[str] = None,
    description: Optional[str] = None,
) -> int:
    """用指定 trial 的超参跑一次正式训练，结果写入 training_records 表。

    与命令行模式 100% 同链路：调用 tushare_hs300_rolling_train.py +
    --training-record-id <id> 参数，让 RollingPipeline 内部的
    DashboardRecorder 在 batch 模式下追加 run mapping，与
    dashboard_batch.py start/finish 流程行为一致。

    完成后 finalize_training_record 会出现在 / (TrainingRecordsPage)，
    用户能像看任何普通训练一样看 train/valid/test 三段全部 artifacts。
    """
    from app.services.training_service import TrainingService

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
    if not trial.params:
        raise ValueError(f"trial {trial_number} 缺少 params")

    workdir = Path(job.workdir) if job.workdir else get_job_workdir(job.id)
    workdir.mkdir(parents=True, exist_ok=True)

    # 写 best_params.json（含 num_threads + seed，与 finalize_best.export 同格式）
    overrides = {**trial.params, "num_threads": num_threads, "seed": seed}
    overrides_path = workdir / "finalize_best_params.json"
    overrides_path.write_text(
        json.dumps(overrides, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    record_name = name or f"Tuning Job #{job.id} best (trial {trial_number})"
    record_desc = description or (
        f"由调参工作台 finalize：用 trial {trial_number} 最佳超参跑正式训练；"
        f"valid_sharpe={trial.valid_sharpe} test_sharpe={trial.test_sharpe}"
    )
    # experiment_id 从既有 mlflow run 复用（保证 train script 创建的 run 落到同 experiment）
    experiment_id = "374089520733232109"  # qlib_strategy_dev 默认 rolling_exp
    experiment_name = "rolling_exp"
    category = "rolling" if job.search_mode == "walk_forward_5p" else "single"

    record = TrainingService.create_record(
        db=db,
        name=record_name,
        experiment_id=experiment_id,
        experiment_name=experiment_name,
        description=record_desc,
        category=category,
        config_snapshot={
            "_finalized_from_tuning_job": job.id,
            "tuning_trial_number": trial_number,
            "tuning_seed": seed,
            "params": overrides,
            "best_valid_sharpe": trial.valid_sharpe,
            "best_test_sharpe": trial.test_sharpe,
            "search_mode": job.search_mode,
        },
        command_line=(
            f"finalize: tushare_hs300_rolling_train.py --training-record-id <id> "
            f"--gbdt-overrides {overrides_path.name} --with-multi-segment"
        ),
    )

    # 启动 train subprocess（独立后台，不阻塞 API）
    cmd = [
        TUNING_PYTHON_EXE,
        "-u",
        str(STRATEGY_DEV_ROOT / "strategy_dev" / "tushare_hs300_rolling_train.py"),
        "--name", record_name,
        "--description", record_desc,
        "--with-multi-segment",
        "--gbdt-overrides", str(overrides_path),
        "--training-record-id", str(record.id),  # ← 关键：与命令行模式同链路
    ]
    finalize_log = workdir / f"finalize_record_{record.id}.stdout.log"
    log_fp = open(finalize_log, "ab")
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

    # 更新 job 元数据
    job.finalized_training_record_id = record.id
    job.status = "finalizing"
    db.commit()

    print(
        f"[TuningService] finalize job={job.id} trial={trial_number} "
        f"→ training_record={record.id} pid={proc.pid}"
    )
    return record.id


# ---------------------------------------------------------------------------
# Deploy：从工作台一键部署到 vnpy 实盘
# ---------------------------------------------------------------------------


# vnpy 实盘后端（mlearnweb 第二个进程）
LIVE_BACKEND_URL = os.environ.get(
    "MLEARNWEB_LIVE_URL",
    "http://localhost:8100",
)


def deploy_job_to_vnpy(
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
    """从 finalize 产物组装 vnpy setting 并转调既有 live_trading API.

    前提：job 必须已 finalize（finalized_training_record_id 不为空），
    可从 deployment_manifest.json 读 mlflow_run_id + bundle_dir。
    """
    import httpx

    if not job.finalized_training_record_id:
        raise ValueError("job 尚未 finalize；请先 POST /finalize 完成正式训练")

    workdir = Path(job.workdir) if job.workdir else get_job_workdir(job.id)
    manifest_path = workdir / "deployment_manifest.json"

    # 如果 manifest 还没生成（finalize subprocess 还没跑完），用 trial.run_id 兜底
    if not manifest_path.is_file():
        # 从 finalized training_record 反查最新 run_id（主 run）
        from app.models.database import TrainingRunMapping
        # 这里需要 db 但当前函数不接 db，暂时让调用方传入
        raise ValueError(
            f"deployment_manifest.json 不存在于 {workdir}；"
            "请等 finalize subprocess 完成（看 finalize_record_*.stdout.log）"
        )

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # 拼 vnpy setting
    setting: Dict[str, Any] = {
        "mlflow_run_id": manifest.get("mlflow_run_id"),
        "bundle_dir": manifest.get("bundle_dir"),
        "tuning_job_id": job.id,
        "tuning_trial_number": manifest.get("trial_id"),
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
    }


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
