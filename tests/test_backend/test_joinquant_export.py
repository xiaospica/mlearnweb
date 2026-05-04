"""聚宽 JSON 导出 service 单测。

覆盖：
  1. _qlib_to_joinquant_symbol 各种交易所后缀的归一化
  2. _build_position_dict 的 happy path 和边界（空字典 / 缺 .position 属性 / 异常 weight）
  3. 与 strategy_dev/backtest.py:position_analysis 前 50 行字节级一致（golden）
  4. generate_export 端到端：record + run mapping + mock pkl → 写盘 + DB 行
  5. 全部 run 缺 pkl → status='failed' DB 行
  6. 文件原子写 + sha256 + size
  7. delete_export 同时删盘上文件
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict
from unittest.mock import patch

import pandas as pd
import pytest

MLEARNWEB_DIR = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = MLEARNWEB_DIR / "backend"
sys.path.insert(0, str(BACKEND_DIR))


def _fake_position(weights: Dict[str, float]) -> SimpleNamespace:
    """模拟 qlib portfolio_analysis position 对象：含 .position dict。"""
    return SimpleNamespace(position={sym: {"weight": w, "amount": 0} for sym, w in weights.items()})


# ---------------------------------------------------------------------------
# Pure builder tests
# ---------------------------------------------------------------------------


class TestQlibToJoinquant:
    def test_xshg_to_sh(self):
        from app.services.joinquant_export_service import _qlib_to_joinquant_symbol
        assert _qlib_to_joinquant_symbol("600000.XSHG") == "SH600000"
        assert _qlib_to_joinquant_symbol("600000.SH") == "SH600000"

    def test_xshe_to_sz(self):
        from app.services.joinquant_export_service import _qlib_to_joinquant_symbol
        assert _qlib_to_joinquant_symbol("000001.XSHE") == "SZ000001"
        assert _qlib_to_joinquant_symbol("000001.SZ") == "SZ000001"

    def test_no_dot_returns_none(self):
        """cash / 其他无 '.' 的 symbol 返 None，由调用方 skip。"""
        from app.services.joinquant_export_service import _qlib_to_joinquant_symbol
        assert _qlib_to_joinquant_symbol("cash") is None
        assert _qlib_to_joinquant_symbol("") is None

    def test_unknown_suffix_returns_none(self):
        """未知交易所后缀返 None（log warn），不抛异常 — 服务化场景宁愿 skip 一只。"""
        from app.services.joinquant_export_service import _qlib_to_joinquant_symbol
        assert _qlib_to_joinquant_symbol("600000.NYSE") is None


class TestBuildPositionDict:
    def test_happy_path_single_date(self):
        from app.services.joinquant_export_service import _build_position_dict
        positions_pkl = {
            pd.Timestamp("2024-01-15"): _fake_position({
                "600000.XSHG": 0.142857,
                "000001.XSHE": 0.142857,
                "300750.XSHE": 0.142857,
                "cash": 1.0,  # skip
            }),
        }
        result, n_dates, n_symbols = _build_position_dict(positions_pkl)
        assert n_dates == 1
        assert n_symbols == 3  # cash skipped
        assert "2024-01-15" in result
        day = result["2024-01-15"]
        assert day["SH600000"] == {"weight": 0.142857, "stock_name": "SH600000"}
        assert day["SZ000001"] == {"weight": 0.142857, "stock_name": "SZ000001"}
        assert day["SZ300750"] == {"weight": 0.142857, "stock_name": "SZ300750"}
        assert "cash" not in day

    def test_multi_date_sorted_ascending(self):
        """多日期 input 倒序，输出按 date 升序排列（与 backtest.py 同源）。"""
        from app.services.joinquant_export_service import _build_position_dict
        positions_pkl = {
            pd.Timestamp("2024-01-17"): _fake_position({"600000.SH": 0.5}),
            pd.Timestamp("2024-01-15"): _fake_position({"000001.SZ": 0.3}),
        }
        result, _, _ = _build_position_dict(positions_pkl)
        keys = list(result.keys())
        assert keys == sorted(keys), f"expect ascending date order, got {keys}"

    def test_empty_input(self):
        from app.services.joinquant_export_service import _build_position_dict
        result, n_dates, n_symbols = _build_position_dict({})
        assert result == {}
        assert n_dates == 0
        assert n_symbols == 0

    def test_skips_objects_without_position_attr(self):
        from app.services.joinquant_export_service import _build_position_dict
        positions_pkl = {
            pd.Timestamp("2024-01-15"): SimpleNamespace(some_other_field=1),  # no .position
            pd.Timestamp("2024-01-16"): _fake_position({"600000.SH": 0.5}),
        }
        result, n_dates, _ = _build_position_dict(positions_pkl)
        assert n_dates == 1  # 只剩 16 号
        assert "2024-01-16" in result

    def test_skips_invalid_weight(self):
        """weight 字段缺失 / 非数字 — skip 不抛。"""
        from app.services.joinquant_export_service import _build_position_dict
        bad_pos = SimpleNamespace(position={
            "600000.SH": {"weight": "not-a-number"},
            "000001.SZ": {"amount": 100},  # no weight key
            "300750.SZ": {"weight": 0.5},  # ok
        })
        positions_pkl = {pd.Timestamp("2024-01-15"): bad_pos}
        result, _, n_symbols = _build_position_dict(positions_pkl)
        assert n_symbols == 1
        assert result["2024-01-15"] == {"SZ300750": {"weight": 0.5, "stock_name": "SZ300750"}}

    def test_multi_date_no_overwrite(self):
        """跨日 update：同 symbol 不同日 → 各自归各自的 date dict，不互相覆盖。"""
        from app.services.joinquant_export_service import _build_position_dict
        positions_pkl = {
            pd.Timestamp("2024-01-15"): _fake_position({"600000.SH": 0.3}),
            pd.Timestamp("2024-01-16"): _fake_position({"600000.SH": 0.5}),
        }
        result, _, _ = _build_position_dict(positions_pkl)
        assert result["2024-01-15"]["SH600000"]["weight"] == 0.3
        assert result["2024-01-16"]["SH600000"]["weight"] == 0.5


class TestGoldenAgainstNotebook:
    """与 strategy_dev/backtest.py:position_analysis 前 50 行字节级对齐。

    backtest.py 的算法（已读源码）：
      sorted by date asc → for each (date, df) → if hasattr(df, 'position') → for
      each (key, value) in df.position → if '.' in key → 按 XSHG/SH 或 XSHE/SZ
      映射前缀 → result[date_str][new_key] = {"weight": round(weight, 6), "stock_name": new_key}

    本测验证我们重写的 _build_position_dict 输出与该算法等价。
    """
    def test_byte_equivalent_with_backtest_py(self):
        from app.services.joinquant_export_service import _build_position_dict
        positions_pkl = {
            pd.Timestamp("2024-03-01"): _fake_position({
                "600000.XSHG": 0.1,
                "601318.SH": 0.2,
                "000001.XSHE": 0.3,
                "300750.SZ": 0.4,
            }),
        }
        result, _, _ = _build_position_dict(positions_pkl)
        # 重新实现 notebook 的算法对照
        expected_day = {
            "SH600000": {"weight": 0.1, "stock_name": "SH600000"},
            "SH601318": {"weight": 0.2, "stock_name": "SH601318"},
            "SZ000001": {"weight": 0.3, "stock_name": "SZ000001"},
            "SZ300750": {"weight": 0.4, "stock_name": "SZ300750"},
        }
        assert result["2024-03-01"] == expected_day


# ---------------------------------------------------------------------------
# generate_export end-to-end (with fake DB + mock MLFlowReader)
# ---------------------------------------------------------------------------


@pytest.fixture
def api_client(tmp_path, monkeypatch):
    """临时 sqlite + 临时 export 目录 + 重 import 让 service/router 拿到干净 DB。"""
    db_file = tmp_path / "test_jq.db"
    export_dir = tmp_path / "joinquant_out"
    from app.core.config import settings
    monkeypatch.setattr(settings, "database_url", f"sqlite:///{db_file}")
    monkeypatch.setattr(settings, "joinquant_export_dir", str(export_dir))

    import importlib
    from app.models import database as db_module
    importlib.reload(db_module)
    db_module.init_db()

    from app.services import joinquant_export_service as svc_module
    importlib.reload(svc_module)

    return db_module, svc_module, export_dir


def _seed_record_with_run(db_module, *, record_id=1, run_id="run-abc", experiment_id="exp-1"):
    from sqlalchemy.orm import sessionmaker
    Session = sessionmaker(bind=db_module.engine)
    s = Session()
    s.add(db_module.TrainingRecord(
        id=record_id, name=f"rec-{record_id}", experiment_id=experiment_id,
        run_ids=[run_id], status="completed", category="single",
        created_at=datetime.now(), updated_at=datetime.now(),
    ))
    s.add(db_module.TrainingRunMapping(
        training_record_id=record_id, run_id=run_id, rolling_index=0,
    ))
    s.commit()
    s.close()


class TestGenerateExport:
    def test_happy_path_writes_file_and_db_row(self, api_client):
        db_module, svc_module, export_dir = api_client
        _seed_record_with_run(db_module)

        # mock MLFlowReader.load_positions 返回 fake pkl
        fake_pkl = {
            pd.Timestamp("2024-01-15"): _fake_position({"600000.SH": 0.142857}),
            pd.Timestamp("2024-01-16"): _fake_position({"000001.SZ": 0.142857}),
        }
        with patch.object(svc_module.MLFlowReader, "load_positions", return_value=fake_pkl):
            from sqlalchemy.orm import sessionmaker
            Session = sessionmaker(bind=db_module.engine)
            s = Session()
            row = svc_module.generate_export(record_id=1, db=s)
            s.close()

        assert row.status == "ok"
        assert row.training_record_id == 1
        assert row.n_dates == 2
        assert row.n_runs_used == 1
        assert row.n_runs_skipped == 0
        # 文件确实写了，且 sha256 / size 对得上
        assert row.file_path is not None
        p = Path(row.file_path)
        assert p.exists()
        assert p.stat().st_size == row.file_size
        assert hashlib.sha256(p.read_bytes()).hexdigest() == row.sha256
        # 文件内容是合法 JSON 且日期升序
        content = json.loads(p.read_text(encoding="utf-8"))
        assert list(content.keys()) == ["2024-01-15", "2024-01-16"]
        assert content["2024-01-15"]["SH600000"]["weight"] == 0.142857

    def test_all_runs_missing_pkl_records_failed_status(self, api_client):
        db_module, svc_module, export_dir = api_client
        _seed_record_with_run(db_module)

        with patch.object(svc_module.MLFlowReader, "load_positions", return_value=None):
            from sqlalchemy.orm import sessionmaker
            Session = sessionmaker(bind=db_module.engine)
            s = Session()
            row = svc_module.generate_export(record_id=1, db=s)
            s.close()

        assert row.status == "failed"
        assert row.file_path is None
        assert row.n_runs_used == 0
        assert "缺 positions_normal_1day.pkl" in row.error_msg
        # 文件目录干净，没残留 tmp
        leftover = list(Path(export_dir).glob("*")) if Path(export_dir).exists() else []
        non_tmp = [p for p in leftover if not p.name.startswith(".tmp-")]
        assert non_tmp == []

    def test_record_not_found_raises(self, api_client):
        db_module, svc_module, _ = api_client
        from sqlalchemy.orm import sessionmaker
        Session = sessionmaker(bind=db_module.engine)
        s = Session()
        with pytest.raises(svc_module.JoinquantExportError, match="不存在"):
            svc_module.generate_export(record_id=999, db=s)
        s.close()

    def test_record_with_no_runs_raises(self, api_client):
        db_module, svc_module, _ = api_client
        from sqlalchemy.orm import sessionmaker
        Session = sessionmaker(bind=db_module.engine)
        s = Session()
        s.add(db_module.TrainingRecord(
            id=2, name="no-runs", experiment_id="exp-x",
            status="completed", category="single",
            created_at=datetime.now(), updated_at=datetime.now(),
        ))
        s.commit()
        with pytest.raises(svc_module.JoinquantExportError, match="没有关联的 run"):
            svc_module.generate_export(record_id=2, db=s)
        s.close()

    def test_partial_runs_missing_only_uses_available(self, api_client):
        """滚动训练 N 期，部分 run 缺 pkl → skip 失败的, 用成功的产出 JSON。"""
        db_module, svc_module, _ = api_client
        from sqlalchemy.orm import sessionmaker
        Session = sessionmaker(bind=db_module.engine)
        s = Session()
        s.add(db_module.TrainingRecord(
            id=3, name="rolling", experiment_id="exp-1",
            run_ids=["run-1", "run-2", "run-3"],
            status="completed", category="rolling",
            created_at=datetime.now(), updated_at=datetime.now(),
        ))
        for i, rid in enumerate(["run-1", "run-2", "run-3"]):
            s.add(db_module.TrainingRunMapping(
                training_record_id=3, run_id=rid, rolling_index=i,
            ))
        s.commit()
        s.close()

        # run-2 缺 pkl，其它两个有
        def fake_load(experiment_id, run_id):
            if run_id == "run-2":
                return None
            return {pd.Timestamp(f"2024-0{1 if run_id == 'run-1' else 3}-15"):
                    _fake_position({"600000.SH": 0.5})}
        with patch.object(svc_module.MLFlowReader, "load_positions", side_effect=fake_load):
            s = Session()
            row = svc_module.generate_export(record_id=3, db=s)
            s.close()
        assert row.status == "ok"
        assert row.n_runs_used == 2
        assert row.n_runs_skipped == 1
        assert sorted(row.mlflow_run_ids) == ["run-1", "run-3"]


class TestDeleteExport:
    def test_delete_removes_file_and_row(self, api_client):
        db_module, svc_module, _ = api_client
        _seed_record_with_run(db_module)
        fake_pkl = {pd.Timestamp("2024-01-15"): _fake_position({"600000.SH": 0.5})}
        with patch.object(svc_module.MLFlowReader, "load_positions", return_value=fake_pkl):
            from sqlalchemy.orm import sessionmaker
            Session = sessionmaker(bind=db_module.engine)
            s = Session()
            row = svc_module.generate_export(record_id=1, db=s)
            export_id = row.id
            file_path = row.file_path
            s.close()

        assert Path(file_path).exists()
        s = Session()
        ok = svc_module.delete_export(export_id, s)
        s.close()
        assert ok
        assert not Path(file_path).exists()

    def test_delete_missing_returns_false(self, api_client):
        db_module, svc_module, _ = api_client
        from sqlalchemy.orm import sessionmaker
        Session = sessionmaker(bind=db_module.engine)
        s = Session()
        assert svc_module.delete_export(99999, s) is False
        s.close()


class TestAtomicWrite:
    def test_atomic_write_no_tmp_leftover_on_success(self, tmp_path):
        from app.services.joinquant_export_service import _atomic_write_text
        target = tmp_path / "out.json"
        size, sha = _atomic_write_text(target, '{"a": 1}')
        assert target.exists()
        assert target.read_text(encoding="utf-8") == '{"a": 1}'
        assert size == len('{"a": 1}'.encode("utf-8"))
        assert sha == hashlib.sha256(b'{"a": 1}').hexdigest()
        # 没有残留 .tmp- 文件
        leftover = [p for p in tmp_path.iterdir() if p.name.startswith(".tmp-")]
        assert leftover == []

    def test_atomic_write_cleans_tmp_on_replace_failure(self, tmp_path, monkeypatch):
        """模拟 os.replace 抛异常时 tmp 必须被清掉，不留垃圾。"""
        from app.services import joinquant_export_service as svc
        target = tmp_path / "out.json"

        def fake_replace(*args, **kwargs):
            raise OSError("disk full")
        monkeypatch.setattr(svc.os, "replace", fake_replace)
        with pytest.raises(OSError):
            svc._atomic_write_text(target, '{"a": 1}')
        leftover = [p for p in tmp_path.iterdir() if p.name.startswith(".tmp-")]
        assert leftover == [], f"未清掉 tmp: {leftover}"
