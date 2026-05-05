"""单端口生产部署 — 把 ``/api/live-trading/*`` 反代到 :8100 (mlearnweb_live).

为什么需要:
    Phase 4 W4.1 — 生产 nginx/IIS 不再用, 直接 app.main (8000) 挂 StaticFiles
    服务前端 dist + 反代实盘 API 到 8100. 浏览器只认 :8000 单 origin, 不存在
    CORS 问题, 也不需要单独的 nginx 配置文件.

    开发期 Vite proxy.config 仍按路径分发 (/api/live-trading → 8100,
    /api/* → 8000), 与生产同行为. 唯一区别: 开发是 Vite 在 5173 → 后端,
    生产是 app.main 在 8000 → 实盘后端.

实现:
    httpx.AsyncClient stream 透传 — 避免缓冲整个响应. ``/api/live-trading/*``
    所有方法 (GET/POST/PATCH/DELETE) 都透传, headers + body + query string
    原样转发. 失败 (live_main 离线) 返 502 ApiResponse 信封, 让前端组件
    显示友好错误 (Tab2 已有 retry).
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from app.core.config import settings

logger = logging.getLogger(__name__)


router = APIRouter()


# 复用单 client 减 connection pool 抖动. trust_env=False 与
# vnpy.client._PerNodeClient 同源 — 防开发机 http_proxy=clash:7890 拦截
# 内部 8000→8100 流量.
_proxy_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    global _proxy_client
    if _proxy_client is None:
        _proxy_client = httpx.AsyncClient(
            base_url=settings.live_main_internal_url,
            trust_env=False,
            timeout=30.0,
        )
    return _proxy_client


# 上游可能停机的 hop-by-hop / 复制不掉的 headers.
_HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",  # httpx 自己设
    "content-length",  # httpx 自己设
}


@router.api_route(
    "/api/live-trading/{full_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
async def proxy_live_trading(full_path: str, request: Request) -> Response:
    """把 ``/api/live-trading/*`` 整段透传到 ``live_main_internal_url``.

    保留原 method / query string / body / 选定 headers (含 X-Ops-Password).
    上游 502 / connect 失败 → 返 ``{success: false, message: ...}`` 信封.
    """
    client = _get_client()
    upstream_path = f"/api/live-trading/{full_path}"
    forwarded_headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _HOP_BY_HOP
    }
    body = await request.body()
    try:
        upstream = await client.request(
            request.method,
            upstream_path,
            params=request.query_params,
            content=body if body else None,
            headers=forwarded_headers,
        )
    except httpx.ConnectError as e:
        logger.warning("[live-proxy] connect failed %s: %s", upstream_path, e)
        return JSONResponse(
            status_code=502,
            content={
                "success": False,
                "message": f"实盘服务 {settings.live_main_internal_url} 未启动",
                "data": None,
                "warning": "live_main 进程不可达 — 检查 mlearnweb_live 服务状态",
            },
        )
    except httpx.HTTPError as e:
        logger.warning("[live-proxy] http error %s: %s", upstream_path, e)
        return JSONResponse(
            status_code=502,
            content={
                "success": False,
                "message": f"反代失败: {e}",
                "data": None,
                "warning": "live_main 响应异常",
            },
        )

    # 透传响应 — 过滤 hop-by-hop headers 防 starlette 重复添加.
    out_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in _HOP_BY_HOP
    }
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=out_headers,
        media_type=upstream.headers.get("content-type"),
    )


async def close_proxy_client() -> None:
    """app.main lifespan shutdown 时释放 httpx pool."""
    global _proxy_client
    if _proxy_client is not None:
        await _proxy_client.aclose()
        _proxy_client = None
