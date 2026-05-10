from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx
import yaml

from app.core.config import settings


def _check(name: str, status: str, message: str = "", data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        "name": name,
        "status": status,
        "message": message,
        "data": data or {},
    }


def _sqlite_path_from_url(url: str) -> Optional[Path]:
    if not url.startswith("sqlite:///"):
        return None
    raw = url.replace("sqlite:///", "", 1)
    return Path(raw)


def _path_writable(path: Path) -> bool:
    target_dir = path if path.is_dir() else path.parent
    probe = target_dir / ".mlearnweb_write_probe"
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def check_frontend_dist() -> Dict[str, Any]:
    if not settings.frontend_dist_dir:
        return _check("frontend_mount", "skipped", "FRONTEND_DIST_DIR is not configured")
    dist = Path(settings.frontend_dist_dir)
    index = dist / "index.html"
    if dist.is_dir() and index.is_file():
        return _check("frontend_mount", "ok", str(dist))
    return _check("frontend_mount", "warn", f"frontend dist missing or incomplete: {dist}")


def check_db_writable() -> Dict[str, Any]:
    db_path = _sqlite_path_from_url(settings.database_url)
    if db_path is None:
        return _check("db_writable", "warn", "non-sqlite DATABASE_URL; write probe skipped")
    if not _path_writable(db_path):
        return _check("db_writable", "error", f"database directory is not writable: {db_path.parent}")
    try:
        conn = sqlite3.connect(str(db_path))
        conn.execute("PRAGMA user_version")
        conn.close()
    except sqlite3.Error as exc:
        return _check("db_writable", "error", f"sqlite open failed: {exc}")
    return _check("db_writable", "ok", str(db_path))


def check_uploads_writable() -> Dict[str, Any]:
    upload_dir = Path(settings.upload_dir)
    return _check(
        "uploads_writable",
        "ok" if _path_writable(upload_dir) else "error",
        str(upload_dir),
    )


def check_vnpy_nodes_yaml() -> Dict[str, Any]:
    path = Path(settings.vnpy_nodes_config_path)
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[2] / path
    if not path.is_file():
        return _check("vnpy_nodes_yaml", "warn", f"file not found: {path}")
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:  # noqa: BLE001
        return _check("vnpy_nodes_yaml", "error", f"yaml parse failed: {exc}")
    nodes = raw.get("nodes") or []
    enabled = [n for n in nodes if isinstance(n, dict) and n.get("enabled", True)]
    return _check(
        "vnpy_nodes_yaml",
        "ok",
        str(path),
        {"nodes": len(nodes), "enabled": len(enabled)},
    )


def check_mlruns_readable() -> Dict[str, Any]:
    if not settings.mlruns_dir:
        return _check("mlruns_readable", "skipped", "MLRUNS_DIR is not configured")
    path = Path(settings.mlruns_dir)
    if not path.is_dir():
        return _check("mlruns_readable", "warn", f"directory not found: {path}")
    try:
        next(path.iterdir(), None)
    except OSError as exc:
        return _check("mlruns_readable", "error", f"directory not readable: {exc}")
    return _check("mlruns_readable", "ok", str(path))


def check_live_proxy() -> Dict[str, Any]:
    url = settings.live_main_internal_url.rstrip("/") + "/health"
    parsed = urlparse(url)
    if parsed.hostname not in {"127.0.0.1", "localhost"}:
        return _check("live_proxy", "warn", f"unexpected live url host: {url}")
    try:
        with httpx.Client(timeout=1.5) as client:
            resp = client.get(url)
        if resp.status_code == 200:
            return _check("live_proxy", "ok", url)
        return _check("live_proxy", "warn", f"{url} returned HTTP {resp.status_code}")
    except httpx.HTTPError as exc:
        return _check("live_proxy", "warn", f"{url} not reachable: {exc}")


def deployment_health() -> Dict[str, Any]:
    checks: List[Dict[str, Any]] = [
        check_frontend_dist(),
        check_db_writable(),
        check_uploads_writable(),
        check_vnpy_nodes_yaml(),
        check_mlruns_readable(),
        check_live_proxy(),
    ]
    statuses = {c["status"] for c in checks}
    overall = "error" if "error" in statuses else "degraded" if "warn" in statuses else "ok"
    return {
        # Keep status compatible with older probes: ok means the research API
        # process is alive; detailed deployment readiness lives in overall/checks.
        "status": "error" if overall == "error" else "ok",
        "overall": overall,
        "checks": checks,
        "config": {
            "env_file": os.getenv("MLEARNWEB_ENV_FILE", ".env"),
            "database_url": settings.database_url,
            "frontend_dist_dir": settings.frontend_dist_dir,
            "upload_dir": str(settings.upload_dir),
            "vnpy_nodes_config_path": settings.vnpy_nodes_config_path,
            "mlruns_dir": settings.mlruns_dir,
            "live_main_internal_url": settings.live_main_internal_url,
        },
    }
