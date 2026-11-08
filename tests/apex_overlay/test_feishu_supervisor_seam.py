"""Seam-test + behavior test for the apex_overlay hc-384/385 Feishu seam.

This pins the upstream symbols ``apex_overlay.feishu_supervisor`` binds
against, so an upstream rename/move turns a *silently reverted-to-SDK-
reconnect* adapter into a *loud CI failure* — the prerequisite for trusting
the monkey-patch (see ``apex_overlay/README.md``).

v0.18 retarget
==============
Upstream v0.18 deleted ``gateway/platforms/feishu.py`` (our old patch target)
and moved the adapter into a bundled plugin (``plugins/platforms/feishu/
adapter.py``) that is imported LAZILY through ``gateway.platform_registry``.
The seam therefore attaches at ``PlatformRegistry.create_adapter``: when a
``feishu`` adapter is created, the wrapper instruments the adapter's class
(wraps connect/disconnect + the processing hooks, binds the supervisor ladder
and the hc-385 heartbeat helpers).

These tests pin, in order:
1. the registry choke point (module/class/method + signature);
2. the upstream adapter internals the supervisor/ladder/heartbeat call;
3. apply() wraps the registry method and instruments a feishu adapter's class
   end-to-end (real ``PlatformRegistry`` + ``PlatformEntry``, fake adapter);
4. wrapper behavior: supervisor armed on connect (websocket mode), revert
   flag honored, heartbeat start/stop around a turn, disconnect cancels both;
5. the apex-overlay plugin wiring (register() applies this seam; config
   enables the plugin).

Run via ``scripts/run_tests_parallel.py`` (per-file fresh interpreter), not a
single in-process pytest — a process-wide monkey-patch behaves differently
under single-process isolation.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from types import SimpleNamespace

import pytest

from apex_overlay import feishu_supervisor


# ---------------------------------------------------------------------------
# 1. Registry choke point pins
# ---------------------------------------------------------------------------

def test_seam_registry_target_exists_with_compatible_signature():
    """apply() wraps gateway.platform_registry.PlatformRegistry.create_adapter."""
    import importlib

    mod = importlib.import_module(feishu_supervisor._TARGET_REGISTRY_MODULE)
    cls = getattr(mod, feishu_supervisor._TARGET_REGISTRY_CLS, None)
    assert cls is not None, (
        "PlatformRegistry is gone — apex_overlay feishu_supervisor has no "
        "choke point to patch. Update _TARGET_REGISTRY_CLS."
    )
    fn = getattr(cls, feishu_supervisor._TARGET_FACTORY_METHOD, None)
    assert fn is not None, (
        "PlatformRegistry.create_adapter is gone — the Feishu seam can no "
        "longer intercept adapter creation. Update _TARGET_FACTORY_METHOD."
    )
    params = list(inspect.signature(fn).parameters)
    assert params == ["self", "name", "config"], (
        f"create_adapter signature changed to {params!r}; the overlay wrapper "
        f"forwards (self, name, config)."
    )


def test_seam_registry_is_the_gateway_creation_path_for_feishu():
    """run.py resolves plugin platforms through platform_registry.create_adapter.

    Feishu is plugin-only in v0.18; if the gateway ever grows a second creation
    path that bypasses the registry, the seam would miss those adapters.
    """
    from pathlib import Path

    repo = Path(__file__).resolve().parents[2]
    src = (repo / "gateway" / "run_adapters.py").read_text(encoding="utf-8")
    assert "platform_registry.create_adapter(" in src, (
        "gateway/run.py no longer creates plugin adapters via "
        "platform_registry.create_adapter — the Feishu seam interception "
        "point moved."
    )


# ---------------------------------------------------------------------------
# 2. Upstream adapter internals the seam depends on
# ---------------------------------------------------------------------------

def _load_feishu_adapter_cls():
    from plugins.platforms.feishu.adapter import FeishuAdapter

    return FeishuAdapter


def test_seam_wrapped_lifecycle_methods_exist():
    """The four methods the class instrumentation wraps must exist upstream."""
    cls = _load_feishu_adapter_cls()
    for name in feishu_supervisor._WRAPPED_METHODS:
        fn = getattr(cls, name, None)
        assert fn is not None, (
            f"FeishuAdapter.{name} is gone — the hc-384/385 instrumentation "
            f"has nothing to wrap. Update the overlay + this test together."
        )
        assert inspect.iscoroutinefunction(fn), (
            f"FeishuAdapter.{name} is no longer async; the overlay wrapper "
            f"awaits it."
        )


def test_seam_ladder_dependencies_exist_with_compatible_signatures():
    """Pin the upstream adapter internals the reconnect ladder calls."""
    cls = _load_feishu_adapter_cls()

    # Relaunch primitive: rebuilds client + event handler + ws thread.
    fn = getattr(cls, "_connect_websocket", None)
    assert fn is not None and inspect.iscoroutinefunction(fn), (
        "FeishuAdapter._connect_websocket is gone/not-async — the ladder has "
        "no relaunch primitive."
    )
    assert [p for p in inspect.signature(fn).parameters] == ["self"]

    # Probe transport: adapter-owned executor for blocking SDK calls (v0.18).
    rb = getattr(cls, "_run_blocking", None)
    assert rb is not None and inspect.iscoroutinefunction(rb), (
        "FeishuAdapter._run_blocking is gone — the /bot/v3/info liveness probe "
        "routes through it."
    )

    # Escalation: retryable fatal error → gateway reconnect watcher recreates.
    sfe = getattr(cls, "_set_fatal_error", None)
    assert sfe is not None, "BasePlatformAdapter._set_fatal_error is gone."
    sig = inspect.signature(sfe)
    assert "retryable" in sig.parameters, (
        "_set_fatal_error lost its retryable kwarg — ladder exhaustion "
        "escalates with retryable=True."
    )
    nfe = getattr(cls, "_notify_fatal_error", None)
    assert nfe is not None and inspect.iscoroutinefunction(nfe), (
        "BasePlatformAdapter._notify_fatal_error is gone/not-async."
    )


def test_seam_heartbeat_dependencies_exist_with_compatible_signatures():
    """Pin send()/edit_message() shapes the hc-385 heartbeat calls."""
    cls = _load_feishu_adapter_cls()

    send_params = list(inspect.signature(cls.send).parameters)
    assert send_params[:3] == ["self", "chat_id", "content"], (
        f"FeishuAdapter.send signature changed to {send_params!r}; the "
        f"heartbeat calls send(chat_id, text, reply_to=...)."
    )
    assert "reply_to" in send_params

    edit_params = list(inspect.signature(cls.edit_message).parameters)
    assert edit_params[:4] == ["self", "chat_id", "message_id", "content"], (
        f"FeishuAdapter.edit_message signature changed to {edit_params!r}; the "
        f"heartbeat calls edit_message(chat_id, message_id, text)."
    )


def test_seam_ws_client_state_conventions():
    """Pin the instance-attribute conventions the death check reads.

    ``_websocket_appears_dead`` reads ``_ws_client`` / ``_ws_future`` and the
    lark client's ``_conn``; the teardown helper additionally drives
    ``_ws_thread_loop``. These are set in ``__init__`` /
    ``_connect_websocket`` — pin their assignments textually since instance
    attributes don't exist on the class.
    """
    from pathlib import Path

    import plugins.platforms.feishu.adapter as feishu_mod

    src = Path(feishu_mod.__file__).read_text(encoding="utf-8")
    for attr in (
        "_ws_client",
        "_ws_future",
        "_ws_thread_loop",
        "_loop",
        "_running",
        "_connection_mode",
        "_client",
    ):
        assert f"self.{attr}" in src, (
            f"FeishuAdapter no longer has self.{attr} — the supervisor/ladder "
            f"reads it. Re-map the overlay."
        )
    # The SDK-retry kill switch convention (upstream itself sets this attr).
    assert "_auto_reconnect" in src, (
        "the lark _auto_reconnect override convention disappeared from the "
        "adapter — verify how the SDK's retry is disabled now."
    )


# ---------------------------------------------------------------------------
# 3. apply() + end-to-end interception through a real PlatformRegistry
# ---------------------------------------------------------------------------

class _StubWsClient:
    def __init__(self):
        self._conn = object()
        self._auto_reconnect = True


def _make_fake_adapter_cls():
    """A fresh fake adapter class with the upstream surface the seam needs.

    Fresh per call: class instrumentation mutates the class, so sharing one
    class across tests would leak state.
    """

    class _FakeFeishuAdapter:
        def __init__(self, config=None):
            self.config = config
            self._connection_mode = "websocket"
            self._running = False
            self._loop = None
            self._ws_client = None
            self._ws_future = None
            self._ws_thread_loop = None
            self._client = object()
            self.fatal = None
            self.sent = []
            self.edited = []
            self.torn_down = []

        async def connect(self, *, is_reconnect: bool = False) -> bool:
            self._running = True
            self._loop = asyncio.get_running_loop()
            self._ws_client = _StubWsClient()
            return True

        async def disconnect(self) -> None:
            self._running = False
            # Like upstream: disconnect tears the socket down through its own helper,
            # which the instrumentation must leave in place (hc-1174).
            await self._teardown_ws_thread(self._ws_client, self._ws_thread_loop)

        async def _teardown_ws_thread(self, ws_client, ws_thread_loop) -> None:
            self.torn_down.append((ws_client, ws_thread_loop))

        async def on_processing_start(self, event) -> None:
            return None

        async def on_processing_complete(self, event, outcome) -> None:
            return None

        async def _connect_websocket(self) -> None:
            self._ws_client = _StubWsClient()

        async def _run_blocking(self, func, *args):
            return func(*args)

        def _set_fatal_error(self, code, message, *, retryable):
            self.fatal = (code, message, retryable)

        async def _notify_fatal_error(self):
            return None

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            self.sent.append((chat_id, content, reply_to))
            return SimpleNamespace(success=True, message_id=f"hb_{len(self.sent)}")

        async def edit_message(self, chat_id, message_id, content, *, finalize=False):
            self.edited.append((chat_id, message_id, content))
            return SimpleNamespace(success=True, message_id=message_id)

    return _FakeFeishuAdapter


def _fresh_registry_with_fake_feishu():
    from gateway.platform_registry import PlatformEntry, PlatformRegistry

    cls = _make_fake_adapter_cls()
    registry = PlatformRegistry()
    registry.register(
        PlatformEntry(
            name="feishu",
            label="Feishu (fake)",
            adapter_factory=lambda cfg: cls(cfg),
            check_fn=lambda: True,
        )
    )
    return registry, cls


def test_apply_wraps_create_adapter_and_is_idempotent():
    from gateway.platform_registry import PlatformRegistry

    feishu_supervisor._APPLIED = False
    assert feishu_supervisor.apply() is True

    patched = getattr(PlatformRegistry, feishu_supervisor._TARGET_FACTORY_METHOD)
    assert getattr(patched, feishu_supervisor._MARK, False), (
        "after apply(), PlatformRegistry.create_adapter must be the overlay "
        "wrapper (marked)."
    )

    # Idempotent: second apply is a no-op, no double-wrap.
    assert feishu_supervisor.apply() is True
    assert getattr(PlatformRegistry, feishu_supervisor._TARGET_FACTORY_METHOD) is patched


def test_created_feishu_adapter_class_gets_instrumented():
    feishu_supervisor._APPLIED = False
    assert feishu_supervisor.apply() is True

    registry, cls = _fresh_registry_with_fake_feishu()
    adapter = registry.create_adapter("feishu", SimpleNamespace(extra={}))
    assert adapter is not None
    assert feishu_supervisor.apex_overlay_active(adapter), (
        "create_adapter('feishu') must instrument the adapter class."
    )
    for name in feishu_supervisor._BOUND_HELPERS:
        assert hasattr(cls, name), f"helper {name!r} not bound onto the class"
    # hc-385 flag for the gateway bootstrap seam / reconnect watcher.
    assert getattr(cls, "CONNECT_IN_BACKGROUND", False) is True
    # Second create: already-instrumented class is not double-wrapped.
    connect_before = cls.connect
    adapter2 = registry.create_adapter("feishu", SimpleNamespace(extra={}))
    assert adapter2 is not None
    assert cls.connect is connect_before


def test_non_feishu_adapters_are_left_alone():
    from gateway.platform_registry import PlatformEntry, PlatformRegistry

    feishu_supervisor._APPLIED = False
    assert feishu_supervisor.apply() is True

    class _OtherAdapter:
        pass

    registry = PlatformRegistry()
    registry.register(
        PlatformEntry(
            name="telegram",
            label="TG (fake)",
            adapter_factory=lambda cfg: _OtherAdapter(),
            check_fn=lambda: True,
        )
    )
    adapter = registry.create_adapter("telegram", SimpleNamespace(extra={}))
    assert adapter is not None
    assert not feishu_supervisor.apex_overlay_active(adapter)
    assert not hasattr(_OtherAdapter, "_supervise_websocket")


# ---------------------------------------------------------------------------
# 4. Wrapper behavior
# ---------------------------------------------------------------------------

def _instrumented_adapter(config_extra=None):
    cls = _make_fake_adapter_cls()
    assert feishu_supervisor._instrument_feishu_adapter_class(cls) is True
    return cls(SimpleNamespace(extra=config_extra or {}))


@pytest.mark.asyncio
async def test_connect_arms_supervisor_and_disables_sdk_reconnect():
    adapter = _instrumented_adapter()
    assert await adapter.connect() is True
    try:
        assert adapter._ws_self_reconnect is True
        assert adapter._ws_client._auto_reconnect is False, (
            "the supervisor owns reconnection — the lark SDK's retry must be "
            "disabled on the live client."
        )
        task = adapter._ws_supervisor_task
        assert task is not None and not task.done(), (
            "connect() must start the websocket supervisor task."
        )
        assert adapter._intentional_disconnect is False
    finally:
        await adapter.disconnect()
    assert adapter._intentional_disconnect is True
    assert adapter._ws_supervisor_task is None


@pytest.mark.asyncio
async def test_revert_flag_keeps_upstream_behavior(monkeypatch):
    """FEISHU_WS_SELF_RECONNECT=false → no supervisor, SDK retry untouched."""
    monkeypatch.setenv("FEISHU_WS_SELF_RECONNECT", "false")
    adapter = _instrumented_adapter()
    assert await adapter.connect() is True
    try:
        assert adapter._ws_self_reconnect is False
        assert adapter._ws_client._auto_reconnect is True, (
            "with the revert flag the SDK keeps its own auto-reconnect."
        )
        assert adapter._ws_supervisor_task is None
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_webhook_mode_never_starts_supervisor():
    adapter = _instrumented_adapter()
    adapter._connection_mode = "webhook"
    assert await adapter.connect() is True
    try:
        assert adapter._ws_supervisor_task is None
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_ladder_reconnects_dead_socket(monkeypatch):
    """Dead socket → teardown + relaunch + SDK-retry re-disable + verify."""
    monkeypatch.setattr(feishu_supervisor, "_FEISHU_WS_RECONNECT_BASE_DELAY", 0)
    monkeypatch.setattr(feishu_supervisor, "_FEISHU_WS_RECONNECT_VERIFY_DELAY", 0)

    adapter = _instrumented_adapter()
    assert await adapter.connect() is True
    try:
        # Simulate a silent drop: lark clears _conn when the receive loop dies.
        adapter._ws_client._conn = None
        assert adapter._websocket_appears_dead() is True

        # Probe path: no lark symbols in the fake module → falls back to the
        # socket-object check, which passes after relaunch.
        await adapter._reconnect_websocket_with_backoff()
        assert adapter._ws_client._conn is not None, "socket must be relaunched"
        assert adapter._ws_client._auto_reconnect is False, (
            "the fresh client must get the SDK retry re-disabled."
        )
        assert adapter.fatal is None
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_ladder_exhaustion_escalates_retryable_fatal(monkeypatch):
    monkeypatch.setattr(feishu_supervisor, "_FEISHU_WS_RECONNECT_BASE_DELAY", 0)
    monkeypatch.setattr(feishu_supervisor, "_FEISHU_WS_RECONNECT_VERIFY_DELAY", 0)
    monkeypatch.setattr(feishu_supervisor, "_FEISHU_WS_RECONNECT_MAX_ATTEMPTS", 2)

    adapter = _instrumented_adapter()
    assert await adapter.connect() is True
    try:

        async def _broken_relaunch():
            raise RuntimeError("relaunch fails")

        adapter._connect_websocket = _broken_relaunch
        adapter._ws_client._conn = None
        await adapter._reconnect_websocket_with_backoff()
        assert adapter.fatal is not None, "exhausted ladder must escalate"
        code, _message, retryable = adapter.fatal
        assert code == "feishu_ws_reconnect_exhausted"
        assert retryable is True, (
            "escalation must be retryable so the gateway reconnect watcher "
            "recreates the adapter."
        )
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_heartbeat_starts_and_stops_around_processing(monkeypatch):
    monkeypatch.setenv("FEISHU_HEARTBEAT", "true")
    adapter = _instrumented_adapter()
    assert await adapter.connect() is True
    try:
        assert adapter._heartbeat_enabled is True
        event = SimpleNamespace(
            message_id="om_1", source=SimpleNamespace(chat_id="oc_1")
        )
        await adapter.on_processing_start(event)
        task = adapter._heartbeat_tasks.get("om_1")
        assert task is not None and not task.done(), (
            "on_processing_start must start a heartbeat task (opt-in enabled)."
        )
        await adapter.on_processing_complete(event, None)
        await asyncio.sleep(0)
        assert task.cancelled() or task.done(), (
            "on_processing_complete must stop the heartbeat."
        )
    finally:
        await adapter.disconnect()
    assert not adapter._heartbeat_tasks, "disconnect clears heartbeat tasks"


@pytest.mark.asyncio
async def test_heartbeat_default_off():
    adapter = _instrumented_adapter()
    assert await adapter.connect() is True
    try:
        assert adapter._heartbeat_enabled is False
        event = SimpleNamespace(
            message_id="om_1", source=SimpleNamespace(chat_id="oc_1")
        )
        await adapter.on_processing_start(event)
        assert not adapter._heartbeat_tasks, "hc-385 heartbeat is opt-in"
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_config_extra_overrides_env(monkeypatch):
    """config.yaml platforms.feishu.extra wins over env (fork precedence)."""
    monkeypatch.setenv("FEISHU_HEARTBEAT", "false")
    adapter = _instrumented_adapter(
        config_extra={"heartbeat_enabled": True, "heartbeat_interval_seconds": 15}
    )
    assert await adapter.connect() is True
    try:
        assert adapter._heartbeat_enabled is True
        assert adapter._heartbeat_interval == 15
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_heartbeat_enabled_warns_about_generic_notifier_overlap(caplog):
    """hc-493: enabling hc-385's heartbeat must warn about the OTHER,
    independently-gated "still working" notifier (gateway/run.py's
    _notify_long_running, driven by long_running_notifications — on by
    default for Feishu) so nobody flips this on expecting a single heartbeat
    and ships duplicate "still running" messages instead.
    """
    adapter = _instrumented_adapter(config_extra={"heartbeat_enabled": True})
    with caplog.at_level(logging.WARNING, logger="apex_overlay.feishu_supervisor"):
        assert await adapter.connect() is True
    try:
        assert any(
            "long_running_notifications" in r.message for r in caplog.records
        ), "must warn that the generic notifier can double up with hc-385's heartbeat"
    finally:
        await adapter.disconnect()


@pytest.mark.asyncio
async def test_heartbeat_disabled_does_not_warn(caplog):
    """Default (heartbeat off) must stay silent — no spurious overlap warning."""
    adapter = _instrumented_adapter()
    with caplog.at_level(logging.WARNING, logger="apex_overlay.feishu_supervisor"):
        assert await adapter.connect() is True
    try:
        assert not any(
            "long_running_notifications" in r.message for r in caplog.records
        )
    finally:
        await adapter.disconnect()


# ---------------------------------------------------------------------------
# 5. Plugin wiring
# ---------------------------------------------------------------------------

def test_plugin_register_applies_feishu_supervisor_seam():
    """The bundled apex-overlay plugin's register() applies this seam too."""
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams(
        "_apex_overlay_plugin_under_test_feishu"
    )
    assert "feishu_supervisor" in called, (
        "plugin.register() must call feishu_supervisor.apply()"
    )


