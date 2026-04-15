from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import List

import yaml

from app.core.config import settings

logger = logging.getLogger(__name__)


@dataclass
class NodeConfig:
    node_id: str
    base_url: str
    username: str
    password: str
    enabled: bool = True


class NodeRegistryError(Exception):
    pass


def load_nodes() -> List[NodeConfig]:
    """Load enabled vnpy node definitions from the yaml registry file.

    Returns an empty list (with a warning log) if the file is missing or
    malformed, so the live trading process can still start and surface the
    issue via the /nodes endpoint instead of crashing.
    """
    path = settings.vnpy_nodes_config_path
    if not os.path.isabs(path):
        # resolve relative to backend root (parent of app/)
        backend_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        path = os.path.normpath(os.path.join(backend_root, path))

    if not os.path.exists(path):
        logger.warning("[vnpy.registry] config file not found: %s", path)
        return []

    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f) or {}
    except Exception as e:
        logger.exception("[vnpy.registry] failed to parse %s: %s", path, e)
        return []

    nodes_raw = raw.get("nodes") or []
    if not isinstance(nodes_raw, list):
        logger.warning("[vnpy.registry] 'nodes' must be a list in %s", path)
        return []

    result: List[NodeConfig] = []
    seen_ids: set[str] = set()
    for idx, item in enumerate(nodes_raw):
        if not isinstance(item, dict):
            logger.warning("[vnpy.registry] skipping non-dict entry at index %d", idx)
            continue
        try:
            node = NodeConfig(
                node_id=str(item["node_id"]).strip(),
                base_url=str(item["base_url"]).rstrip("/"),
                username=str(item.get("username", "")),
                password=str(item.get("password", "")),
                enabled=bool(item.get("enabled", True)),
            )
        except KeyError as e:
            logger.warning("[vnpy.registry] node entry missing field %s at index %d", e, idx)
            continue
        if not node.node_id or not node.base_url:
            logger.warning("[vnpy.registry] node entry has empty node_id/base_url at index %d", idx)
            continue
        if node.node_id in seen_ids:
            logger.warning("[vnpy.registry] duplicate node_id=%s, ignoring later occurrence", node.node_id)
            continue
        seen_ids.add(node.node_id)
        if node.enabled:
            result.append(node)

    logger.info("[vnpy.registry] loaded %d enabled nodes from %s", len(result), path)
    return result
