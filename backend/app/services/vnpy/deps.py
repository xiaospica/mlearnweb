"""FastAPI dependencies for the live-trading router."""
from __future__ import annotations

import secrets
from typing import Optional

from fastapi import Header, HTTPException

from app.core.config import settings


async def require_ops_password(
    x_ops_password: Optional[str] = Header(default=None, alias="X-Ops-Password"),
) -> None:
    """Gate for all write operations.

    Single shared secret read from ``settings.live_trading_ops_password``.
    Empty / unset → all writes return 503 with a clear message so the user
    knows to configure it. Wrong or missing header → 401.

    This is a misoperation guard, not a user authentication system. Do not
    log the header value; ``secrets.compare_digest`` avoids timing leaks.
    """
    cfg = settings.live_trading_ops_password
    if not cfg:
        raise HTTPException(status_code=503, detail="未配置运维口令，写操作已禁用")
    if not x_ops_password or not secrets.compare_digest(x_ops_password, cfg):
        raise HTTPException(status_code=401, detail="运维口令错误或缺失")
