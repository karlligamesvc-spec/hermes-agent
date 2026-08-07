"""Contract tests for the v0.20 Feishu cold-start overlay (hc-384/385)."""

from __future__ import annotations

import asyncio
import inspect
import types

import pytest

from apex_overlay import gateway_bootstrap


def test_seam_target_and_dependencies_exist():
    from gateway.run import GatewayRunner

    create = getattr(GatewayRunner, gateway_bootstrap._TARGET_CREATE_METHOD, None)
    assert create is not None
    assert list(inspect.signature(create).parameters)[:3] == ["self", "platform", "config"]

    expected = {
        "_connect_adapter_with_timeout": ["self", "adapter", "platform"],
        "_safe_adapter_disconnect": ["self", "adapter", "platform"],
        "_sync_voice_mode_state_to_adapter": ["self", "adapter"],
        "_wire_teams_pipeline_runtime": ["self"],
        "_make_adapter_auth_check": ["self", "platform"],
        "_adapter_credential_claim": ["platform", "adapter"],
        "_adapter_listener_claim": ["platform", "adapter"],
    }
    for name, prefix in expected.items():
        fn = getattr(GatewayRunner, name, None)
        assert fn is not None, f"GatewayRunner.{name} moved; update the overlay"
        assert list(inspect.signature(fn).parameters)[: len(prefix)] == prefix

    status = inspect.signature(GatewayRunner._update_platform_runtime_status).parameters
    assert {"platform_state", "error_code", "error_message"}.issubset(status)
    assert "platform" in inspect.signature(GatewayRunner._schedule_resume_pending_sessions).parameters


def test_apply_wraps_create_adapter_and_binds_helpers_idempotently():
    from gateway.run import GatewayRunner

    original = GatewayRunner._create_adapter
    gateway_bootstrap._APPLIED = False
    try:
        assert gateway_bootstrap.apply() is True
        wrapped = GatewayRunner._create_adapter
        assert getattr(wrapped, gateway_bootstrap._MARK, False) is True
        for name in gateway_bootstrap._HELPER_NAMES:
            assert hasattr(GatewayRunner, name)
        assert gateway_bootstrap.apply() is True
        assert GatewayRunner._create_adapter is wrapped
    finally:
        GatewayRunner._create_adapter = original
        gateway_bootstrap._APPLIED = False


class _Platform:
    def __init__(self, value: str):
        self.value = value

    def __hash__(self):
        return hash(self.value)


class _Adapter:
    def __init__(self, platform):
        self.platform = platform
        self.connected = False
        self.has_fatal_error = False
        self._platform_lock_takeover_allowed = False

    def set_message_handler(self, *_a): pass
    def set_fatal_error_handler(self, *_a): pass
    def set_session_store(self, *_a): pass
    def set_busy_session_handler(self, *_a): pass
    def set_reaction_handler(self, *_a): pass
    def set_topic_recovery_fn(self, *_a): pass
    def set_authorization_check(self, *_a): pass


def _stub_runner():
    stub = types.SimpleNamespace()
    stub.adapters = {}
    stub._failed_platforms = {}
    stub._background_tasks = set()
    stub._platform_lock_takeover_on_start = True
    stub._busy_text_mode = False
    stub.session_store = object()
    stub.delivery_router = types.SimpleNamespace(adapters={})
    stub._primary_message_handler = lambda: (lambda *_a: None)
    stub._handle_adapter_fatal_error = lambda *_a: None
    stub._handle_active_session_busy_message = lambda *_a: None
    stub._handle_reaction_event = lambda *_a: None
    stub._recover_telegram_topic_thread_id = lambda *_a: None
    stub._make_adapter_auth_check = lambda *_a: (lambda *_a: True)
    stub._handle_voice_channel_input = lambda *_a: None
    stub._sync_voice_mode_state_to_adapter = lambda *_a: None
    stub._wire_teams_pipeline_runtime = lambda: None
    stub._update_platform_runtime_status = lambda *_a, **_k: None
    stub._adapter_credential_claim = lambda *_a: "credential"
    stub._adapter_listener_claim = lambda *_a: "listener"
    stub._schedule_resume_pending_sessions = lambda **_k: None

    async def connect(adapter, _platform):
        await asyncio.sleep(0)
        adapter.connected = True
        return True

    async def disconnect(*_a):
        return None

    stub._connect_adapter_with_timeout = connect
    stub._safe_adapter_disconnect = disconnect
    for name, fn in (
        ("_apex_prepare_background_adapter", gateway_bootstrap._prepare_background_adapter),
        ("_apex_register_background_adapter", gateway_bootstrap._register_background_adapter),
        ("_apex_queue_platform_retry", gateway_bootstrap._queue_platform_retry),
        (
            "_apex_create_and_connect_adapter_in_background",
            gateway_bootstrap._create_and_connect_adapter_in_background,
        ),
    ):
        setattr(stub, name, types.MethodType(fn, stub))
    return stub


@pytest.mark.asyncio
async def test_feishu_creation_is_deferred_but_other_platforms_stay_inline():
    stub = _stub_runner()
    feishu = _Platform("feishu")
    telegram = _Platform("telegram")
    created: list[str] = []

    def original(self, platform, _config):
        created.append(platform.value)
        return _Adapter(platform)

    wrapped = gateway_bootstrap._wrap_create_adapter(original)
    config = types.SimpleNamespace(enabled=True)

    assert wrapped(stub, feishu, config) is None
    assert created == [], "Feishu construction must not run on the startup stack"
    assert len(stub._background_tasks) == 1

    inline = wrapped(stub, telegram, config)
    assert isinstance(inline, _Adapter)
    assert created == ["telegram"]

    await asyncio.gather(*list(stub._background_tasks))
    assert created == ["telegram", "feishu"]
    assert feishu in stub.adapters
    assert stub.adapters[feishu].connected is True
    assert stub.adapters[feishu]._platform_lock_takeover_allowed is False


@pytest.mark.asyncio
async def test_failed_background_connect_keeps_v020_retry_claims():
    stub = _stub_runner()
    feishu = _Platform("feishu")
    adapter = _Adapter(feishu)

    async def fail_connect(*_a):
        return False

    stub._connect_adapter_with_timeout = fail_connect
    await stub._apex_create_and_connect_adapter_in_background(
        feishu,
        types.SimpleNamespace(enabled=True),
        lambda *_a: adapter,
        False,
    )

    retry = stub._failed_platforms[feishu]
    assert retry["credential_claim"] == "credential"
    assert retry["listener_claim"] == "listener"
    assert retry["attempts"] == 1


def test_plugin_register_applies_gateway_bootstrap_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_apex_overlay_plugin_under_test_gw")
    assert "gateway_bootstrap" in called


def test_plugin_discovery_precedes_first_adapter_creation():
    from pathlib import Path

    src = (Path(__file__).resolve().parents[2] / "gateway" / "run.py").read_text(encoding="utf-8")
    discover_idx = src.find("discover_plugins()")
    create_idx = src.find("adapter = self._create_adapter(", discover_idx)
    assert discover_idx != -1 and create_idx != -1 and discover_idx < create_idx


def test_apex_overlay_enabled_in_config():
    from pathlib import Path

    cfg = (Path(__file__).resolve().parents[2] / "cli-config.yaml.example").read_text(encoding="utf-8")
    assert "apex-overlay" in cfg
