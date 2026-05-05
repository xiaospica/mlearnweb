"""Direct multi-node vnpy_webtrader HTTP client.

Each _PerNodeClient owns one vnpy node's JWT + httpx session. VnpyMultiNodeClient
fans out reads across all registered nodes (producing a FanoutItem[] shape that
mirrors what vnpy_aggregator's /agg/* endpoints would return) and routes writes
by node_id. No shared token or proxy layer — this is intentionally a direct
client so mlearnweb does not depend on running vnpy_aggregator.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import settings
from app.services.vnpy.registry import NodeConfig, load_nodes

logger = logging.getLogger(__name__)


FanoutItem = Dict[str, Any]  # {node_id, ok, data, error}


class VnpyClientError(Exception):
    """Raised by _PerNodeClient on unrecoverable HTTP / auth errors.

    Callers above the per-node layer (fanout reads) usually catch this and
    convert it into an ``ok=False`` FanoutItem entry so partial failures do
    not sink the whole response.
    """


class _PerNodeClient:
    def __init__(self, node: NodeConfig) -> None:
        self.node = node
        # 仅作 AsyncClient 默认超时（也是兜底）；每次请求会按运行时配置覆盖.
        # trust_env=False — 不读 HTTP_PROXY / HTTPS_PROXY env. mlearnweb 跟
        # vnpy 节点之间是直连 (本机 127.0.0.1 / SSH 隧道 / 局域网内网),
        # 不应该被开发机上的全局 proxy (常见 Clash/v2ray 7890) 拦截.
        # 默认 trust_env=True 会让 mlearnweb 走代理 → 7890 拒绝转发到 8001 → 502.
        self._client = httpx.AsyncClient(
            base_url=node.base_url,
            timeout=settings.vnpy_request_timeout,
            trust_env=False,
        )
        self._token: Optional[str] = None
        self._token_expire_ts: float = 0.0
        self._lock = asyncio.Lock()

    def _current_timeout(self) -> float:
        """读 runtime override（带 5s 缓存），缺省回退到 .env。"""
        from app.services.app_settings_service import get_runtime_setting
        return float(
            get_runtime_setting(
                "vnpy_request_timeout", default=settings.vnpy_request_timeout
            )
        )

    @property
    def node_id(self) -> str:
        return self.node.node_id

    async def close(self) -> None:
        await self._client.aclose()

    async def login(self) -> None:
        async with self._lock:
            try:
                resp = await self._client.post(
                    "/api/v1/token",
                    data={
                        "username": self.node.username,
                        "password": self.node.password,
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    timeout=self._current_timeout(),
                )
            except httpx.HTTPError as e:
                raise VnpyClientError(f"login network error: {e}") from e

            if resp.status_code != 200:
                raise VnpyClientError(
                    f"login failed [{resp.status_code}] {resp.text[:200]}"
                )
            data = resp.json()
            self._token = data.get("access_token")
            if not self._token:
                raise VnpyClientError(f"login response missing access_token: {data}")
            # vnpy default: 30 minutes; refresh a bit early
            self._token_expire_ts = time.time() + 25 * 60
            logger.info("[vnpy.client] node=%s login ok", self.node_id)

    def _auth_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"} if self._token else {}

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Any:
        # lazy login
        if not self._token or time.time() >= self._token_expire_ts:
            await self.login()

        headers = self._auth_headers()
        timeout = self._current_timeout()
        try:
            resp = await self._client.request(
                method, path, json=json, params=params, headers=headers, timeout=timeout,
            )
        except httpx.HTTPError as e:
            raise VnpyClientError(f"{method} {path} network error: {e}") from e

        if resp.status_code == 401:
            # token expired mid-flight — re-login once and retry
            await self.login()
            headers = self._auth_headers()
            try:
                resp = await self._client.request(
                    method, path, json=json, params=params, headers=headers, timeout=timeout,
                )
            except httpx.HTTPError as e:
                raise VnpyClientError(f"{method} {path} retry network error: {e}") from e

        if resp.status_code >= 400:
            raise VnpyClientError(
                f"{method} {path} [{resp.status_code}] {resp.text[:300]}"
            )
        if not resp.content:
            return None
        try:
            return resp.json()
        except ValueError:
            return resp.text

    # --- read endpoints -----------------------------------------------------

    async def get_strategies(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/v1/strategy") or []

    async def get_accounts(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/v1/account") or []

    async def get_positions(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/v1/position") or []

    async def get_strategy_positions_history(
        self, strategy_name: str, yyyymmdd: str, gateway_name: str = "",
    ) -> List[Dict[str, Any]]:
        """跨机部署: 跨节点拉指定策略历史日 EOD 持仓快照。"""
        params = {"gateway_name": gateway_name} if gateway_name else None
        return await self._request(
            "GET",
            f"/api/v1/position/history/{strategy_name}/{yyyymmdd}",
            params=params,
        ) or []

    async def get_trades(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/v1/trade") or []

    async def get_orders(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/v1/order") or []

    async def get_engines(self) -> List[Dict[str, Any]]:
        return await self._request("GET", "/api/v1/strategy/engines") or []

    async def get_engine_classes(self, engine: str) -> List[str]:
        return await self._request("GET", f"/api/v1/strategy/engines/{engine}/classes") or []

    async def get_class_params(self, engine: str, class_name: str) -> Dict[str, Any]:
        return await self._request(
            "GET",
            f"/api/v1/strategy/engines/{engine}/classes/{class_name}/params",
        ) or {}

    async def get_node_health(self) -> Dict[str, Any]:
        return await self._request("GET", "/api/v1/node/health") or {}

    # --- Market reference data (Phase 3 解耦) -------------------------------

    async def get_reference_stock_names(self) -> Dict[str, Any]:
        """全市场 ts_code → 中文简称字典 + count + source_path 元信息.

        vnpy_webtrader routes_reference.py 暴露, 数据源 stock_list.parquet.
        mlearnweb 端跨机部署不再直读文件, 走此 HTTP 端点.
        """
        return await self._request("GET", "/api/v1/reference/stock_names") or {}

    # --- ML monitoring (Phase 3.2) -----------------------------------------

    async def get_ml_metrics_latest(self, strategy_name: str) -> Dict[str, Any]:
        return await self._request(
            "GET", f"/api/v1/ml/strategies/{strategy_name}/metrics/latest"
        ) or {}

    async def get_ml_metrics_history(
        self, strategy_name: str, days: int = 30
    ) -> List[Dict[str, Any]]:
        return await self._request(
            "GET",
            f"/api/v1/ml/strategies/{strategy_name}/metrics",
            params={"days": days},
        ) or []

    async def get_ml_prediction_summary(self, strategy_name: str) -> Dict[str, Any]:
        return await self._request(
            "GET", f"/api/v1/ml/strategies/{strategy_name}/prediction/latest/summary"
        ) or {}

    async def get_ml_health(self) -> Dict[str, Any]:
        return await self._request("GET", "/api/v1/ml/health") or {}

    async def get_ml_replay_equity_snapshots(
        self,
        strategy_name: str,
        since: Optional[str] = None,
        limit: int = 10000,
    ) -> List[Dict[str, Any]]:
        """A1/B2 解耦后 vnpy 端本地 replay_history.db 的回放权益快照.

        Used by replay_equity_sync_service to incrementally pull (since=
        local_max(inserted_at)) and UPSERT into mlearnweb.db.
        """
        params: Dict[str, Any] = {"limit": limit}
        if since:
            params["since"] = since
        return await self._request(
            "GET",
            f"/api/v1/ml/strategies/{strategy_name}/replay/equity_snapshots",
            params=params,
        ) or []

    # --- write endpoints ----------------------------------------------------

    async def create_strategy(self, engine: str, body: Dict[str, Any]) -> Dict[str, Any]:
        return await self._request(
            "POST",
            f"/api/v1/strategy/engines/{engine}/instances",
            json=body,
        )

    async def init_strategy(self, engine: str, name: str) -> Dict[str, Any]:
        return await self._request(
            "POST",
            f"/api/v1/strategy/engines/{engine}/instances/{name}/init",
        )

    async def start_strategy(self, engine: str, name: str) -> Dict[str, Any]:
        return await self._request(
            "POST",
            f"/api/v1/strategy/engines/{engine}/instances/{name}/start",
        )

    async def stop_strategy(self, engine: str, name: str) -> Dict[str, Any]:
        return await self._request(
            "POST",
            f"/api/v1/strategy/engines/{engine}/instances/{name}/stop",
        )

    async def edit_strategy(self, engine: str, name: str, setting: Dict[str, Any]) -> Dict[str, Any]:
        return await self._request(
            "PATCH",
            f"/api/v1/strategy/engines/{engine}/instances/{name}",
            json={"setting": setting},
        )

    async def delete_strategy(self, engine: str, name: str) -> Dict[str, Any]:
        return await self._request(
            "DELETE",
            f"/api/v1/strategy/engines/{engine}/instances/{name}",
        )


class VnpyMultiNodeClient:
    """Single-process multi-node aggregator client.

    Holds one _PerNodeClient per enabled vnpy node defined in vnpy_nodes.yaml.
    Read methods synthesize a FanoutItem[] list so higher-level service code
    can treat them identically whether the mlearnweb live-trading process is
    talking to one node or many.
    """

    def __init__(self, nodes: List[NodeConfig]) -> None:
        self._clients: Dict[str, _PerNodeClient] = {
            n.node_id: _PerNodeClient(n) for n in nodes
        }
        # keep last probe result per node for /nodes endpoint
        self._last_probe: Dict[str, Dict[str, Any]] = {}

    @property
    def node_ids(self) -> List[str]:
        return list(self._clients.keys())

    @property
    def nodes(self) -> List[NodeConfig]:
        return [c.node for c in self._clients.values()]

    def get_per_node(self, node_id: str) -> _PerNodeClient:
        if node_id not in self._clients:
            raise VnpyClientError(f"unknown node_id: {node_id}")
        return self._clients[node_id]

    async def close(self) -> None:
        await asyncio.gather(
            *(c.close() for c in self._clients.values()),
            return_exceptions=True,
        )

    # --- fanout reads -------------------------------------------------------

    async def _fanout(self, method_name: str) -> List[FanoutItem]:
        async def _one(nid: str, client: _PerNodeClient) -> FanoutItem:
            try:
                data = await getattr(client, method_name)()
                return {"node_id": nid, "ok": True, "data": data, "error": None}
            except Exception as e:
                logger.warning("[vnpy.client] node=%s %s failed: %s", nid, method_name, e)
                return {"node_id": nid, "ok": False, "data": [], "error": str(e)}

        return await asyncio.gather(*(_one(nid, c) for nid, c in self._clients.items()))

    async def get_strategies(self) -> List[FanoutItem]:
        return await self._fanout("get_strategies")

    async def get_accounts(self) -> List[FanoutItem]:
        return await self._fanout("get_accounts")

    async def get_positions(self) -> List[FanoutItem]:
        return await self._fanout("get_positions")

    async def get_trades(self) -> List[FanoutItem]:
        return await self._fanout("get_trades")

    async def get_orders(self) -> List[FanoutItem]:
        return await self._fanout("get_orders")

    # --- ML fanout reads (Phase 3.2) ----------------------------------------

    async def get_ml_health_all(self) -> List[FanoutItem]:
        """Fanout /api/v1/ml/health across nodes. Used by ml_snapshot_loop to
        discover which (node, strategy_name) pairs to poll.
        """
        return await self._fanout("get_ml_health")

    async def get_ml_metrics_latest_all(self, strategy_name: str) -> List[FanoutItem]:
        """Fanout /api/v1/ml/strategies/{name}/metrics/latest across nodes."""
        async def _one(nid: str, client: _PerNodeClient) -> FanoutItem:
            try:
                data = await client.get_ml_metrics_latest(strategy_name)
                return {"node_id": nid, "ok": True, "data": data, "error": None}
            except Exception as e:
                logger.warning(
                    "[vnpy.client] node=%s get_ml_metrics_latest(%s) failed: %s",
                    nid, strategy_name, e,
                )
                return {"node_id": nid, "ok": False, "data": {}, "error": str(e)}

        return await asyncio.gather(
            *(_one(nid, c) for nid, c in self._clients.items())
        )

    async def get_ml_prediction_summary_all(self, strategy_name: str) -> List[FanoutItem]:
        """Fanout /api/v1/ml/strategies/{name}/prediction/latest/summary across nodes."""
        async def _one(nid: str, client: _PerNodeClient) -> FanoutItem:
            try:
                data = await client.get_ml_prediction_summary(strategy_name)
                return {"node_id": nid, "ok": True, "data": data, "error": None}
            except Exception as e:
                logger.warning(
                    "[vnpy.client] node=%s get_ml_prediction_summary(%s) failed: %s",
                    nid, strategy_name, e,
                )
                return {"node_id": nid, "ok": False, "data": {}, "error": str(e)}

        return await asyncio.gather(
            *(_one(nid, c) for nid, c in self._clients.items())
        )

    async def get_ml_replay_equity_snapshots_all(
        self,
        strategy_name: str,
        since: Optional[str] = None,
        limit: int = 10000,
    ) -> List[FanoutItem]:
        """Fanout replay equity snapshots across nodes (A1/B2 sync service)."""
        async def _one(nid: str, client: _PerNodeClient) -> FanoutItem:
            try:
                data = await client.get_ml_replay_equity_snapshots(
                    strategy_name, since=since, limit=limit,
                )
                return {"node_id": nid, "ok": True, "data": data, "error": None}
            except Exception as e:
                logger.warning(
                    "[vnpy.client] node=%s get_ml_replay_equity_snapshots(%s) failed: %s",
                    nid, strategy_name, e,
                )
                return {"node_id": nid, "ok": False, "data": [], "error": str(e)}

        return await asyncio.gather(
            *(_one(nid, c) for nid, c in self._clients.items())
        )

    # --- single-node ML reads (routed by node_id) --------------------------

    async def get_ml_metrics_history(
        self, node_id: str, strategy_name: str, days: int = 30
    ) -> List[Dict[str, Any]]:
        return await self.get_per_node(node_id).get_ml_metrics_history(strategy_name, days)

    async def get_ml_metrics_latest(
        self, node_id: str, strategy_name: str
    ) -> Dict[str, Any]:
        return await self.get_per_node(node_id).get_ml_metrics_latest(strategy_name)

    async def get_ml_prediction_summary(
        self, node_id: str, strategy_name: str
    ) -> Dict[str, Any]:
        return await self.get_per_node(node_id).get_ml_prediction_summary(strategy_name)

    async def probe_nodes(self) -> List[Dict[str, Any]]:
        """Lightweight liveness probe. Never raises.

        附带返回节点级元数据：
          - mode: 节点 yaml 中的 mode 字段（"live" / "sim"），用于前端节点 header 标记
          - latency_ms: 本次 health 探活耗时（毫秒），离线时 None
          - app_version: vnpy /api/v1/node/health 响应中的 version 字段（缺失时 None）
        """
        async def _one(nid: str, client: _PerNodeClient) -> Dict[str, Any]:
            mode = getattr(client.node, "mode", None)
            t0 = time.perf_counter()
            try:
                health = await client.get_node_health()
                latency_ms = int((time.perf_counter() - t0) * 1000)
                app_version: Optional[str] = None
                if isinstance(health, dict):
                    v = health.get("version") or health.get("app_version")
                    if v is not None:
                        app_version = str(v)
                status = {
                    "node_id": nid,
                    "base_url": client.node.base_url,
                    "enabled": client.node.enabled,
                    "online": True,
                    "last_probe_ts": int(time.time() * 1000),
                    "last_error": None,
                    "mode": mode,
                    "latency_ms": latency_ms,
                    "app_version": app_version,
                }
            except Exception as e:
                status = {
                    "node_id": nid,
                    "base_url": client.node.base_url,
                    "enabled": client.node.enabled,
                    "online": False,
                    "last_probe_ts": int(time.time() * 1000),
                    "last_error": str(e),
                    "mode": mode,
                    "latency_ms": None,
                    "app_version": None,
                }
            self._last_probe[nid] = status
            return status

        results = await asyncio.gather(*(_one(nid, c) for nid, c in self._clients.items()))
        return list(results)

    # --- market reference data (Phase 3 解耦) ------------------------------

    async def get_reference_stock_names_first_ok(self) -> Dict[str, Any]:
        """全市场 ts_code → 中文简称字典 — 任何一个 OK 节点都行 (静态参考数据).

        多节点 fanout 取首个成功响应; 全部节点失败返空 dict + count=0
        (调用方 fallback 到显示 ts_code).
        """
        if not self._clients:
            return {"names": {}, "count": 0, "source_path": None}
        for nid, client in self._clients.items():
            try:
                resp = await client.get_reference_stock_names()
                if resp and resp.get("count", 0) > 0:
                    return resp
            except Exception as e:
                logger.warning(
                    "[vnpy.client] node=%s get_reference_stock_names failed: %s", nid, e,
                )
        return {"names": {}, "count": 0, "source_path": None}

    # --- single-node read helpers (engine introspection) -------------------

    async def get_engines(self, node_id: str) -> List[Dict[str, Any]]:
        return await self.get_per_node(node_id).get_engines()

    async def get_engine_classes(self, node_id: str, engine: str) -> List[str]:
        return await self.get_per_node(node_id).get_engine_classes(engine)

    async def get_class_params(self, node_id: str, engine: str, class_name: str) -> Dict[str, Any]:
        return await self.get_per_node(node_id).get_class_params(engine, class_name)

    # --- writes (routed by node_id) ----------------------------------------

    async def create_strategy(self, node_id: str, engine: str, body: Dict[str, Any]) -> Dict[str, Any]:
        return await self.get_per_node(node_id).create_strategy(engine, body)

    async def init_strategy(self, node_id: str, engine: str, name: str) -> Dict[str, Any]:
        return await self.get_per_node(node_id).init_strategy(engine, name)

    async def start_strategy(self, node_id: str, engine: str, name: str) -> Dict[str, Any]:
        return await self.get_per_node(node_id).start_strategy(engine, name)

    async def stop_strategy(self, node_id: str, engine: str, name: str) -> Dict[str, Any]:
        return await self.get_per_node(node_id).stop_strategy(engine, name)

    async def edit_strategy(
        self, node_id: str, engine: str, name: str, setting: Dict[str, Any]
    ) -> Dict[str, Any]:
        return await self.get_per_node(node_id).edit_strategy(engine, name, setting)

    async def delete_strategy(self, node_id: str, engine: str, name: str) -> Dict[str, Any]:
        return await self.get_per_node(node_id).delete_strategy(engine, name)


# --- module-level singleton ----------------------------------------------------

_instance: Optional[VnpyMultiNodeClient] = None


def get_vnpy_client() -> VnpyMultiNodeClient:
    """Return the process-wide VnpyMultiNodeClient, constructing it on first call.

    Self-heal: 若已构造的 singleton 节点数为 0（启动时 yaml 缺失 / 加载失败），
    每次调用都尝试重新 load_nodes() 一次。一旦 yaml 被填好，后续请求自动恢复，
    用户**无需重启 mlearnweb**。yaml 已含节点的情况下，singleton 已被设置，
    后续不再触发 reload 路径（无性能损耗）。
    """
    global _instance
    if _instance is None:
        nodes = load_nodes()
        _instance = VnpyMultiNodeClient(nodes)
        logger.info("[vnpy.client] initialized with %d nodes", len(nodes))
        return _instance
    if not _instance.node_ids:
        nodes = load_nodes()
        if nodes:
            _instance = VnpyMultiNodeClient(nodes)
            logger.info("[vnpy.client] yaml lazy-reload succeeded, now %d nodes", len(nodes))
    return _instance


def reset_vnpy_client() -> None:
    """Used by tests to reset the singleton between cases."""
    global _instance
    _instance = None
