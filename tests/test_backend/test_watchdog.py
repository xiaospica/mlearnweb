"""[P1-3 Plan A] mlearnweb watchdog 单元测试.

覆盖:
  - NodeWatchdog.evaluate 状态机:
    - 连续 N 次 offline 之前不发
    - 第 N 次发 offline 邮件, 之后不重复
    - online 时触发 recovery 邮件并重置计数
    - 多节点状态独立维护
  - is_smtp_configured: 字段齐全 / 缺失分支
  - send_email_blocking: SMTP 未配置时不调 smtplib (mock smtplib.SMTP_SSL)
  - 邮件 builder: subject/content 含关键字段
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

MLEARNWEB_DIR = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = MLEARNWEB_DIR / "backend"
sys.path.insert(0, str(BACKEND_DIR))


def _status(nid: str, online: bool, **kw):
    base = {"node_id": nid, "base_url": f"http://{nid}", "online": online}
    base.update(kw)
    return base


# ---------------------------------------------------------------------------
# NodeWatchdog state machine
# ---------------------------------------------------------------------------


def test_consecutive_offline_below_threshold_no_email(monkeypatch):
    from app.services.vnpy import watchdog_service
    monkeypatch.setattr(watchdog_service.settings, "watchdog_offline_threshold", 3)
    wd = watchdog_service.NodeWatchdog()

    for _ in range(2):
        assert wd.evaluate([_status("a", False, last_error="boom")]) == []


def test_offline_at_threshold_emits_once(monkeypatch):
    from app.services.vnpy import watchdog_service
    monkeypatch.setattr(watchdog_service.settings, "watchdog_offline_threshold", 3)
    wd = watchdog_service.NodeWatchdog()

    wd.evaluate([_status("a", False)])
    wd.evaluate([_status("a", False)])
    emails = wd.evaluate([_status("a", False, last_error="timeout")])
    assert len(emails) == 1
    assert emails[0]["kind"] == "offline"
    assert emails[0]["consecutive"] == 3
    assert emails[0]["threshold"] == 3
    assert emails[0]["last_error"] == "timeout"

    # 第 4 次仍 offline, 不重复发
    assert wd.evaluate([_status("a", False)]) == []


def test_online_after_offline_emits_recovery(monkeypatch):
    from app.services.vnpy import watchdog_service
    monkeypatch.setattr(watchdog_service.settings, "watchdog_offline_threshold", 2)
    wd = watchdog_service.NodeWatchdog()

    wd.evaluate([_status("a", False)])
    wd.evaluate([_status("a", False)])  # 阈值 2: 此次发 offline
    emails = wd.evaluate([_status("a", True, latency_ms=42, app_version="1.2.3")])
    assert len(emails) == 1
    assert emails[0]["kind"] == "recovery"
    assert emails[0]["latency_ms"] == 42

    # 持续 online, 不再发
    assert wd.evaluate([_status("a", True)]) == []


def test_online_without_prior_offline_no_email(monkeypatch):
    """节点一直 online, 不该发任何邮件."""
    from app.services.vnpy import watchdog_service
    monkeypatch.setattr(watchdog_service.settings, "watchdog_offline_threshold", 3)
    wd = watchdog_service.NodeWatchdog()
    for _ in range(5):
        assert wd.evaluate([_status("a", True)]) == []


def test_recovery_then_offline_again_starts_fresh_count(monkeypatch):
    """recovery 后重新 offline 应从 0 重新计数, 阈值再次到才发邮件."""
    from app.services.vnpy import watchdog_service
    monkeypatch.setattr(watchdog_service.settings, "watchdog_offline_threshold", 2)
    wd = watchdog_service.NodeWatchdog()

    wd.evaluate([_status("a", False)])
    wd.evaluate([_status("a", False)])  # 发 offline
    wd.evaluate([_status("a", True)])   # 发 recovery, reset

    # 重新 offline: 第一次不发, 第二次到阈值才发
    assert wd.evaluate([_status("a", False)]) == []
    emails = wd.evaluate([_status("a", False)])
    assert len(emails) == 1 and emails[0]["kind"] == "offline"


def test_multi_node_state_isolated(monkeypatch):
    from app.services.vnpy import watchdog_service
    monkeypatch.setattr(watchdog_service.settings, "watchdog_offline_threshold", 2)
    wd = watchdog_service.NodeWatchdog()

    # a online, b offline 累加
    wd.evaluate([_status("a", True), _status("b", False)])
    emails = wd.evaluate([_status("a", True), _status("b", False)])
    assert len(emails) == 1 and emails[0]["node_id"] == "b"


# ---------------------------------------------------------------------------
# SMTP helpers
# ---------------------------------------------------------------------------


def test_is_smtp_configured_all_set(monkeypatch):
    from app.services.vnpy import watchdog_service
    s = watchdog_service.settings
    monkeypatch.setattr(s, "smtp_server", "smtp.x.com")
    monkeypatch.setattr(s, "smtp_username", "u")
    monkeypatch.setattr(s, "smtp_password", "p")
    monkeypatch.setattr(s, "smtp_sender", "f@x.com")
    monkeypatch.setattr(s, "smtp_receiver", "t@x.com")
    assert watchdog_service.is_smtp_configured() is True


def test_is_smtp_configured_missing_returns_false(monkeypatch):
    from app.services.vnpy import watchdog_service
    monkeypatch.setattr(watchdog_service.settings, "smtp_server", None)
    assert watchdog_service.is_smtp_configured() is False


def test_send_email_skips_when_unconfigured(monkeypatch):
    from app.services.vnpy import watchdog_service
    monkeypatch.setattr(watchdog_service.settings, "smtp_server", None)
    with patch.object(watchdog_service.smtplib, "SMTP_SSL") as mock_ssl, \
         patch.object(watchdog_service.smtplib, "SMTP") as mock_plain:
        watchdog_service.send_email_blocking("s", "c")
    mock_ssl.assert_not_called()
    mock_plain.assert_not_called()


def test_send_email_uses_smtp_ssl_when_configured(monkeypatch):
    from app.services.vnpy import watchdog_service
    s = watchdog_service.settings
    monkeypatch.setattr(s, "smtp_server", "smtp.x.com")
    monkeypatch.setattr(s, "smtp_port", 465)
    monkeypatch.setattr(s, "smtp_username", "u")
    monkeypatch.setattr(s, "smtp_password", "p")
    monkeypatch.setattr(s, "smtp_sender", "f@x.com")
    monkeypatch.setattr(s, "smtp_receiver", "t@x.com")
    monkeypatch.setattr(s, "smtp_use_ssl", True)

    smtp_ctx = MagicMock()
    smtp_ctx.__enter__ = MagicMock(return_value=smtp_ctx)
    smtp_ctx.__exit__ = MagicMock(return_value=False)
    with patch.object(watchdog_service.smtplib, "SMTP_SSL", return_value=smtp_ctx) as mock_ssl:
        watchdog_service.send_email_blocking("subject", "body")
    mock_ssl.assert_called_once()
    smtp_ctx.login.assert_called_once_with("u", "p")
    smtp_ctx.send_message.assert_called_once()


def test_send_email_swallow_smtp_exceptions(monkeypatch, caplog):
    """SMTP 失败不该让 watchdog 挂掉."""
    from app.services.vnpy import watchdog_service
    s = watchdog_service.settings
    monkeypatch.setattr(s, "smtp_server", "smtp.x.com")
    monkeypatch.setattr(s, "smtp_username", "u")
    monkeypatch.setattr(s, "smtp_password", "p")
    monkeypatch.setattr(s, "smtp_sender", "f@x.com")
    monkeypatch.setattr(s, "smtp_receiver", "t@x.com")

    with patch.object(watchdog_service.smtplib, "SMTP_SSL",
                      side_effect=ConnectionRefusedError("nope")):
        # 不应抛
        watchdog_service.send_email_blocking("s", "c")


# ---------------------------------------------------------------------------
# Email builder
# ---------------------------------------------------------------------------


def test_offline_email_subject_and_content(monkeypatch):
    from app.services.vnpy import watchdog_service
    monkeypatch.setattr(watchdog_service.settings, "watchdog_probe_interval_seconds", 60)
    item = {
        "node_id": "cloudA",
        "base_url": "http://1.2.3.4:8001",
        "consecutive": 3,
        "threshold": 3,
        "last_error": "timed out",
    }
    subject, content = watchdog_service._build_offline_email(item)
    assert "cloudA" in subject
    assert "1.2.3.4" in content
    assert "timed out" in content
    assert "180s" in content   # 3 * 60


def test_recovery_email_subject_and_content():
    from app.services.vnpy import watchdog_service
    item = {
        "node_id": "cloudA",
        "base_url": "http://x",
        "latency_ms": 42,
        "app_version": "1.2.3",
    }
    subject, content = watchdog_service._build_recovery_email(item)
    assert "cloudA" in subject
    assert "重新上线" in subject
    assert "42" in content
    assert "1.2.3" in content