def test_apex_overlay_enabled_in_config():
    """cli-config.yaml.example enables the apex-overlay plugin (config tier)."""
    from pathlib import Path

    repo = Path(__file__).resolve().parents[2]
    cfg = (repo / "cli-config.yaml.example").read_text(encoding="utf-8")
    assert "apex-overlay" in cfg, (
        "cli-config.yaml.example must list apex-overlay under plugins.enabled "
        "or the Feishu supervisor seam never loads in production."
    )


# ---------------------------------------------------------------------------
# 6. hc-1174: what the instrumentation adds never replaces upstream
# ---------------------------------------------------------------------------
#
# Binding a helper under a name upstream already uses replaces upstream's method
# under upstream's own callers. That happened: upstream's disconnect calls
# ``_teardown_ws_thread(ws_client, ws_thread_loop)``, ours took only ``self``, and
# every gateway shutdown raised TypeError before the CLOSE frame went out.

# Upstream state the ladder deliberately resets when it rebuilds the socket (pinned
# in test_seam_ws_client_state_conventions). Everything else it writes is its own.
_SHARED_UPSTREAM_STATE = frozenset({"_ws_client", "_ws_future", "_ws_thread_loop"})


def _upstream_adapter_names() -> tuple[set[str], set[str]]:
    """(class-level names, instance attributes) of upstream's adapter and its gateway bases.

    Read from source, not from the live class: once the seam has instrumented
    FeishuAdapter in this process, the live class carries our names too.
    """
    import ast
    from pathlib import Path

    cls = _load_feishu_adapter_cls()
    ours = [base for base in cls.__mro__ if base.__module__.split(".")[0] in {"gateway", "plugins"}]
    assert ours and ours[0] is cls
    class_names: set[str] = set()
    instance_attrs: set[str] = set()
    for base in ours:
        tree = ast.parse(Path(inspect.getsourcefile(base)).read_text(encoding="utf-8"))
        (node,) = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == base.__name__]
        for item in node.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                class_names.add(item.name)
            elif isinstance(item, ast.Assign):
                class_names.update(t.id for t in item.targets if isinstance(t, ast.Name))
            elif isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                class_names.add(item.target.id)
        for sub in ast.walk(node):
            if (
                isinstance(sub, ast.Attribute)
                and isinstance(sub.value, ast.Name)
                and sub.value.id == "self"
                and isinstance(sub.ctx, ast.Store)
            ):
                instance_attrs.add(sub.attr)
    return class_names, instance_attrs


