"""Phase 3B：部署追踪同步服务。

周期性扫描所有 vnpy 节点的策略，从 ``parameters.bundle_dir`` 反查 mlflow
``run_id`` → 定位到对应 TrainingRecord → upsert 其 ``deployments`` JSON 字段。

设计要点：
- ``parse_run_id_from_bundle``: 路径解析为主，manifest.json 兜底
- ``sync_deployments``: 扫描 → 解析 → 反查 → upsert，幂等
- 部署消失时标记 ``active=False``（不删除，便于历史复盘）
- 命名约定：mode 推断复用 ``app.services.vnpy.naming.classify_gateway``
  → unknown 时 fallback 到节点 mode（lenient warn）
- 详见 vnpy_common/naming.py 命名约定章节
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.database import TrainingRecord
from app.services.vnpy.naming import classify_gateway

logger = logging.getLogger(__name__)


# 32 位 hex（mlflow run_id 标准格式）
_HEX32 = re.compile(r"^[0-9a-fA-F]{32}$")


def parse_run_id_from_bundle(bundle_dir: str) -> Optional[str]:
    """从 bundle_dir 反查 mlflow run_id。

    优先级：
        1. 路径解析：``Path(bundle_dir).name`` 取最后一段，验证是 32 位 hex
        2. manifest.json 兜底：读 ``{bundle_dir}/manifest.json`` 的 ``run_id`` 字段
           （由 ``export_bundle.py`` 在创建 bundle 时写入）

    详见 plan 文档"命名约定"章节约定 4。

    >>> parse_run_id_from_bundle(r"F:/qs_exports/rolling_exp/ab2711178313491f9900b5695b47fa98")
    'ab2711178313491f9900b5695b47fa98'
    >>> parse_run_id_from_bundle("/qs_exports/rolling_exp/ab2711178313491f9900b5695b47fa98/")
    'ab2711178313491f9900b5695b47fa98'
    >>> parse_run_id_from_bundle("invalid_no_run_id")  # 既非 hex 路径，也无 manifest
    """
    if not bundle_dir:
        return None
    # 1) 路径解析（最后一段）
    try:
        name = Path(bundle_dir.rstrip("/\\")).name
        if _HEX32.match(name):
            return name.lower()
    except Exception:
        pass

    # 2) manifest.json 兜底
    try:
        manifest_path = Path(bundle_dir) / "manifest.json"
        if manifest_path.exists():
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f) or {}
            run_id = manifest.get("run_id")
            if isinstance(run_id, str) and run_id:
                return run_id.lower()
    except Exception as exc:
        logger.warning("读 manifest.json 失败 (%s): %s", bundle_dir, exc)

    return None


def _build_deployment_entry(
    node_id: str,
    engine: str,
    strategy: Dict[str, Any],
    *,
    node_mode: str,
    run_id: str,
    bundle_dir: str,
    now_iso: str,
) -> Dict[str, Any]:
    gw = (strategy.get("parameters") or {}).get("gateway", "") or ""
    cls = classify_gateway(gw)
    mode = cls if cls != "unknown" else node_mode
    return {
        "node_id": node_id,
        "engine": engine,
        "strategy_name": strategy.get("name", ""),
        "mode": mode,
        "gateway_name": gw if isinstance(gw, str) else str(gw),
        "run_id": run_id,
        "bundle_dir": bundle_dir,
        "first_seen_at": now_iso,
        "last_seen_at": now_iso,
        "active": True,
    }


def _upsert_deployment(record: TrainingRecord, new_entry: Dict[str, Any]) -> None:
    """按 (node_id, engine, strategy_name) 主键合并。已存在则更新 last_seen_at + active。"""
    deployments = list(record.deployments or [])
    key = (new_entry["node_id"], new_entry["engine"], new_entry["strategy_name"])
    found_idx = None
    for i, dep in enumerate(deployments):
        if (dep.get("node_id"), dep.get("engine"), dep.get("strategy_name")) == key:
            found_idx = i
            break
    if found_idx is None:
        deployments.append(new_entry)
    else:
        # 保留 first_seen_at 不动；其余字段同步更新
        merged = dict(deployments[found_idx])
        merged.update(new_entry)
        merged["first_seen_at"] = deployments[found_idx].get(
            "first_seen_at", new_entry["first_seen_at"]
        )
        deployments[found_idx] = merged
    record.deployments = deployments

    # SQLAlchemy 检测 JSON 字段变化的兜底（mutation tracking 不总能感知 list 内的变化）
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(record, "deployments")


def _mark_inactive_missing(record: TrainingRecord, seen_keys: set, now_iso: str) -> int:
    """本次扫描未看到的部署标记 active=False（不删除）。返回标记的条数。"""
    deployments = list(record.deployments or [])
    n_marked = 0
    for i, dep in enumerate(deployments):
        key = (dep.get("node_id"), dep.get("engine"), dep.get("strategy_name"))
        if key not in seen_keys and dep.get("active"):
            dep = dict(dep)
            dep["active"] = False
            dep["last_seen_at"] = dep.get("last_seen_at") or now_iso
            deployments[i] = dep
            n_marked += 1
    if n_marked > 0:
        record.deployments = deployments
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(record, "deployments")
    return n_marked


def _find_record_by_run_id(db: Session, run_id: str) -> Optional[TrainingRecord]:
    """SELECT TrainingRecord WHERE run_ids JSON contains run_id。

    SQLite JSON1 用 json_each 做包含查询；mlearnweb 部署都在 SQLite，
    若要兼容其他数据库需改 SQL。Python 端 fallback 防 dialect 不支持。
    """
    try:
        from sqlalchemy import text
        sql = text("""
            SELECT id FROM training_records
            WHERE EXISTS (
                SELECT 1 FROM json_each(training_records.run_ids)
                WHERE json_each.value = :run_id
            )
            LIMIT 1
        """)
        row = db.execute(sql, {"run_id": run_id}).fetchone()
        if row is not None:
            return db.get(TrainingRecord, row[0])
    except Exception as exc:
        logger.debug("json_each 查询失败 (%s)，回退 Python 端过滤", exc)

    # Python 端 fallback
    for record in db.query(TrainingRecord).all():
        run_ids = record.run_ids or []
        if isinstance(run_ids, list) and run_id in run_ids:
            return record
    return None


async def sync_deployments(db: Session, client: Any) -> Dict[str, int]:
    """扫描所有节点策略 → 反查 run_id → upsert TrainingRecord.deployments。

    返回 stats: ``{scanned, matched, upserted, marked_inactive}``，调用方可日志或返回 API。
    """
    stats = {"scanned": 0, "matched": 0, "upserted": 0, "marked_inactive": 0}

    if not getattr(client, "node_ids", None):
        return stats

    try:
        strategies_fo = await client.get_strategies()
    except Exception as exc:
        logger.warning("[deployment_sync] get_strategies 失败: %s", exc)
        return stats

    node_modes = {n.node_id: getattr(n, "mode", "sim") for n in getattr(client, "nodes", [])}
    now_iso = datetime.now().isoformat(timespec="seconds")

    # 累积每个 record 本轮看到的 deployment keys，用于事后 mark_inactive
    seen_per_record: Dict[int, set] = {}

    for item in strategies_fo:
        if not item.get("ok"):
            continue
        node_id = item["node_id"]
        node_mode = node_modes.get(node_id, "sim")
        for s in item.get("data") or []:
            stats["scanned"] += 1
            params = s.get("parameters") or {}
            bundle_dir = params.get("bundle_dir", "") or ""
            if not bundle_dir:
                continue
            run_id = parse_run_id_from_bundle(bundle_dir)
            if not run_id:
                logger.info(
                    "[deployment_sync] 无法解析 run_id (node=%s strategy=%s bundle_dir=%s)，跳过",
                    node_id, s.get("name"), bundle_dir,
                )
                continue
            record = _find_record_by_run_id(db, run_id)
            if record is None:
                continue
            stats["matched"] += 1
            entry = _build_deployment_entry(
                node_id, s.get("engine", ""), s,
                node_mode=node_mode, run_id=run_id,
                bundle_dir=bundle_dir, now_iso=now_iso,
            )
            _upsert_deployment(record, entry)
            stats["upserted"] += 1
            seen_per_record.setdefault(record.id, set()).add(
                (entry["node_id"], entry["engine"], entry["strategy_name"])
            )

    # 标记本轮未看到的 deployment 为 active=False
    for record_id, seen_keys in seen_per_record.items():
        record = db.get(TrainingRecord, record_id)
        if record is None:
            continue
        stats["marked_inactive"] += _mark_inactive_missing(record, seen_keys, now_iso)

    db.commit()
    return stats
