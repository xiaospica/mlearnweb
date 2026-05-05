# -*- coding: utf-8 -*-
"""
应用配置 API

Phase 1：GET /api/settings/env — 只读环境快照（启动期固化字段，需重启）
Phase 2：GET/PATCH/DELETE /api/settings/runtime/{key} — 运行期可热改字段
        GET /api/settings/runtime — 列出所有 runtime 键

口径：
- env 路径类字段（mlruns_dir / database_url / upload_dir 等）按 settings 原值返回，
  database_url 中的密码字段（若以 user:pass@host 格式出现）会被脱敏
- 敏感字段（live_trading_ops_password / vnpy_nodes 内的密码）只返回 has_value 标志
- python.executable 取自 sys.executable；platform 取自 platform 模块
- git.sha / git.branch 通过本地 git 命令获取（mlearnweb submodule 内）；失败则返回 None
- env 响应中标记每条 path 是否有 runtime 覆盖（editable + 当前来源），
  让前端可以提示「已在 Runtime 编辑」
"""

from __future__ import annotations

import os
import platform
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.database import get_db_session
from app.schemas.schemas import ApiResponse
from app.services import app_settings_service as app_settings_svc

router = APIRouter(prefix="/api/settings", tags=["Settings"])


_DB_URL_PASSWORD_RE = re.compile(r"://([^:/@\s]+):([^@/\s]+)@")


# L1 字段（必须改 .env + 重启进程）的元数据。
#
# 字段类型：
#  - 'mlearnweb_owned'：本仓库是权威配置点（如 mlruns_dir, database_url）
#  - 'remote_mount_view'：本字段只是 mlearnweb 这一侧看到的本地路径；
#    权威源头在另一仓库；mlearnweb 改这里只改自己的「读视图」，
#    不会改写方实际产出位置。需要由 sysadmin 保证两侧一致。
#
# source_of_truth：仅 remote_mount_view 类型必填，描述真正的写方在哪里。
_L1_FIELD_META: Dict[str, Dict[str, Any]] = {
    # ===== mlearnweb 自有的部署配置 =====
    "mlruns_dir": {
        "env_var": "MLRUNS_DIR",
        "restart": "main",
        "ownership": "mlearnweb_owned",
        "hint": "MLflow client 启动时绑定；mlearnweb 与训练侧共用此目录",
    },
    "database_url": {
        "env_var": "DATABASE_URL",
        "restart": "both",
        "ownership": "mlearnweb_owned",
        "hint": "SQLAlchemy engine 启动时创建，两个进程都需重启",
    },
    "upload_dir": {
        "env_var": "UPLOAD_DIR",
        "restart": "main",
        "ownership": "mlearnweb_owned",
        "hint": "FastAPI StaticFiles 启动时挂载",
    },
    "vnpy_nodes_config_path": {
        "env_var": "VNPY_NODES_CONFIG_PATH",
        "restart": "live_main",
        "ownership": "mlearnweb_owned",
        "hint": "live_main 启动时读 yaml 构造 VnpyMultiNodeClient",
    },
    # ===== 远端策略机产物的本地挂载视图（不是权威配置） =====
    # Phase 3.3 后 daily_merged_root 已删除 — corp_actions 走 vnpy webtrader
    # /api/v1/reference/corp_actions, mlearnweb 不再直读策略机 parquet.
    "ml_live_output_root": {
        "env_var": "ML_LIVE_OUTPUT_ROOT",
        "restart": "live_main",
        "ownership": "remote_mount_view",
        "source_of_truth": {
            "repo": "vnpy_strategy_dev",
            "writer_path": "vnpy_ml_strategy/predictors/qlib_predictor.py:91 + template.py:110",
            "writer_env": "MLStrategyTemplate.output_root（策略实例参数，vnpy web UI 配置）",
            "default_writer_value": "D:/ml_output",
            "note": "vnpy 实盘 ML 策略每日运行 qlib subprocess 把 predictions.parquet 落到该目录。mlearnweb 这边的 ML_LIVE_OUTPUT_ROOT 只是「我这台机器上看到这个目录的路径」，权威值由策略侧 vnpy web UI 配置（不同策略实例可能不同 output_root）。",
        },
        "hint": "mlearnweb 看到的策略推理产物本地视图；权威配置在 vnpy 策略实例参数",
    },
    # ===== 安全与跨域（mlearnweb 自己的 deployment 配置） =====
    "live_trading_ops_password": {
        "env_var": "LIVE_TRADING_OPS_PASSWORD",
        "restart": "live_main",
        "ownership": "mlearnweb_owned",
        "hint": "运维口令，未配置等于关闭实盘写鉴权",
    },
    "cors_origins": {
        "env_var": "CORS_ORIGINS",
        "restart": "both",
        "ownership": "mlearnweb_owned",
        "hint": "CORS middleware 启动时载入；JSON 数组格式",
    },
}


def _get_env_file_info() -> Dict[str, Any]:
    """返回 .env 文件位置与是否存在。

    pydantic-settings v2 默认从启动时的 cwd 找 .env；mlearnweb 的开发命令是
    `cd mlearnweb/backend && uvicorn ...`，所以 .env 落在 backend/ 目录。
    本函数返回**绝对路径**让用户能直接在文件管理器打开。
    """
    backend_root = Path(__file__).resolve().parents[2]  # routers -> app -> backend
    env_path = backend_root / ".env"
    example_path = backend_root / ".env.example"
    return {
        "env_file_path": str(env_path),
        "env_file_exists": env_path.is_file(),
        "env_example_path": str(example_path) if example_path.is_file() else None,
        "backend_dir": str(backend_root),
    }


def _mask_db_url(url: str) -> str:
    """脱敏 SQLAlchemy URL 中的密码段（user:pass@host → user:****@host）。"""
    return _DB_URL_PASSWORD_RE.sub(lambda m: f"://{m.group(1)}:****@", url)


def _get_git_info() -> Dict[str, Optional[str]]:
    """从 mlearnweb 仓库（即 backend 上一级）读 git SHA / branch。失败均返回 None。"""
    repo_root = Path(__file__).resolve().parents[2]  # app/routers -> app -> backend -> mlearnweb
    try:
        sha = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(repo_root),
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).decode().strip()
    except Exception:
        sha = None
    try:
        branch = subprocess.check_output(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=str(repo_root),
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).decode().strip()
    except Exception:
        branch = None
    return {"sha": sha, "branch": branch}


