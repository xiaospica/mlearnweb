"""ML monitoring ORM models (Phase 3.1).

Populated by ``ml_snapshot_loop`` in ``app.live_main`` (每 60s 拉取 vnpy
节点 ``/api/v1/ml/*``). 读取端是 mlearnweb 的 ``/api/live-trading/ml/*``
路由 + 前端 Tab2.

设计与 ``StrategyEquitySnapshot`` 对齐 — 同样按 (node_id, engine, strategy_name)
分桶,同样有 ``ts`` 驱动的查询和清理路径.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Column, DateTime, Float, Index, Integer, String, Text

from .database import Base


class MLMetricSnapshot(Base):
    """每日 ML 监控指标快照.

    主键: ``(node_id, engine, strategy_name, trade_date)`` — UPSERT 语义.
    ``ml_snapshot_loop`` 按 60s 轮询时, 同一 trade_date 只保留最新一次;
    覆盖写不累加.

    Index 设计:
      - ``ix_mms_identity_date``: 前缀覆盖"按 (node, engine, strategy) 拉
        最近 N 日指标"的查询 (WHERE node=? AND engine=? AND strategy_name=?
        ORDER BY trade_date DESC LIMIT N)
      - ``ix_mms_trade_date``: 为跨策略的日期范围查询 + 保留期 DELETE 服务
    """

    __tablename__ = "ml_metric_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    node_id = Column(String(64), nullable=False)
    engine = Column(String(64), nullable=False)
    strategy_name = Column(String(128), nullable=False)
    trade_date = Column(DateTime, nullable=False)

    # 核心指标 (与 vnpy /api/v1/ml/strategies/{name}/metrics/latest 返回对齐)
    ic = Column(Float, nullable=True)
    rank_ic = Column(Float, nullable=True)
    psi_mean = Column(Float, nullable=True)
    psi_max = Column(Float, nullable=True)
    psi_n_over_0_25 = Column(Integer, nullable=True)  # PSI > 0.25 的特征数
    psi_by_feature_json = Column(Text, nullable=True)  # {feature: psi_value}
    ks_by_feature_json = Column(Text, nullable=True)  # {feature: ks_value}

    # 预测分数统计
    pred_mean = Column(Float, nullable=True)
    pred_std = Column(Float, nullable=True)
    pred_zero_ratio = Column(Float, nullable=True)
    n_predictions = Column(Integer, nullable=True)

    # 特征缺失率 (保留前 20 个最高缺失率的特征, 避免列过多)
    feat_missing_json = Column(Text, nullable=True)

    # 溯源
    model_run_id = Column(String(64), nullable=True)
    core_version = Column(String(32), nullable=True)

    # 元数据
    status = Column(String(32), nullable=True)  # ok / empty / failed
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    __table_args__ = (
        Index(
            "ix_mms_identity_date",
            "node_id",
            "engine",
            "strategy_name",
            "trade_date",
            unique=True,  # UPSERT 语义: 同一策略同一日只保留一行
        ),
        Index("ix_mms_trade_date", "trade_date"),
    )


class MLPredictionDaily(Base):
    """每日 ML 预测 summary.

    主键同 MLMetricSnapshot, UPSERT.
    ``topk_json`` 保存当日 topK 股票池 (instrument/score/rank);
    ``score_histogram_json`` 20-bin 分布供前端直接画.
    大 pred 数据 (12000+ rows) 不入库, 只留 summary.
    """

    __tablename__ = "ml_prediction_daily"

    id = Column(Integer, primary_key=True, autoincrement=True)
    node_id = Column(String(64), nullable=False)
    engine = Column(String(64), nullable=False)
    strategy_name = Column(String(128), nullable=False)
    trade_date = Column(DateTime, nullable=False)

    topk_json = Column(Text, nullable=True)  # list[{instrument, score, rank}]
    score_histogram_json = Column(Text, nullable=True)  # [{bin_id, edge_lo, edge_hi, count, probability}]
    n_symbols = Column(Integer, nullable=True)
    coverage_ratio = Column(Float, nullable=True)  # n_selected / n_candidates

    pred_mean = Column(Float, nullable=True)
    pred_std = Column(Float, nullable=True)

    model_run_id = Column(String(64), nullable=True)
    status = Column(String(32), nullable=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    __table_args__ = (
        Index(
            "ix_mpd_identity_date",
            "node_id",
            "engine",
            "strategy_name",
            "trade_date",
            unique=True,
        ),
        Index("ix_mpd_trade_date", "trade_date"),
    )
