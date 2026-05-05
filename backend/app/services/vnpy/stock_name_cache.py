"""股票中文简称内存缓存 — Phase 3 解耦后的 mlearnweb 唯一来源.

设计原则: mlearnweb 跨机部署不应假设能直读 vnpy 推理机的 stock_list.parquet,
所有股票名 lookup 都走 vnpy_webtrader 的 ``GET /api/v1/reference/stock_names``
HTTP 端点.

由于 ``get_stock_name_map()`` 历史上是同步函数 (从 _render_positions 等同步上下文
里调用), 不能直接做 HTTP 请求阻塞事件循环. 改为:

    1. 后台 async 协程 (``stock_name_refresh_loop``) 每 1h 拉一次 vnpy 端,
       结果存 ``_GLOBAL_NAME_MAP`` 模块级 dict
    2. 同步 ``get_stock_name_map()`` 直接返 ``_GLOBAL_NAME_MAP`` 的 copy

启动时 vnpy 节点不可达 → 字典为空, 调用方 fallback 到显示 ts_code (无报错);
节点可达后下个 tick 自动填充.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Dict

logger = logging.getLogger(__name__)


# 模块级共享 dict — 后台协程写, 同步读. 加锁是因为 dict.update 不原子.
_GLOBAL_NAME_MAP: Dict[str, str] = {}
_GLOBAL_LOCK = threading.Lock()
_INITIALIZED: bool = False

REFRESH_INTERVAL_SECONDS = 3600  # 1 小时一次, 股票名静态参考数据极少变


def get_stock_names_snapshot() -> Dict[str, str]:
    """返回当前缓存的 ts_code → 中文简称 dict 的 copy.

    返空 dict 表示 vnpy 节点尚未拉到 / 全部不可达 — 调用方应 graceful fallback
    到显示 ts_code (前端组件已处理).
    """
    with _GLOBAL_LOCK:
        return dict(_GLOBAL_NAME_MAP)


async def refresh_stock_names_once() -> int:
    """触发一次 HTTP 拉取, 更新内存 dict. 返回拉到的字典大小.

    失败时 dict 不变 (保留上次成功值), 仅 log warn.
    """
    from app.services.vnpy.client import get_vnpy_client

    client = get_vnpy_client()
    try:
        resp = await client.get_reference_stock_names_first_ok()
    except Exception as e:
        logger.warning("[stock_name_cache] HTTP 拉取失败: %s", e)
        return len(_GLOBAL_NAME_MAP)

    names = resp.get("names") if isinstance(resp, dict) else None
    if not isinstance(names, dict):
        return len(_GLOBAL_NAME_MAP)
    if not names:
        # 远端返空 — 不覆盖本地 (可能 vnpy 推理机暂时拿不到 parquet)
        logger.debug("[stock_name_cache] 远端返空字典, 保留本地 cache")
        return len(_GLOBAL_NAME_MAP)

    with _GLOBAL_LOCK:
        _GLOBAL_NAME_MAP.clear()
        _GLOBAL_NAME_MAP.update(names)
    logger.info(
        "[stock_name_cache] refreshed from vnpy webtrader: %d entries (source=%s)",
        len(names), resp.get("source_path"),
    )
    return len(names)


async def stock_name_refresh_loop() -> None:
    """后台协程, 启动时立即拉一次, 之后每 1h 一次.

    在 ``app.live_main`` 的 lifespan 里 ``asyncio.create_task`` 起来;
    与其他周期 sync loop (``snapshot_loop`` / ``ml_snapshot_loop`` 等) 同级.
    """
    global _INITIALIZED
    logger.info(
        "[stock_name_cache] refresh loop started (interval=%ss)",
        REFRESH_INTERVAL_SECONDS,
    )
    # 启动立即拉一次让前端早点见到中文简称
    try:
        await refresh_stock_names_once()
        _INITIALIZED = True
    except Exception as e:
        logger.warning("[stock_name_cache] initial refresh failed: %s", e)

    while True:
        try:
            await asyncio.sleep(REFRESH_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise
        try:
            await refresh_stock_names_once()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("[stock_name_cache] refresh iteration failed: %s", e)
