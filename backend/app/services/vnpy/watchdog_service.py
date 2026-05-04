"""[P1-3 Plan A] mlearnweb watchdog: 周期 probe vnpy 节点 → SMTP 告警.

与 vnpy 端的 alerter (vnpy_ml_strategy/services/alerter.py) 互补：
  - vnpy 端 alerter 监听 EVENT_DAILY_INGEST_FAILED / EVENT_ML_METRICS_ALERT,
    覆盖业务事件 (拉数据失败 / 推理失败); vnpy 进程**挂了**就发不出.
  - 本 service 在 mlearnweb 进程里独立周期 probe vnpy 节点的 /api/v1/node/health,
    覆盖"vnpy 进程挂了 / 网络断了"这种 OS-level 故障.

去抖逻辑 (避免单次网络抖动刷邮箱):
  按 node_id 维度记录"连续 offline 计数". 计数达阈值 (默认 3 次) 才发 1 封告警邮件,
  之后不再重复发, 直到节点 online → 发恢复邮件 → 计数归 0 重新计.

⚠️ TODO 升级路径 (与 vnpy alerter 共用):
  本方案兜底 mlearnweb 进程存活的场景. 但如果 mlearnweb 进程整体挂了 → 兜底也失效.
  长期接 Uptime Kuma / Healthchecks.io 让外部监控 ping mlearnweb /health, 才能彻底
  覆盖"双方都挂"的场景. 详见 mlearnweb/docs/operations.md §告警.
"""
from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from datetime import datetime
from email.message import EmailMessage
from typing import Dict, List, Optional

from app.core.config import settings
from app.services.vnpy.client import get_vnpy_client

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# SMTP helper (mlearnweb 进程不依赖 vnpy main_engine.send_email — 它在 vnpy 进程里)
# ---------------------------------------------------------------------------


def is_smtp_configured() -> bool:
    """SMTP 字段齐全才能发邮件. 缺任一 → 不发邮件, 仅日志."""
    return bool(
        settings.smtp_server
        and settings.smtp_username
        and settings.smtp_password
        and settings.smtp_sender
        and settings.smtp_receiver
    )


