"""聚宽（JoinQuant）持仓 JSON 导出 service。

从 training_record 关联的 mlflow run 读 portfolio_analysis/positions_normal_1day.pkl，
转成聚宽兼容的 ``{date: {SHxxxxxx: {weight, stock_name}}}`` JSON，落盘到
``settings.joinquant_export_dir`` 并在 ``joinquant_exports`` 表索引。

设计选择
--------
- **不直接 import** ``strategy_dev/backtest.py``：相对路径耦合 + 内嵌 matplotlib
  使其 web 后端 headless 不友好，纯计算部分在此重写为 ``_build_position_dict``。
- 仍用文件存储而非 mlflow artifact：详见 ``mlearnweb/docs/plan/`` 的方案 2 评估。
- 同步生成（v1）：单次 1-5s，30s sanity timeout；将来真长任务再加 BackgroundTask。
- 原子写：``tempfile + os.replace``，规避并发半截文件。
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

import pandas as pd
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.database import JoinquantExport, TrainingRecord, TrainingRunMapping
from app.utils.mlflow_reader import MLFlowReader

logger = logging.getLogger(__name__)


class JoinquantExportError(Exception):
    """业务级错误：record 不存在 / 全部 run 缺 pkl 等不应进入 status='ok' 的失败。"""


# ---------------------------------------------------------------------------
# Pure builder — 与 strategy_dev/backtest.py:position_analysis 前 50 行等价
# ---------------------------------------------------------------------------


def _qlib_to_joinquant_symbol(qlib_symbol: str) -> Optional[str]:
    """qlib 'AAAAAA.XSHG' / 'AAAAAA.SH' → 聚宽 'SHAAAAAA'。

    无 '.' 的 symbol（如 'cash'）返 None，由调用方 skip。
    未知交易所后缀 → None + log warn（与 notebook 抛 ValueError 不同；服务化场景
    宁愿 skip 一只股票也不让整次导出失败，影响面小）。
    """
    if "." not in qlib_symbol:
        return None
    base, suffix = qlib_symbol.split(".", 1)
    su = suffix.upper()
    if su in ("XSHG", "SH"):
        return f"SH{base}"
    if su in ("XSHE", "SZ"):
        return f"SZ{base}"
    logger.warning("[joinquant_export] unknown exchange suffix: %s", qlib_symbol)
    return None


def _build_position_dict(positions_pkl: Mapping[Any, Any]) -> Tuple[Dict[str, Dict[str, Dict[str, Any]]], int, int]:
    """聚合 qlib positions pkl → 聚宽兼容 dict。

    Input
    -----
    positions_pkl : ``Mapping[date_like, qlib.PortfolioMetrics or similar]``
        来自 ``portfolio_analysis/positions_normal_1day.pkl``。每个 value 期望有
        ``.position`` 属性 (Mapping[symbol, {'weight': float, ...}])。

    Returns
    -------
    (result, n_dates, n_symbols_total)
        result: ``{"YYYY-MM-DD": {"SH600000": {"weight": 0.142857, "stock_name": "SH600000"}}}``
        n_dates: 有效日期数
        n_symbols_total: 全部 (date, symbol) 对的总数（信息用，与 weight 求和无关）
    """
    # 与 backtest.py 同源：date 升序聚合，确保跨期 update 行为可预测
    sorted_items = sorted(positions_pkl.items(), key=lambda kv: kv[0])
    result: Dict[str, Dict[str, Dict[str, Any]]] = {}
    n_symbols_total = 0
    for date_key, position_obj in sorted_items:
        if not hasattr(position_obj, "position"):
            continue  # qlib 偶尔会塞非持仓对象（如 cash 摘要），skip
        date_str = pd.Timestamp(date_key).strftime("%Y-%m-%d")
        if date_str not in result:
            result[date_str] = {}
        for sym, value in position_obj.position.items():
            jq = _qlib_to_joinquant_symbol(str(sym))
            if jq is None:
                continue
            try:
                weight = float(value["weight"])
            except (KeyError, TypeError, ValueError):
                continue
            result[date_str][jq] = {
                "weight": round(weight, 6),
                "stock_name": jq,
            }
            n_symbols_total += 1
    return result, len(result), n_symbols_total


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def generate_export(
    record_id: int,
    db: Session,
    *,
    created_by: Optional[str] = None,
) -> JoinquantExport:
    """触发导出：读 record 全部 run 的 positions pkl，聚合，落盘，索引入 DB。

    流式聚合：每读一期立刻 update 到结果 dict，不持有原 pkl 句柄，规避滚动 50 期
    撑爆内存。
    """
    record = db.query(TrainingRecord).filter(TrainingRecord.id == record_id).first()
    if record is None:
        raise JoinquantExportError(f"训练记录 {record_id} 不存在")

    mappings: List[TrainingRunMapping] = (
        db.query(TrainingRunMapping)
        .filter(TrainingRunMapping.training_record_id == record_id)
        .order_by(TrainingRunMapping.rolling_index.asc().nullsfirst(),
                  TrainingRunMapping.test_start.asc().nullsfirst())
        .all()
    )
    if not mappings:
        raise JoinquantExportError(
            f"训练记录 {record_id} 没有关联的 run（TrainingRunMapping 为空）"
        )

    reader = MLFlowReader()
    aggregated: Dict[Any, Any] = {}
    used_run_ids: List[str] = []
    skipped_run_ids: List[str] = []
    for mapping in mappings:
        positions = reader.load_positions(record.experiment_id, mapping.run_id)
        if positions is None:
            logger.warning(
                "[joinquant_export] record=%s run=%s 缺 positions_normal_1day.pkl, 跳过",
                record_id, mapping.run_id,
            )
            skipped_run_ids.append(mapping.run_id)
            continue
        if not hasattr(positions, "items"):
            logger.warning(
                "[joinquant_export] record=%s run=%s positions 类型异常 %s, 跳过",
                record_id, mapping.run_id, type(positions),
            )
            skipped_run_ids.append(mapping.run_id)
            continue
        # 流式 update：滚动期重叠日的话后写胜出（与 notebook 行为一致）
        aggregated.update(dict(positions.items()))
        used_run_ids.append(mapping.run_id)

    if not used_run_ids:
        # 全部 run 缺 pkl：DB 落 status=failed 行让用户能在前端看到失败原因
        return _persist_failed(
            db,
            record_id=record_id,
            mlflow_run_ids=[m.run_id for m in mappings],
            n_runs_skipped=len(skipped_run_ids),
            error_msg="全部 run 缺 positions_normal_1day.pkl",
        )

    result_dict, n_dates, _n_symbols = _build_position_dict(aggregated)
    if n_dates == 0:
        return _persist_failed(
            db,
            record_id=record_id,
            mlflow_run_ids=used_run_ids,
            n_runs_skipped=len(skipped_run_ids),
            error_msg="positions pkl 解析后无有效日期数据",
        )

    # 落盘：原子写 + sha256 + size
    export_dir = Path(settings.joinquant_export_dir)
    export_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    file_name = f"joinquant_positions_record{record_id}_{ts}.json"
    target_path = export_dir / file_name
    payload = json.dumps(result_dict, indent=2, ensure_ascii=False)
    file_size, sha256 = _atomic_write_text(target_path, payload)

    row = JoinquantExport(
        training_record_id=record_id,
        file_path=str(target_path.resolve()),
        file_name=file_name,
        file_size=file_size,
        sha256=sha256,
        mlflow_run_ids=used_run_ids,
        n_dates=n_dates,
        n_runs_used=len(used_run_ids),
        n_runs_skipped=len(skipped_run_ids),
        status="ok",
        error_msg=None,
        created_by=created_by,
        created_at=datetime.now(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _persist_failed(
    db: Session,
    *,
    record_id: int,
    mlflow_run_ids: List[str],
    n_runs_skipped: int,
    error_msg: str,
) -> JoinquantExport:
    row = JoinquantExport(
        training_record_id=record_id,
        file_path=None,
        file_name=None,
        file_size=None,
        sha256=None,
        mlflow_run_ids=mlflow_run_ids,
        n_dates=0,
        n_runs_used=0,
        n_runs_skipped=n_runs_skipped,
        status="failed",
        error_msg=error_msg,
        created_at=datetime.now(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def list_exports(record_id: int, db: Session) -> List[JoinquantExport]:
    return (
        db.query(JoinquantExport)
        .filter(JoinquantExport.training_record_id == record_id)
        .order_by(JoinquantExport.created_at.desc())
        .all()
    )


def get_export(export_id: int, db: Session) -> Optional[JoinquantExport]:
    return db.query(JoinquantExport).filter(JoinquantExport.id == export_id).first()


def delete_export(export_id: int, db: Session) -> bool:
    row = get_export(export_id, db)
    if row is None:
        return False
    if row.file_path:
        try:
            p = Path(row.file_path)
            if p.exists():
                p.unlink()
        except Exception as exc:  # noqa: BLE001
            logger.warning("[joinquant_export] 删除文件 %s 失败 (continuing): %s", row.file_path, exc)
    db.delete(row)
    db.commit()
    return True


def get_export_path(export_id: int, db: Session) -> Optional[Path]:
    row = get_export(export_id, db)
    if row is None or not row.file_path:
        return None
    p = Path(row.file_path)
    return p if p.exists() else None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _atomic_write_text(target: Path, content: str) -> Tuple[int, str]:
    """tempfile 写入同目录后 os.replace 原子重命名；返回 (size, sha256_hex)。"""
    payload_bytes = content.encode("utf-8")
    sha = hashlib.sha256(payload_bytes).hexdigest()
    fd, tmp_name = tempfile.mkstemp(
        prefix=".tmp-joinquant-",
        suffix=".json",
        dir=str(target.parent),
    )
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload_bytes)
        os.replace(tmp_name, target)
    except Exception:
        # 异常时清掉 tmp，避免目录残留
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return len(payload_bytes), sha