def _class_additions() -> set[str]:
    """Every name the instrumentation sets on an adapter class, other than the wrapped methods.

    Found by instrumenting a fake that mirrors upstream (it has ``_teardown_ws_thread``),
    counting replaced names as well as new ones: a replacement is exactly the clash to catch.
    """
    cls = _make_fake_adapter_cls()
    before = dict(vars(cls))
    assert feishu_supervisor._instrument_feishu_adapter_class(cls) is True
    written = {name for name, value in vars(cls).items() if name not in before or before[name] is not value}
    return written - set(feishu_supervisor._WRAPPED_METHODS)


def test_bound_helpers_list_every_name_the_instrumentation_adds():
    """_BOUND_HELPERS documents what the instrumentation binds, so it must be complete."""
    flags = {"CONNECT_IN_BACKGROUND", feishu_supervisor._ACTIVE_FLAG, feishu_supervisor._MARK}
    assert _class_additions() == set(feishu_supervisor._BOUND_HELPERS) | flags


def test_class_additions_are_not_upstream_names():
    upstream, _ = _upstream_adapter_names()
    assert set(feishu_supervisor._WRAPPED_METHODS) <= upstream, "the source reader lost upstream's methods"
    clash = sorted(_class_additions() & upstream)
    assert not clash, (
        f"upstream's Feishu adapter now defines {clash}; binding ours there replaces "
        f"upstream's under its own callers. Rename ours (the _apex_ prefix)."
    )