def send_email_blocking(subject: str, content: str) -> None:
    """同步发邮件; 调用方应通过 asyncio.to_thread 避免阻塞 event loop.

    SMTP 失败仅 log warn 不抛异常 (告警邮件失败不该让 watchdog 挂掉).
    """
    if not is_smtp_configured():
        logger.warning("[watchdog] SMTP 未配置, 跳过邮件: %s", subject)
        return

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = settings.smtp_sender
    msg["To"] = settings.smtp_receiver
    msg.set_content(content)

    try:
        if settings.smtp_use_ssl:
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(
                settings.smtp_server, settings.smtp_port, context=ctx, timeout=10
            ) as smtp:
                smtp.login(settings.smtp_username, settings.smtp_password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(
                settings.smtp_server, settings.smtp_port, timeout=10
            ) as smtp:
                smtp.starttls(context=ssl.create_default_context())
                smtp.login(settings.smtp_username, settings.smtp_password)
                smtp.send_message(msg)
        logger.info("[watchdog] sent: %s", subject)
    except Exception as exc:
        logger.warning("[watchdog] SMTP 发邮件失败: %s (subject=%s)", exc, subject)


# ---------------------------------------------------------------------------
# Watchdog 状态机
# ---------------------------------------------------------------------------


class NodeWatchdog:
    """单进程内单实例, 维护各 node_id 的连续 offline 计数 + 已告警标记."""

    def __init__(self) -> None:
        # node_id → consecutive offline count (online 时 reset 为 0)
        self._consecutive_offline: Dict[str, int] = {}
        # node_id → 是否已发过 offline 告警邮件 (防止反复发)
        # online 时 reset 为 False (并发 recovery 邮件)
        self._alerted: Dict[str, bool] = {}

    def evaluate(self, statuses: List[Dict]) -> List[Dict]:
        """根据本轮 probe 结果计算需要发的邮件列表.

        返回值: [{kind: "offline"/"recovery", node_id, base_url, last_error, ...}],
        调用方按列表逐条发邮件 (asyncio.to_thread + send_email_blocking).
        """
        emails: List[Dict] = []
        threshold = max(1, int(settings.watchdog_offline_threshold))

        for st in statuses:
            nid = st.get("node_id") or "unknown"
            online = bool(st.get("online"))
            if online:
                # 之前发过 offline 告警, 现在恢复 → 发 recovery 邮件 + 重置状态
                if self._alerted.get(nid):
                    emails.append({
                        "kind": "recovery",
                        "node_id": nid,
                        "base_url": st.get("base_url", ""),
                        "latency_ms": st.get("latency_ms"),
                        "app_version": st.get("app_version"),
                    })
                self._consecutive_offline[nid] = 0
                self._alerted[nid] = False
            else:
                # offline: 累加, 达阈值且未告警过 → 发 offline 邮件
                cnt = self._consecutive_offline.get(nid, 0) + 1
                self._consecutive_offline[nid] = cnt
                if cnt >= threshold and not self._alerted.get(nid):
                    emails.append({
                        "kind": "offline",
                        "node_id": nid,
                        "base_url": st.get("base_url", ""),
                        "last_error": st.get("last_error", ""),
                        "consecutive": cnt,
                        "threshold": threshold,
                    })
                    self._alerted[nid] = True
        return emails


def _build_offline_email(item: Dict) -> tuple[str, str]:
    interval = settings.watchdog_probe_interval_seconds
    nid = item["node_id"]
    detected_window = item["consecutive"] * interval
    subject = f"[mlearnweb 告警] vnpy 节点离线 node_id={nid}"
    content = (
        f"node_id:    {nid}\n"
        f"base_url:   {item.get('base_url', '')}\n"
        f"detected:   连续 {item['consecutive']} 次探活失败 (~{detected_window}s)\n"
        f"threshold:  {item['threshold']} 次\n"
        f"last_error: {item.get('last_error', '')}\n"
        f"detected_at: {datetime.now().isoformat(timespec='seconds')}\n\n"
        f"影响: 该节点上的策略推理 / rebalance / 实时持仓推送中断.\n"
        f"建议: 检查 vnpy 进程是否存活 (NSSM service / PowerShell tasklist), "
        f"network/SSH tunnel 是否断, vnpy /api/v1/node/health 是否能本地 curl 通.\n"
        f"恢复后 mlearnweb watchdog 会自动发恢复邮件.\n"
    )
    return subject, content


def _build_recovery_email(item: Dict) -> tuple[str, str]:
    nid = item["node_id"]
    subject = f"[mlearnweb 恢复] vnpy 节点重新上线 node_id={nid}"
    content = (
        f"node_id:    {nid}\n"
        f"base_url:   {item.get('base_url', '')}\n"
        f"latency_ms: {item.get('latency_ms')}\n"
        f"version:    {item.get('app_version')}\n"
        f"recovered_at: {datetime.now().isoformat(timespec='seconds')}\n\n"
        f"该节点恢复 online, 业务流恢复. 请确认期间是否有数据缺口需补."
    )
    return subject, content


# ---------------------------------------------------------------------------
# 后台 loop
# ---------------------------------------------------------------------------


_global_watchdog: Optional[NodeWatchdog] = None


def get_watchdog() -> NodeWatchdog:
    global _global_watchdog
    if _global_watchdog is None:
        _global_watchdog = NodeWatchdog()
    return _global_watchdog


async def watchdog_loop() -> None:
    """长跑后台 loop, 由 live_main.py lifespan 接入. 失败仅 log 不退出."""
    interval = max(10, int(settings.watchdog_probe_interval_seconds))
    threshold = max(1, int(settings.watchdog_offline_threshold))
    if not is_smtp_configured():
        logger.warning(
            "[watchdog] SMTP 未配置 (.env 里 SMTP_* 字段为空), watchdog 仍周期"
            "probe 节点用于日志记录, 但不会发邮件告警. "
            "生产部署请填 SMTP_SERVER / SMTP_USERNAME / SMTP_PASSWORD / "
            "SMTP_SENDER / SMTP_RECEIVER 并重启."
        )
    logger.info(
        "[watchdog] 启动: 每 %ds probe vnpy 节点, 连续 %d 次 offline 发邮件",
        interval, threshold,
    )

    wd = get_watchdog()

    while True:
        try:
            client = get_vnpy_client()
            statuses = await client.probe_nodes()
            emails = wd.evaluate(statuses)
            for item in emails:
                if item["kind"] == "offline":
                    subject, content = _build_offline_email(item)
                else:
                    subject, content = _build_recovery_email(item)
                # 发送在线程池里跑, 避免阻塞 event loop
                await asyncio.to_thread(send_email_blocking, subject, content)
        except asyncio.CancelledError:
            logger.info("[watchdog] cancelled, 退出")
            raise
        except Exception as exc:
            logger.warning("[watchdog] iteration failed: %s", exc)
        try:
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise
