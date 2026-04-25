"""mlearnweb 端 gateway 命名约定 classifier。

# ⚠ 与 vnpy_common/naming.py 保持同步

本文件是 ``F:\\Quant\\vnpy\\vnpy_strategy_dev\\vnpy_common\\naming.py`` 的等价
**复制**（功能子集，仅含 ``classify_gateway`` + ``validate_node_mode``，**不含**
``validate_gateway_name``，因为 mlearnweb 不构造 gateway，无需 strict 校验）。

为何不直接 import：
    mlearnweb 与 vnpy 主工程是不同 Python 环境
    （mlearnweb=E:\\...\\python-3.11.0-amd64，vnpy=F:\\Program_Home\\vnpy），
    跨 env path 注入 import 会引入运行时耦合 + 部署不便。10 行函数复制成本极低，
    通过互校验测试 ``tests/test_backend/test_naming.py`` 自动捕获两侧漂移。

新增 gateway 类型时同步流程：
    1. 改 ``vnpy_common/naming.py`` 的常量 + 测试
    2. **同时**改本文件的常量
    3. 跑 ``test_naming.py`` 互校验测试 → 必须通过

# 命名约定（简版）

详见 ``vnpy_common/naming.py`` 模块 docstring。要点：
    - ``QMT_SIM`` / ``QMT_SIM_<sandbox_id>`` → "sim"（模拟柜台）
    - ``QMT`` → "live"（实盘 miniqmt）
    - 其他 → "unknown"（fallback 到节点 mode）
    - 节点 mode 合法值：``("live", "sim")``，缺省取 "sim"
"""
from __future__ import annotations

import re
from typing import Literal

# 与 vnpy_common/naming.py 保持完全一致（互校验测试守门）
_PATTERN_SIM = re.compile(r"^QMT_SIM(_[A-Za-z0-9]+)*$")
_NAME_LIVE = "QMT"
VALID_NODE_MODES = ("live", "sim")

GatewayClass = Literal["sim", "live", "unknown"]
NodeMode = Literal["live", "sim"]


def classify_gateway(gateway_name: str) -> GatewayClass:
    """按命名约定分类 gateway_name。lenient 模式：未知不抛异常，由调用方决定。

    >>> classify_gateway("QMT_SIM_csi300")
    'sim'
    >>> classify_gateway("QMT")
    'live'
    >>> classify_gateway("unknown_gw")
    'unknown'
    """
    if not isinstance(gateway_name, str):
        return "unknown"
    if _PATTERN_SIM.match(gateway_name):
        return "sim"
    if gateway_name == _NAME_LIVE:
        return "live"
    return "unknown"


def validate_node_mode(mode: str) -> None:
    """节点 yaml 的 mode 字段严格校验（registry 加载时调用）。

    >>> validate_node_mode("sim")
    >>> validate_node_mode("live")
    """
    if mode not in VALID_NODE_MODES:
        raise ValueError(
            f"node.mode={mode!r} 违反约定，必须是 {VALID_NODE_MODES} 之一。"
        )
