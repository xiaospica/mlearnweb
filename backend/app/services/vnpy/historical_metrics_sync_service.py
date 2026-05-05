"""Historical metrics sync — 从 vnpy webtrader 拉历史 metrics 到 mlearnweb.db.

设计原则: 推理端算单日指标, 监控端做跨天聚合.
  vnpy 推理端 (vnpy_ml_strategy + vendor qlib_strategy_core) 负责:
    - T 日 21:00 推理后写 metrics.json (pred_mean / pred_std / pred_zero_ratio /
      n_predictions / psi_* / ks_* / feat_missing 等可立即算的字段)
    - T+forward_window 日 IcBackfillService 触发 vendor `run_ic_backfill.py`
      子进程把历史 metrics.json 的 ic / rank_ic 字段填回
    - webtrader REST 端点 /api/v1/ml/strategies/{name}/metrics?days=N 返回完整时序
  本 service 负责:
    - 周期 (默认 5min) HTTP 拉每只策略最近 N 天 metrics 历史
    - 与 mlearnweb.db.ml_metric_snapshots 比对, INSERT 缺失行 + UPDATE 已有行
      的 NULL 字段 (避免覆盖 ml_snapshot_loop 已写好的真值)

历史:
  早期有 ``ml_metrics_backfill_service.py`` 在 mlearnweb 端自己扫
  ``D:/ml_output predictions.parquet`` + 读 ``daily_merged_all_new.parquet`` 算
  IC, 解决 vendor batch 模式不写 metrics.json 的问题. 但这违反"推理端算单日"
  原则, 跨机部署也不可行 (mlearnweb 跟 vnpy 推理可能不同机, 没有 D:\ 文件
  系统访问权). vendor + vnpy_ml_strategy 已补全 IC 闭环 (Phase 1, 见
  bc28425), mlearnweb 端那段误工已删除, 本 service 取代为唯一的
  "拉 + 写 db" 路径.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import update as sa_update
from sqlalchemy.orm import sessionmaker

from app.models.database import engine as db_engine
from app.models.ml_monitoring import MLMetricSnapshot
from app.services.vnpy.client import VnpyMultiNodeClient, get_vnpy_client

logger = logging.getLogger(__name__)


# 与 ml_monitoring_service.ML_ENGINE_NAME 保持一致
ML_ENGINE_NAME = "MlStrategy"
# 5 分钟 — IC 回填本身要等 forward window (≥1 个交易日), 高频轮询无意义
SYNC_POLL_INTERVAL_SECONDS = 300
# 每次同步回看天数. 与 vnpy MLEngine._metrics_cache.max_history_days (500)
# 对齐 — vnpy 启动期把磁盘 metrics.json 全 reload 进 cache, 这里要一次性拉够
# 长才能把"权益曲线起点之前"的历史也同步进 mlearnweb.db. INSERT-IF-MISSING
# + UPDATE-NULL-ONLY 是幂等的, 多拉不会重复写.
SYNC_LOOKBACK_DAYS = 500


# vnpy /metrics 端点返回字段 → MLMetricSnapshot 列名的映射.
# 标量字段直接 setattr; JSON 字段需 dict → str 转换 (见 _coerce_json_field).
_SCALAR_FIELDS = (
    "ic",
    "rank_ic",
    "psi_mean",
    "psi_max",
    "psi_n_over_0_25",
    "pred_mean",
    "pred_std",
    "pred_zero_ratio",
    "n_predictions",
    "model_run_id",
    "core_version",
)
# vnpy 端 metrics 字段名 → mlearnweb DB 列名 (mostly 同名, 但 JSON 字段 vnpy
# 不带 _json 后缀, 这里映射好)
_JSON_FIELDS = {
    "psi_by_feature": "psi_by_feature_json",
    "ks_by_feature": "ks_by_feature_json",
    "feat_missing": "feat_missing_json",
}


def _parse_trade_date(metrics: Dict[str, Any]) -> Optional[datetime]:
    """metrics.json 里 trade_date 是 YYYY-MM-DD 字符串."""
    raw = metrics.get("trade_date")
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def _coerce_json_field(value: Any) -> Optional[str]:
    """把 vnpy metrics 里的 dict 字段转 JSON 字符串 (db 存 Text)."""
    if value is None:
        return None
    if isinstance(value, str):
        # vnpy 端可能直接给字符串 (向前兼容)
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return None


def _build_insert_kwargs(entry: Dict[str, Any]) -> Dict[str, Any]:
    """从 vnpy metrics dict 构造 MLMetricSnapshot 构造参数 (含全部可填字段).

    用于 INSERT 路径 — 本地行不存在时一次性写入所有非 None 字段.
    """
    kwargs: Dict[str, Any] = {}
    for f in _SCALAR_FIELDS:
        v = entry.get(f)
        if v is not None:
            kwargs[f] = v
    for vnpy_key, db_col in _JSON_FIELDS.items():
        v = _coerce_json_field(entry.get(vnpy_key))
        if v is not None:
            kwargs[db_col] = v
    status = entry.get("status")
    if status:
        kwargs["status"] = status
    return kwargs


def _diff_and_apply(
    session,
    *,
    node_id: str,
    strategy_name: str,
    remote_history: List[Dict[str, Any]],
) -> Dict[str, int]:
    """对每条远端 metrics 记录:
      - 本地行不存在 → INSERT (一次性写入 vnpy 当下能给的所有字段)
      - 本地行存在 → UPDATE 仅"本地 NULL 但远端非 NULL"的字段 (不覆盖真值)

    返回 (inserted, updated_rows) 计数.
    """
    inserted = 0
    updated_rows = 0
    # Dedupe by trade_date — vnpy cache 上游若有重复 (init seed + replay publish)
    # 会让一批里多条同日 entry 都走到 INSERT 路径, 因为前面 add 还没 flush 到 DB,
    # session.query 看不到, 第二条 add 提交时撞 UNIQUE 约束. 同日只取最后一个
    # (与 cache append 顺序一致, 即最新一次 publish_metrics 的值).
    by_date: Dict[Any, Dict[str, Any]] = {}
    for entry in remote_history:
        if not isinstance(entry, dict):
            continue
        td = _parse_trade_date(entry)
        if td is None:
            continue
        by_date[td] = entry
    for trade_date, entry in by_date.items():
        local = (
            session.query(MLMetricSnapshot)
            .filter(
                MLMetricSnapshot.node_id == node_id,
                MLMetricSnapshot.engine == ML_ENGINE_NAME,
                MLMetricSnapshot.strategy_name == strategy_name,
                MLMetricSnapshot.trade_date == trade_date,
            )
            .first()
        )

        if local is None:
            # INSERT 路径: 本地缺这天, 用远端能给的全部字段建一行.
            kwargs = _build_insert_kwargs(entry)
            row = MLMetricSnapshot(
                node_id=node_id,
                engine=ML_ENGINE_NAME,
                strategy_name=strategy_name,
                trade_date=trade_date,
                **kwargs,
            )
            session.add(row)
            inserted += 1
            continue

        # UPDATE 路径: 仅在本地是 NULL / 空 JSON 时填充.
        changes: Dict[str, Any] = {}
        for f in _SCALAR_FIELDS:
            local_v = getattr(local, f, None)
            remote_v = entry.get(f)
            if local_v is None and remote_v is not None:
                changes[f] = remote_v
        for vnpy_key, db_col in _JSON_FIELDS.items():
            local_v = getattr(local, db_col, None)
            remote_v = _coerce_json_field(entry.get(vnpy_key))
            # JSON 字段空判: NULL 或空对象 "{}"
            if (local_v is None or local_v in ("{}", "[]")) and remote_v is not None:
                changes[db_col] = remote_v
        if not changes:
            continue
        session.execute(
            sa_update(MLMetricSnapshot)
            .where(MLMetricSnapshot.id == local.id)
            .values(**changes)
        )
        updated_rows += 1

    return {"inserted": inserted, "updated": updated_rows}


async def _collect_strategy_names(client: VnpyMultiNodeClient) -> Dict[str, List[str]]:
    """{node_id: [strategy_name...]} — 跟 ml_snapshot_loop 用同一个 discovery."""
    result: Dict[str, List[str]] = {}
    fo = await client.get_ml_health_all()
    for item in fo:
        if not item.get("ok"):
            continue
        data = item.get("data") or {}
        strategies = data.get("strategies") or []
        names = [s.get("name") for s in strategies if s.get("name")]
        if names:
            result[item["node_id"]] = names
    return result


async def historical_metrics_sync_tick() -> None:
    """One iteration — 拉历史 metrics 列表, 与 SQLite 比对, INSERT 缺失 + UPDATE NULL."""
    client = get_vnpy_client()
    if not client.node_ids:
        return

    try:
        name_by_node = await _collect_strategy_names(client)
    except Exception as e:
        logger.warning("[hist_metrics_sync] discovery failed: %s", e)
        return

    if not any(names for names in name_by_node.values()):
        return

    # 并发拉每只策略最近 SYNC_LOOKBACK_DAYS 天的 metrics 历史
    histories: Dict[str, Dict[str, List[Dict[str, Any]]]] = {nid: {} for nid in name_by_node}

    async def _fetch_one(nid: str, name: str):
        try:
            hist = await client.get_ml_metrics_history(nid, name, SYNC_LOOKBACK_DAYS)
        except Exception as e:
            logger.warning(
                "[hist_metrics_sync] get_ml_metrics_history(%s,%s) failed: %s",
                nid, name, e,
            )
            hist = []
        return (nid, name, hist)

    tasks = []
    for nid, names in name_by_node.items():
        for name in names:
            tasks.append(_fetch_one(nid, name))

    for result in await asyncio.gather(*tasks, return_exceptions=True):
        if isinstance(result, Exception):
            continue
        nid, name, hist = result
        histories[nid][name] = hist or []

    SessionLocal = sessionmaker(bind=db_engine, autocommit=False, autoflush=False)
    session = SessionLocal()
    total_inserted = 0
    total_updated = 0
    try:
        for nid, by_strategy in histories.items():
            for name, remote_hist in by_strategy.items():
                if not remote_hist:
                    continue
                stats = _diff_and_apply(
                    session,
                    node_id=nid,
                    strategy_name=name,
                    remote_history=remote_hist,
                )
                total_inserted += stats["inserted"]
                total_updated += stats["updated"]
        session.commit()
        if total_inserted or total_updated:
            logger.info(
                "[hist_metrics_sync] inserted=%d updated=%d (lookback=%dd)",
                total_inserted, total_updated, SYNC_LOOKBACK_DAYS,
            )
    except Exception as e:
        logger.exception("[hist_metrics_sync] write failed: %s", e)
        session.rollback()
    finally:
        session.close()


async def historical_metrics_sync_loop() -> None:
    logger.info(
        "[hist_metrics_sync] historical_metrics_sync_loop started "
        "(interval=%ss, lookback_days=%s)",
        SYNC_POLL_INTERVAL_SECONDS,
        SYNC_LOOKBACK_DAYS,
    )
    while True:
        try:
            await historical_metrics_sync_tick()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("[hist_metrics_sync] loop iteration failed: %s", e)
        try:
            await asyncio.sleep(SYNC_POLL_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise
