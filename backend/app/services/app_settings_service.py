# -*- coding: utf-8 -*-
"""
运行时配置服务（L2 / Phase 2）

提供 DB 优先、.env 兜底的配置读写：
- get_runtime_setting(key, default) — 读路径，带 5s TTL 进程内缓存
- list_settings()                   — 列出 registry 中所有 key + 当前值 + 默认值
- set_setting(db, key, value, by)   — 写入 + 失效本进程缓存
- delete_setting(db, key)           — 重置为 .env 默认（删除 DB 行）

跨进程同步策略：
- 两个进程（app.main:8000 与 app.live_main:8100）通过 SQLite WAL 共享同一个
  app_settings 表，5s TTL 内会复用本进程缓存，最多滞后 5s 后看到对方写入
- 这对所有 hot-reload 场景都够用：vnpy 轮询周期默认 10s，比 5s 更慢；
  其它字段（图片限制、孤儿宽限）反应延迟 5s 完全可接受
- 强一致需求（如管理面板写入后立即跳页验证）：路由侧调 invalidate_cache()

Registry 设计：
- registry 由 SETTING_REGISTRY 字典定义，仅列出**允许通过 UI 编辑**的键
- 通过 ENV 直接修改 .env 仍然有效；只是会被 DB 覆盖（如果 DB 也写了）
- 类型化 + 校验在 set_setting 层；GET/PATCH 路由用同样的 registry 做 schema 过滤
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.database import AppSetting, get_db_session


# ---------------------------------------------------------------------------
# Registry: which keys may be written via UI / API
# ---------------------------------------------------------------------------

# value_type 同时驱动前端表单输入控件 + 后端反序列化
ValueType = str  # 'int' | 'float' | 'str' | 'bool' | 'list_str'


class SettingSpec:
    """单条配置元数据。

    fields:
        key:           DB 主键 / API 标识
        value_type:    'int' / 'float' / 'str' / 'bool' / 'list_str'
        category:      'paths' / 'vnpy' / 'limits' —— 决定前端分组
        label:         前端展示用中文标签
        description:   长描述，前端显示在帮助文案
        default_attr:  Settings 实例上的属性名，缺省时回退用
        hot_reload:    True 表示无需重启，前端会显示绿标
        sensitive:     True 表示读取时需脱敏（保留以备后用，当前 8 项均非敏感）
        min/max:       数字字段的 UI 校验
    """

    def __init__(
        self,
        key: str,
        value_type: ValueType,
        category: str,
        label: str,
        description: str,
        default_attr: str,
        hot_reload: bool = True,
        sensitive: bool = False,
        min: Optional[float] = None,
        max: Optional[float] = None,
    ):
        self.key = key
        self.value_type = value_type
        self.category = category
        self.label = label
        self.description = description
        self.default_attr = default_attr
        self.hot_reload = hot_reload
        self.sensitive = sensitive
        self.min = min
        self.max = max

    def as_meta_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "value_type": self.value_type,
            "category": self.category,
            "label": self.label,
            "description": self.description,
            "hot_reload": self.hot_reload,
            "sensitive": self.sensitive,
            "min": self.min,
            "max": self.max,
        }


SETTING_REGISTRY: Dict[str, SettingSpec] = {
    # 注意：ml_live_output_root 等「远端数据挂载点」类路径故意不收录在 registry 中。
    # 它们的本质是 mlearnweb 机器上挂载策略服务器输出目录的本地挂载点，由
    # deploy 时 sysadmin 在 .env 配置；通过 web UI 修改它们只会让 mlearnweb
    # 这一侧偏离写方实际路径，造成两侧不一致。此类字段保留为 L1
    # (仅 .env 可改 + 重启进程生效)。
    # Phase 3.3 后 daily_merged_root 已删除 — corp_actions 走 vnpy webtrader
    # /api/v1/reference/corp_actions HTTP, mlearnweb 不再需要本地挂载点.
    # --- vnpy（mlearnweb 本进程行为，非远端依赖）---
    "vnpy_request_timeout": SettingSpec(
        key="vnpy_request_timeout",
        value_type="float",
        category="vnpy",
        label="vnpy 节点请求超时 (秒)",
        description="单次 HTTP 请求 vnpy 节点的超时；过短会导致网络抖动失败，过长会拖慢前端列表刷新。",
        default_attr="vnpy_request_timeout",
        min=1.0,
        max=120.0,
    ),
    "vnpy_poll_interval_seconds": SettingSpec(
        key="vnpy_poll_interval_seconds",
        value_type="int",
        category="vnpy",
        label="vnpy 快照轮询周期 (秒)",
        description="snapshot_loop 每隔多久拉一次 strategies/positions/account 写 SQLite；越小越实时但 CPU/IO 越高。",
        default_attr="vnpy_poll_interval_seconds",
        min=2,
        max=600,
    ),
    "live_trading_event_fingerprint_interval_seconds": SettingSpec(
        key="live_trading_event_fingerprint_interval_seconds",
        value_type="int",
        category="vnpy",
        label="实盘事件指纹检测周期 (秒)",
        description="P1 事件中台在未接入 vnpy WS 前，用 REST 指纹检测策略/持仓/订单/风险变化的周期。",
        default_attr="live_trading_event_fingerprint_interval_seconds",
        min=2,
        max=600,
    ),
    "live_trading_ws_enabled": SettingSpec(
        key="live_trading_ws_enabled",
        value_type="bool",
        category="vnpy",
        label="启用 vnpy WS 事件源",
        description="P2 事件中台是否连接 vnpy /api/v1/ws；关闭后只使用 REST fingerprint fallback。",
        default_attr="live_trading_ws_enabled",
    ),
    "live_trading_event_retention_days": SettingSpec(
        key="live_trading_event_retention_days",
        value_type="int",
        category="vnpy",
        label="实盘事件保留天数",
        description="live_trading_events 表保留最近 N 天事件；0 表示不自动清理。",
        default_attr="live_trading_event_retention_days",
        min=0,
        max=365,
    ),
    "vnpy_snapshot_retention_days": SettingSpec(
        key="vnpy_snapshot_retention_days",
        value_type="int",
        category="vnpy",
        label="实盘快照保留天数",
        description="strategy_equity_snapshots 表中超过此天数的旧记录会在每次轮询时被清理。",
        default_attr="vnpy_snapshot_retention_days",
        min=1,
        max=365,
    ),
    "deployment_sync_interval_seconds": SettingSpec(
        key="deployment_sync_interval_seconds",
        value_type="int",
        category="vnpy",
        label="部署同步周期 (秒)",
        description="多久扫描一次 vnpy 节点策略并反查 bundle_dir 写入 TrainingRecord.deployments；最低 60 秒。",
        default_attr="deployment_sync_interval_seconds",
        min=60,
        max=86400,
    ),
    # --- limits ---
    "max_image_size_mb": SettingSpec(
        key="max_image_size_mb",
        value_type="int",
        category="limits",
        label="单图最大尺寸 (MB)",
        description="memo 图片上传单文件大小上限，超过则拒绝。",
        default_attr="max_image_size_mb",
        min=1,
        max=200,
    ),
    "allowed_image_exts": SettingSpec(
        key="allowed_image_exts",
        value_type="list_str",
        category="limits",
        label="允许的图片扩展名",
        description="memo 图片上传白名单（含小数点，例：.png / .jpg）。",
        default_attr="allowed_image_exts",
    ),
    "orphan_grace_seconds": SettingSpec(
        key="orphan_grace_seconds",
        value_type="int",
        category="limits",
        label="孤儿图片宽限期 (秒)",
        description="memo 编辑期间还没保存的图片在多久内不算孤儿，避免误删。",
        default_attr="orphan_grace_seconds",
        min=10,
        max=3600,
    ),
}


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

_CACHE: Dict[str, Any] = {}
_CACHE_TS: float = 0.0
_CACHE_LOCK = threading.RLock()
_CACHE_TTL_SEC = 5.0


def invalidate_cache() -> None:
    """主动让本进程缓存失效，下次读会重新查 DB。"""
    global _CACHE_TS
    with _CACHE_LOCK:
        _CACHE_TS = 0.0


def _reload_cache_locked() -> None:
    """在 _CACHE_LOCK 持有的前提下，从 DB 读所有 app_settings 行刷新缓存。"""
    global _CACHE_TS
    db_gen = get_db_session()
    db: Session = next(db_gen)
    try:
        rows = db.query(AppSetting).all()
        new_cache: Dict[str, Any] = {}
        for r in rows:
            try:
                new_cache[r.key] = json.loads(r.value_json)
            except Exception:
                # 单条坏数据不影响其它键
                continue
        _CACHE.clear()
        _CACHE.update(new_cache)
        _CACHE_TS = time.time()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Coercion: between Python value <-> JSON-storable form, with type validation
# ---------------------------------------------------------------------------

def _coerce_value(value: Any, value_type: ValueType) -> Any:
    """把 API 入参强制转到目标类型；类型不符则抛 ValueError。

    规则：
        int       -> int(value)
        float     -> float(value)
        str       -> str(value)
        bool      -> 严格布尔（接受 bool / 'true'/'false' 字符串）
        list_str  -> list[str]，list 输入按元素 str() 转换
    """
    if value is None:
        raise ValueError("value 不可为 null")
    try:
        if value_type == "int":
            return int(value)
        if value_type == "float":
            return float(value)
        if value_type == "str":
            return str(value)
        if value_type == "bool":
            if isinstance(value, bool):
                return value
            if isinstance(value, str) and value.lower() in ("true", "false"):
                return value.lower() == "true"
            raise ValueError("bool 字段必须是 true/false")
        if value_type == "list_str":
            if not isinstance(value, list):
                raise ValueError("list_str 字段必须是数组")
            return [str(x) for x in value]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"无法将 {value!r} 转为 {value_type}: {exc}")
    raise ValueError(f"未知 value_type: {value_type}")


def _validate_range(value: Any, spec: SettingSpec) -> None:
    """对数字类型做 min/max 校验，违反则抛 ValueError。"""
    if spec.value_type not in ("int", "float"):
        return
    if spec.min is not None and value < spec.min:
        raise ValueError(f"{spec.key} 不能小于 {spec.min}")
    if spec.max is not None and value > spec.max:
        raise ValueError(f"{spec.key} 不能大于 {spec.max}")


# ---------------------------------------------------------------------------
# Defaults: env-fallback when DB has no row
# ---------------------------------------------------------------------------

def _default_for(spec: SettingSpec) -> Any:
    """从 .env / Settings 读取该键的默认值。list_str 等需做类型规整。"""
    raw = getattr(settings, spec.default_attr, None)
    if spec.value_type == "list_str" and raw is not None:
        # allowed_image_exts 在 Settings 里是 set，这里规整为 sorted list
        try:
            return sorted(list(raw))
        except TypeError:
            return list(raw)
    return raw


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_runtime_setting(key: str, default: Any = None) -> Any:
    """按 DB 优先、.env 兜底的策略读单个键。

    带 5s TTL 进程内缓存，命中则不查 DB。

    若 DB 中也没有该键：
        - default 显式指定 → 返回 default
        - default 为 None 且 key 在 SETTING_REGISTRY → 返回 spec 的 .env 默认
        - 否则返回 None
    """
    with _CACHE_LOCK:
        if time.time() - _CACHE_TS > _CACHE_TTL_SEC:
            _reload_cache_locked()
        if key in _CACHE:
            return _CACHE[key]
    if default is not None:
        return default
    spec = SETTING_REGISTRY.get(key)
    if spec is not None:
        return _default_for(spec)
    return None


def list_settings() -> List[Dict[str, Any]]:
    """列出 registry 中所有键 + 当前生效值 + 来源（db / env）。"""
    with _CACHE_LOCK:
        if time.time() - _CACHE_TS > _CACHE_TTL_SEC:
            _reload_cache_locked()
        cache_snapshot = dict(_CACHE)

    db_gen = get_db_session()
    db: Session = next(db_gen)
    try:
        ts_map: Dict[str, datetime] = {
            r.key: r.updated_at for r in db.query(AppSetting).all()
        }
    finally:
        db.close()

    out: List[Dict[str, Any]] = []
    for spec in SETTING_REGISTRY.values():
        in_db = spec.key in cache_snapshot
        meta = spec.as_meta_dict()
        meta.update({
            "current_value": cache_snapshot[spec.key] if in_db else _default_for(spec),
            "default_value": _default_for(spec),
            "source": "db" if in_db else "env",
            "updated_at": ts_map.get(spec.key).isoformat() if ts_map.get(spec.key) else None,
        })
        out.append(meta)
    return out


def get_setting_with_meta(key: str) -> Optional[Dict[str, Any]]:
    """单键查询版：返回 list_settings() 中匹配的 dict，未注册则 None。"""
    if key not in SETTING_REGISTRY:
        return None
    for item in list_settings():
        if item["key"] == key:
            return item
    return None


def set_setting(
    db: Session,
    key: str,
    value: Any,
    updated_by: Optional[str] = None,
) -> Dict[str, Any]:
    """写入单键并立即失效本进程缓存。

    抛 ValueError：键未注册 / 类型不匹配 / 越界。
    返回 list_settings() 同结构的单项字典。
    """
    spec = SETTING_REGISTRY.get(key)
    if spec is None:
        raise ValueError(f"未注册的 setting key: {key}")
    coerced = _coerce_value(value, spec.value_type)
    _validate_range(coerced, spec)
    payload = json.dumps(coerced, ensure_ascii=False)
    row = db.query(AppSetting).filter(AppSetting.key == key).one_or_none()
    if row is None:
        row = AppSetting(
            key=key,
            value_json=payload,
            value_type=spec.value_type,
            updated_by=updated_by,
        )
        db.add(row)
    else:
        row.value_json = payload
        row.value_type = spec.value_type
        row.updated_by = updated_by
        row.updated_at = datetime.now()
    db.commit()
    invalidate_cache()
    return get_setting_with_meta(key)  # type: ignore[return-value]


def delete_setting(db: Session, key: str) -> Dict[str, Any]:
    """删除 DB 行 → 该键回退到 .env 默认值。返回回退后的 meta 项。"""
    if key not in SETTING_REGISTRY:
        raise ValueError(f"未注册的 setting key: {key}")
    row = db.query(AppSetting).filter(AppSetting.key == key).one_or_none()
    if row is not None:
        db.delete(row)
        db.commit()
    invalidate_cache()
    return get_setting_with_meta(key)  # type: ignore[return-value]
