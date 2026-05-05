"""stock_name_cache.py 单测.

验证 Phase 3 解耦后的 stock_names 缓存:
  1. refresh_stock_names_once 拉到数据后填充 _GLOBAL_NAME_MAP
  2. 远端返空 / 失败时不覆盖本地已有数据
  3. get_stock_names_snapshot 返 dict copy (修改 copy 不影响原)
  4. ml_aggregation_service.get_stock_name_map 透传到 snapshot
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

MLEARNWEB_DIR = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = MLEARNWEB_DIR / "backend"
sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture(autouse=True)
def reset_cache():
    """每个测试前后清 _GLOBAL_NAME_MAP, 避免互相污染."""
    from app.services.vnpy.stock_name_cache import _GLOBAL_NAME_MAP, _GLOBAL_LOCK
    with _GLOBAL_LOCK:
        _GLOBAL_NAME_MAP.clear()
    yield
    with _GLOBAL_LOCK:
        _GLOBAL_NAME_MAP.clear()


class TestRefreshStockNamesOnce:
    def test_populates_cache_from_vnpy(self):
        from app.services.vnpy import stock_name_cache as cache_module

        class _FakeClient:
            async def get_reference_stock_names_first_ok(self):
                return {
                    "names": {
                        "000001.SZ": "平安银行",
                        "600000.SH": "浦发银行",
                        "300750.SZ": "宁德时代",
                    },
                    "count": 3,
                    "source_path": "/fake/stock_list.parquet",
                }

        with patch("app.services.vnpy.client.get_vnpy_client", return_value=_FakeClient()):
            n = asyncio.run(cache_module.refresh_stock_names_once())

        assert n == 3
        snap = cache_module.get_stock_names_snapshot()
        assert snap == {
            "000001.SZ": "平安银行",
            "600000.SH": "浦发银行",
            "300750.SZ": "宁德时代",
        }

    def test_empty_response_does_not_clear_existing_cache(self):
        """远端返空字典时, 不覆盖本地已有 cache (vnpy 推理机暂时拿不到 parquet 时)."""
        from app.services.vnpy import stock_name_cache as cache_module

        # 预先填一些数据
        with cache_module._GLOBAL_LOCK:
            cache_module._GLOBAL_NAME_MAP.update({"000001.SZ": "平安银行"})

        class _EmptyClient:
            async def get_reference_stock_names_first_ok(self):
                return {"names": {}, "count": 0, "source_path": None}

        with patch("app.services.vnpy.client.get_vnpy_client", return_value=_EmptyClient()):
            n = asyncio.run(cache_module.refresh_stock_names_once())

        # 本地 cache 保留
        assert n == 1  # 返回的是 cache 当前 size
        assert cache_module.get_stock_names_snapshot() == {"000001.SZ": "平安银行"}

    def test_http_failure_keeps_existing_cache(self):
        """HTTP 抛异常时不影响已有 cache."""
        from app.services.vnpy import stock_name_cache as cache_module

        with cache_module._GLOBAL_LOCK:
            cache_module._GLOBAL_NAME_MAP.update({"600000.SH": "浦发银行"})

        class _FailClient:
            async def get_reference_stock_names_first_ok(self):
                raise RuntimeError("network down")

        with patch("app.services.vnpy.client.get_vnpy_client", return_value=_FailClient()):
            n = asyncio.run(cache_module.refresh_stock_names_once())

        assert n == 1
        assert cache_module.get_stock_names_snapshot() == {"600000.SH": "浦发银行"}

    def test_malformed_response_skipped(self):
        """response 不是 dict 或 names 不是 dict — 不更新, 不抛."""
        from app.services.vnpy import stock_name_cache as cache_module

        class _BadClient:
            async def get_reference_stock_names_first_ok(self):
                return {"names": "not a dict"}  # 错误结构

        with patch("app.services.vnpy.client.get_vnpy_client", return_value=_BadClient()):
            n = asyncio.run(cache_module.refresh_stock_names_once())

        assert n == 0  # cache 仍空
        assert cache_module.get_stock_names_snapshot() == {}


class TestSnapshotIsolation:
    def test_returned_dict_is_copy_not_reference(self):
        """get_stock_names_snapshot 返 copy, 修改不影响内部 cache."""
        from app.services.vnpy import stock_name_cache as cache_module

        with cache_module._GLOBAL_LOCK:
            cache_module._GLOBAL_NAME_MAP.update({"000001.SZ": "平安银行"})

        snap = cache_module.get_stock_names_snapshot()
        snap["000001.SZ"] = "MODIFIED"  # 改 copy
        snap["999999.XX"] = "FAKE"

        # 内部 cache 不受影响
        assert cache_module.get_stock_names_snapshot() == {"000001.SZ": "平安银行"}


class TestAggregationServicePassthrough:
    def test_get_stock_name_map_reads_snapshot(self):
        """ml_aggregation_service.get_stock_name_map → stock_name_cache.get_stock_names_snapshot."""
        from app.services.vnpy import stock_name_cache as cache_module
        from app.services import ml_aggregation_service

        with cache_module._GLOBAL_LOCK:
            cache_module._GLOBAL_NAME_MAP.update({"600519.SH": "贵州茅台"})

        result = ml_aggregation_service.get_stock_name_map()
        assert result == {"600519.SH": "贵州茅台"}