def test_instance_state_the_overlay_writes_is_its_own():
    import ast
    from pathlib import Path

    tree = ast.parse(Path(feishu_supervisor.__file__).read_text(encoding="utf-8"))
    written = {
        node.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id in {"self", "adapter"}
        and isinstance(node.ctx, ast.Store)
    }
    _, upstream = _upstream_adapter_names()
    assert _SHARED_UPSTREAM_STATE <= upstream, "the ladder resets state upstream no longer has"
    clash = sorted((written - _SHARED_UPSTREAM_STATE) & upstream)
    assert not clash, (
        f"upstream's Feishu adapter now keeps its own {clash}; the overlay writes "
        f"the same attributes. Rename ours."
    )


def _upstream_method(name):
    fn = getattr(_load_feishu_adapter_cls(), name)
    while getattr(fn, feishu_supervisor._MARK, False):
        fn = fn.__wrapped__
    return fn


def _call_shapes(sig: inspect.Signature):
    """Argument shapes a caller may use: optionals left out or passed, by position or keyword."""
    params = [
        p for p in sig.parameters.values()
        if p.name != "self" and p.kind not in (p.VAR_POSITIONAL, p.VAR_KEYWORD)
    ]
    for with_optional in (False, True):
        for by_keyword in (False, True):
            args, kwargs = [], {}
            for p in params:
                if p.default is not p.empty and not with_optional:
                    continue
                if p.kind is p.KEYWORD_ONLY or (by_keyword and p.kind is p.POSITIONAL_OR_KEYWORD):
                    kwargs[p.name] = object()
                else:
                    args.append(object())
            yield tuple(args), kwargs


