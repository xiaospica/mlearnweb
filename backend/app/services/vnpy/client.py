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
        self._client = httpx.AsyncClient(
            base_url=node.base_url,
            timeout=settings.vnpy_request_timeout,
        )
        self._token: Optional[str] = None
        self._token_expire_ts: float = 0.0
        self._lock = asyncio.Lock()

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
        try:
            resp = await self._client.request(method, path, json=json, params=params, headers=headers)
        except httpx.HTTPError as e:
            raise VnpyClientError(f"{method} {path} network error: {e}") from e

        if resp.status_code == 401:
            # token expired mid-flight — re-login once and retry
            await self.login()
            headers = self._auth_headers()
            try:
                resp = await self._client.request(method, path, json=json, params=params, headers=headers)
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

    async def probe_nodes(self) -> List[Dict[str, Any]]:
        """Lightweight liveness probe. Never raises."""
        async def _one(nid: str, client: _PerNodeClient) -> Dict[str, Any]:
            try:
                await client.get_node_health()
                status = {
                    "node_id": nid,
                    "base_url": client.node.base_url,
                    "enabled": client.node.enabled,
                    "online": True,
                    "last_probe_ts": int(time.time() * 1000),
                    "last_error": None,
                }
            except Exception as e:
                status = {
                    "node_id": nid,
                    "base_url": client.node.base_url,
                    "enabled": client.node.enabled,
                    "online": False,
                    "last_probe_ts": int(time.time() * 1000),
                    "last_error": str(e),
                }
            self._last_probe[nid] = status
            return status

        results = await asyncio.gather(*(_one(nid, c) for nid, c in self._clients.items()))
        return list(results)

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
    """Return the process-wide VnpyMultiNodeClient, constructing it on first call."""
    global _instance
    if _instance is None:
        nodes = load_nodes()
        _instance = VnpyMultiNodeClient(nodes)
        logger.info("[vnpy.client] initialized with %d nodes", len(nodes))
    return _instance


def reset_vnpy_client() -> None:
    """Used by tests to reset the singleton between cases."""
    global _instance
    _instance = None
