"""mlearnweb 端 naming.py 单元测试 + 与 vnpy_common/naming.py 的互校验。

互校验测试用 sys.path 临时注入读取 vnpy_common.naming 源码（仅测试时），
比对 classify_gateway 与 validate_node_mode 在所有合规/不合规命名样例上的
结果一致 — 任一边漂移会让本测试失败。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

MLEARNWEB_DIR = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = MLEARNWEB_DIR / "backend"
sys.path.insert(0, str(BACKEND_DIR))


# ---- mlearnweb classifier 自身行为 ----

def test_classify_gateway_local() -> None:
    from app.services.vnpy.naming import classify_gateway
    assert classify_gateway("QMT_SIM_csi300") == "sim"
    assert classify_gateway("QMT_SIM") == "sim"
    assert classify_gateway("QMT") == "live"
    assert classify_gateway("unknown") == "unknown"
    assert classify_gateway("") == "unknown"
    assert classify_gateway(None) == "unknown"  # type: ignore[arg-type]


def test_validate_node_mode_local() -> None:
    from app.services.vnpy.naming import validate_node_mode

    validate_node_mode("live")
    validate_node_mode("sim")
    with pytest.raises(ValueError):
        validate_node_mode("prod")


# ---- 互校验：与 vnpy_common/naming.py 结果一致 ----

VNPY_DEV_ROOT_CANDIDATES = [
    Path(os.getenv("VNPY_STRATEGY_DEV_ROOT", "")),
    Path(r"F:\Quant\vnpy\vnpy_strategy_dev"),
]


def _import_vnpy_common_naming():
    """临时把 vnpy_strategy_dev 加入 sys.path 后 import vnpy_common.naming。"""
    for candidate in VNPY_DEV_ROOT_CANDIDATES:
        if candidate and (candidate / "vnpy_common" / "naming.py").exists():
            sys.path.insert(0, str(candidate))
            try:
                import vnpy_common.naming as upstream
                return upstream
            finally:
                # 不持久污染 sys.path；其它测试若也要 import 自行管理
                pass
    pytest.skip("vnpy_common/naming.py 不可达，跳过互校验测试")


SAMPLES_GATEWAY = [
    "QMT_SIM",
    "QMT_SIM_csi300",
    "QMT_SIM_zz500",
    "QMT_SIM_a1",
    "QMT",
    "qmt_sim_lower",
    "QMT_SIMULATOR",
    "QMTPaper",
    "XTP",
    "",
    "FOO_BAR",
]


def test_classify_gateway_matches_upstream() -> None:
    upstream = _import_vnpy_common_naming()
    from app.services.vnpy.naming import classify_gateway as local_cls

    mismatches = []
    for s in SAMPLES_GATEWAY:
        u = upstream.classify_gateway(s)
        l = local_cls(s)
        if u != l:
            mismatches.append((s, u, l))
    assert not mismatches, f"vnpy_common 与 mlearnweb 端 classify_gateway 漂移: {mismatches}"


def test_node_mode_validators_match_upstream() -> None:
    upstream = _import_vnpy_common_naming()
    from app.services.vnpy.naming import validate_node_mode as local_validate

    samples = ["live", "sim", "prod", "PROD", "test", ""]
    for s in samples:
        u_ok = True
        try:
            upstream.validate_node_mode(s)
        except ValueError:
            u_ok = False
        l_ok = True
        try:
            local_validate(s)
        except ValueError:
            l_ok = False
        assert u_ok == l_ok, f"validate_node_mode 漂移: {s!r} upstream_ok={u_ok} local_ok={l_ok}"


def test_valid_node_modes_constant_matches() -> None:
    upstream = _import_vnpy_common_naming()
    from app.services.vnpy.naming import VALID_NODE_MODES as local_const
    assert tuple(upstream.VALID_NODE_MODES) == tuple(local_const)