@pytest.mark.parametrize("name", feishu_supervisor._WRAPPED_METHODS)
def test_wrapper_accepts_every_call_upstreams_method_accepts(name):
    upstream_fn = _upstream_method(name)
    wrapper = getattr(feishu_supervisor, f"_wrap_{name}")(upstream_fn)
    upstream_sig = inspect.signature(upstream_fn)
    wrapper_sig = inspect.signature(wrapper, follow_wrapped=False)
    for args, kwargs in _call_shapes(upstream_sig):
        upstream_sig.bind(object(), *args, **kwargs)
        try:
            wrapper_sig.bind(object(), *args, **kwargs)
        except TypeError as exc:
            pytest.fail(
                f"upstream FeishuAdapter.{name}{upstream_sig} is called with "
                f"{len(args)} positional and {sorted(kwargs)} keyword arguments; the "
                f"overlay's wrapper{wrapper_sig} refuses that ({exc}). Update the wrapper."
            )


@pytest.mark.asyncio
async def test_fake_disconnect_still_reaches_upstreams_teardown():
    adapter = _instrumented_adapter()
    assert await adapter.connect() is True
    client = adapter._ws_client
    await adapter.disconnect()
    assert adapter.torn_down == [(client, None)]


@pytest.mark.asyncio
async def test_instrumented_upstream_disconnect_sends_the_close_frame(tmp_path, monkeypatch):
    """The real upstream adapter, instrumented: disconnect closes the socket and stops its thread."""
    import contextlib
    import threading

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    from gateway.config import PlatformConfig

    cls = type("InstrumentedFeishuAdapter", (_load_feishu_adapter_cls(),), {})
    assert feishu_supervisor._instrument_feishu_adapter_class(cls) is True
    adapter = cls(PlatformConfig())

    closed = []

    class _LarkClient:
        _auto_reconnect = True

        async def _disconnect(self):
            closed.append(threading.current_thread().name)

    # The SDK runs the socket on its own thread and event loop; the adapter waits on a future for it.
    main_loop = asyncio.get_running_loop()
    thread_exited = main_loop.create_future()
    ws_loop = asyncio.new_event_loop()

    def _ws_thread():
        asyncio.set_event_loop(ws_loop)
        try:
            ws_loop.run_forever()
        finally:
            ws_loop.close()
            with contextlib.suppress(RuntimeError):
                main_loop.call_soon_threadsafe(lambda: thread_exited.done() or thread_exited.set_result(None))

    thread = threading.Thread(target=_ws_thread, name="lark-ws", daemon=True)
    thread.start()
    adapter._ws_client = _LarkClient()
    adapter._ws_thread_loop = ws_loop
    adapter._ws_future = thread_exited
    adapter._running = True
    adapter._connection_mode = "websocket"

    try:
        await adapter.disconnect()
    finally:
        # A broken disconnect must fail this test, not leave a thread that hangs the run.
        with contextlib.suppress(RuntimeError):
            ws_loop.call_soon_threadsafe(ws_loop.stop)
        thread.join(timeout=5)

    assert closed == ["lark-ws"], "the CLOSE frame must go out once, on the socket's own thread"
    assert ws_loop.is_closed(), "the websocket thread is still running"
    assert adapter._ws_client is None and adapter._ws_future is None and adapter._running is False