def _get_vnpy_nodes_summary() -> Dict[str, Any]:
    """读 vnpy_nodes.yaml 摘要（节点数 / id / enabled / mode），不暴露密码。"""
    cfg_path = settings.vnpy_nodes_config_path
    summary: Dict[str, Any] = {
        "config_path": cfg_path,
        "exists": os.path.isfile(cfg_path),
        "nodes": [],
        "error": None,
    }
    if not summary["exists"]:
        return summary
    try:
        import yaml  # type: ignore

        with open(cfg_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        for n in data.get("nodes", []) or []:
            summary["nodes"].append({
                "node_id": n.get("node_id"),
                "base_url": n.get("base_url"),
                "username": n.get("username"),
                "has_password": bool(n.get("password")),
                "enabled": bool(n.get("enabled", True)),
                "mode": n.get("mode"),
            })
    except Exception as exc:  # noqa: BLE001
        summary["error"] = str(exc)
    return summary


def _build_env_payload() -> Dict[str, Any]:
    """构造 /env 响应。

    对 L2-overridable 字段（registry 中的 8 项）：值是 effective 值（DB > .env），
    并通过 runtime_overrides 字段单独标记哪些键当前来自 DB。
    """
    # registry 中所有键的 effective 值快照（带 source / default / updated_at）
    runtime_items = app_settings_svc.list_settings()
    runtime_index: Dict[str, Dict[str, Any]] = {it["key"]: it for it in runtime_items}

    def _eff(key: str, env_fallback: Any) -> Any:
        """L2 字段读 effective；非 L2 字段直接返回 env 值。"""
        if key in runtime_index:
            return runtime_index[key]["current_value"]
        return env_fallback

    return {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "python": {
            "executable": sys.executable,
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
        },
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "node": platform.node(),
        },
        "git": _get_git_info(),
        "paths": {
            # restart-required（L1）—— 始终用 settings 原值
            "mlruns_dir": settings.mlruns_dir,
            "database_url": _mask_db_url(settings.database_url),
            "upload_dir": str(settings.upload_dir),
            "vnpy_nodes_config_path": settings.vnpy_nodes_config_path,
            # L2 可热改 —— 走 effective
            "ml_live_output_root": _eff("ml_live_output_root", settings.ml_live_output_root),
        },
        "vnpy": {
            "request_timeout": _eff("vnpy_request_timeout", settings.vnpy_request_timeout),
            "poll_interval_seconds": _eff(
                "vnpy_poll_interval_seconds", settings.vnpy_poll_interval_seconds
            ),
            "snapshot_retention_days": _eff(
                "vnpy_snapshot_retention_days", settings.vnpy_snapshot_retention_days
            ),
            "ops_password_set": bool(settings.live_trading_ops_password),
            "nodes": _get_vnpy_nodes_summary(),
        },
        "limits": {
            "max_image_size_mb": _eff("max_image_size_mb", settings.max_image_size_mb),
            "allowed_image_exts": _eff(
                "allowed_image_exts", sorted(list(settings.allowed_image_exts))
            ),
            "orphan_grace_seconds": _eff(
                "orphan_grace_seconds", settings.orphan_grace_seconds
            ),
        },
        "sync": {
            "deployment_sync_interval_seconds": _eff(
                "deployment_sync_interval_seconds",
                settings.deployment_sync_interval_seconds,
            ),
        },
        "cors_origins": settings.cors_origins,
        # 标记：哪些键已被 DB 覆盖；前端用此显示「已在 Runtime 编辑」徽标
        "runtime_overrides": {
            it["key"]: {
                "source": it["source"],
                "default_value": it["default_value"],
                "updated_at": it["updated_at"],
            }
            for it in runtime_items
        },
        # L1 字段元数据 + .env 路径，前端「如何编辑只读字段」面板用
        "l1_field_meta": _L1_FIELD_META,
        "env_file_info": _get_env_file_info(),
    }


# ---------------------------------------------------------------------------
# Phase 1: read-only env endpoint
# ---------------------------------------------------------------------------

@router.get("/env", response_model=ApiResponse)
def get_env_info() -> ApiResponse:
    """返回当前研究侧后端进程的环境/配置信息。"""
    return ApiResponse(success=True, message="ok", data=_build_env_payload())


# ---------------------------------------------------------------------------
# Phase 2: runtime settings (DB-backed, hot-reloadable)
# ---------------------------------------------------------------------------


class RuntimeSettingPatch(BaseModel):
    """PATCH 请求体：仅 value 一个字段，类型由 registry 决定。"""

    value: Any


@router.get("/runtime", response_model=ApiResponse)
def list_runtime_settings() -> ApiResponse:
    """列出所有运行期可热改键 + 当前生效值 + 来源（db / env）。"""
    items = app_settings_svc.list_settings()
    return ApiResponse(success=True, message="ok", data={"items": items})


@router.get("/runtime/{key}", response_model=ApiResponse)
def get_runtime_setting_endpoint(key: str) -> ApiResponse:
    """获取单个键的元信息 + 当前值。未注册返回 404。"""
    item = app_settings_svc.get_setting_with_meta(key)
    if item is None:
        raise HTTPException(status_code=404, detail=f"未注册的 setting key: {key}")
    return ApiResponse(success=True, message="ok", data=item)


@router.patch("/runtime/{key}", response_model=ApiResponse)
def patch_runtime_setting_endpoint(
    key: str,
    body: RuntimeSettingPatch = Body(...),
    db: Session = Depends(get_db_session),
) -> ApiResponse:
    """写入单键。校验失败返回 422。"""
    try:
        item = app_settings_svc.set_setting(db, key, body.value, updated_by=None)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return ApiResponse(success=True, message="updated", data=item)


@router.delete("/runtime/{key}", response_model=ApiResponse)
def delete_runtime_setting_endpoint(
    key: str,
    db: Session = Depends(get_db_session),
) -> ApiResponse:
    """重置为 .env 默认（删除 DB 行）。"""
    try:
        item = app_settings_svc.delete_setting(db, key)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return ApiResponse(success=True, message="reset to env default", data=item)
