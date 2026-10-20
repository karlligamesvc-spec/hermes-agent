"""hc-989: apex-overlay's plugin register() must never wait on a gateway import.

Production (cloud image v2026.8.31, 2026-10-20): ``hermes gateway run`` hung before binding :8642. The
main thread was inside ``import gateway.run``, whose module body bridges ``auxiliary:`` config through
plugin discovery and so waited for ``PluginManager._discovery_lock``; the ``plugin-discovery`` thread
held that lock and, in ``gateway_bootstrap.apply()``, waited for ``gateway.run``'s import lock.

Three layers of tests:

1. Every seam that patches a ``gateway.*`` module, against fake targets: its ``apply()`` runs on a
   thread that holds a lock while another thread is inside the target's module body waiting for that
   lock. ``apply()`` has to return and the patch has to land when the import finishes.
2. The real plugin ``register()`` in a fresh interpreter imports no ``gateway.*`` module at all, and the
   real ``import gateway.run`` returns with every gateway seam installed; the runner's real
   ``_create_adapter`` then sends Feishu through the hc-384/385 background path.
3. The real interleaving end to end: real background discovery, real ``gateway.run`` import with an
   ``auxiliary:`` config, apex-overlay held back until the main thread is waiting on discovery inside
   that import, on this revision's plugin loader (no per-plugin load deadline, as in production).

v2026.8.31 hotfix backport: this revision has no ``cn_im_banners`` seam (hc-976 came later), no
per-plugin load deadline and no ``_start_prefilter_platforms`` (the platform loop is inline in
``GatewayRunner.start()``, which calls ``_create_adapter`` per platform), so the fork-main version's
banner case, 10 s deadline case and start-up-loop call are adapted here.
"""

from __future__ import annotations

import importlib
import itertools
import os
import subprocess
import sys
import textwrap
import threading
from pathlib import Path

import pytest

from apex_overlay import (
    cn_im_messages,
    feishu_supervisor,
    first_turn_ack,
    gateway_bootstrap,
    im_passthrough,
    post_import,
)

_REPO = Path(__file__).resolve().parents[2]
_JOIN_SECONDS = 10
_counter = itertools.count()

# Fake gateway modules: just the symbols each seam wraps. Every body passes through the gate first, so a
# test can hold any one of them mid-import on purpose.
_FAKE_MODULES = {
    "run": """
        from PKG import _gate
        _gate.enter("run")

        def _prepare_gateway_status_message(*args, **kwargs):
            return None

        class GatewayRunner:
            def _create_adapter(self, platform, config):
                return None

            async def _handle_message_with_agent(self, event, source, _quick_key, run_generation):
                return None

            async def _deliver_platform_notice(self, *args, **kwargs):
                return None

            async def _handle_message(self, event, *args, **kwargs):
                return None
    """,
    "display_config": """
        from PKG import _gate
        _gate.enter("display_config")

        def resolve_display_setting(user_config, platform_key, setting, fallback=None):
            return fallback
    """,
    "base": """
        from PKG import _gate
        _gate.enter("base")

        class BasePlatformAdapter:
            def __init__(self, *args, **kwargs):
                pass

            async def _send_with_retry(self, chat_id, content, *args, **kwargs):
                return None
    """,
    "platform_registry": """
        from PKG import _gate
        _gate.enter("platform_registry")

        class PlatformRegistry:
            def create_adapter(self, name, config):
                return None
    """,
}

_GATE = """
import threading
held = None          # name of the fake module whose body waits for `lock`
lock = threading.Lock()
entered = threading.Event()

def enter(name):
    if name == held:
        entered.set()
        with lock:
            pass
"""

# seam -> {target constant: fake module}, and the symbol + mark each patch leaves behind.
_SEAMS = {
    "gateway_bootstrap": (
        gateway_bootstrap,
        {"_TARGET_RUN_MODULE": "run"},
        [("run", "GatewayRunner._create_adapter", gateway_bootstrap._MARK)],
        ["_APPLIED"],
    ),
    "first_turn_ack": (
        first_turn_ack,
        {"_TARGET_DISPLAY_MODULE": "display_config", "_TARGET_RUN_MODULE": "run"},
        [("display_config", "resolve_display_setting", first_turn_ack._MARK_RESOLVE),
         ("run", "GatewayRunner._handle_message_with_agent", first_turn_ack._MARK_TURN)],
        ["_APPLIED", "_RESOLVE_APPLIED", "_TURN_APPLIED"],
    ),
    "cn_im_messages": (
        cn_im_messages,
        {"_TARGET_RUN_MODULE": "run", "_TARGET_BASE_MODULE": "base"},
        [("run", "_prepare_gateway_status_message", cn_im_messages._MARK),
         ("run", "GatewayRunner._deliver_platform_notice", cn_im_messages._MARK),
         ("run", "GatewayRunner._handle_message", cn_im_messages._MARK),
         ("base", "BasePlatformAdapter._send_with_retry", cn_im_messages._MARK)],
        ["_APPLIED", "_RUN_APPLIED", "_BASE_APPLIED"],
    ),
    "im_passthrough": (
        im_passthrough,
        {"_TARGET_RUN_MODULE": "run"},
        [("run", "GatewayRunner._handle_message", im_passthrough._MARK)],
        ["_APPLIED"],
    ),
    "feishu_supervisor": (
        feishu_supervisor,
        {"_TARGET_REGISTRY_MODULE": "platform_registry"},
        [("platform_registry", "PlatformRegistry.create_adapter", feishu_supervisor._MARK)],
        ["_APPLIED"],
    ),
}

_CASES = [
    pytest.param(seam, held, id=f"{seam}-{held}")
    for seam, (_mod, targets, _marks, _flags) in _SEAMS.items()
    for held in targets.values()
]


@pytest.fixture
def fake_gateway(tmp_path, monkeypatch):
    """A uniquely named fake gateway package; post_import state is restored afterwards."""
    name = f"_hc989_fake_gateway_{next(_counter)}"
    root = tmp_path / name
    root.mkdir()
    (root / "__init__.py").write_text("", encoding="utf-8")
    (root / "_gate.py").write_text(_GATE, encoding="utf-8")
    for module, body in _FAKE_MODULES.items():
        (root / f"{module}.py").write_text(textwrap.dedent(body).replace("PKG", name), encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    pending = {k: list(v) for k, v in post_import._pending.items()}
    watched = dict(post_import._watched_parents)
    finder, meta_path = post_import._finder, list(sys.meta_path)
    yield name
    for parent in list(post_import._watched_parents):
        if parent not in watched:
            post_import._unwatch_parent(parent)
    post_import._pending.clear()
    post_import._pending.update(pending)
    post_import._finder = finder
    sys.meta_path[:] = meta_path
    for mod in [m for m in sys.modules if m == name or m.startswith(name + ".")]:
        del sys.modules[mod]


def _resolve(module, dotted):
    obj = module
    for part in dotted.split("."):
        obj = getattr(obj, part)
    return obj


def _wrapped_by(obj, mark) -> bool:
    while obj is not None:
        if getattr(obj, mark, False):
            return True
        obj = getattr(obj, "__wrapped__", None)
    return False


@pytest.mark.parametrize(("seam_name", "held"), _CASES)
def test_seam_apply_returns_while_its_target_import_waits_for_discovery(
    seam_name, held, fake_gateway, monkeypatch
):
    seam, targets, marks, flags = _SEAMS[seam_name]
    for constant, fake in targets.items():
        monkeypatch.setattr(seam, constant, f"{fake_gateway}.{fake}")
    for flag in flags:
        monkeypatch.setattr(seam, flag, False)
    gate = importlib.import_module(f"{fake_gateway}._gate")
    gate.held = held

    result = {}
    discovery_holds_lock = threading.Event()

    def discovery():
        # plugin-discovery: holds PluginManager._discovery_lock across every register().
        with gate.lock:
            discovery_holds_lock.set()
            assert gate.entered.wait(_JOIN_SECONDS), "the importer never reached the module body"
            result["apply"] = seam.apply()

    def importer():
        # The gateway's main thread: inside the target's body, waiting for discovery.
        discovery_holds_lock.wait(_JOIN_SECONDS)
        importlib.import_module(f"{fake_gateway}.{held}")

    threads = [threading.Thread(target=discovery, name="plugin-discovery", daemon=True),
               threading.Thread(target=importer, name="MainThread-stand-in", daemon=True)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(_JOIN_SECONDS)

    assert not threads[0].is_alive(), (
        f"{seam_name}.apply() blocked on {held}'s import lock while that import waited for "
        "plugin discovery: the hc-989 deadlock"
    )
    assert not threads[1].is_alive()
    assert result == {"apply": True}

    for fake in set(targets.values()):
        importlib.import_module(f"{fake_gateway}.{fake}")
    for fake, dotted, mark in marks:
        target = _resolve(sys.modules[f"{fake_gateway}.{fake}"], dotted)
        assert _wrapped_by(target, mark), f"{seam_name} did not patch {fake}.{dotted}"


def _run_child(script: str, tmp_path: Path, config: str, timeout: int = 150) -> subprocess.CompletedProcess:
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    (home / "config.yaml").write_text(config, encoding="utf-8")
    env = {**os.environ, "HERMES_HOME": str(home), "PYTHONFAULTHANDLER": "1"}
    return subprocess.run([sys.executable, "-c", textwrap.dedent(script)], env=env, cwd=_REPO,
                          capture_output=True, text=True, timeout=timeout, check=False)


def _aux_config() -> str:
    """The part of the cloud template that matters: a non-empty ``auxiliary:`` section (gateway.run
    bridges it at import, through plugin discovery) and apex-overlay enabled."""
    return (
        "model:\n"
        "  default: hc989-test\n"
        "  provider: custom\n"
        "  base_url: http://127.0.0.1:9/v1\n"
        "  api_key: dummy\n"
        "auxiliary:\n"
        "  vision:\n"
        "    provider: openai\n"
        "    model: platform-vision\n"
        "    base_url: http://127.0.0.1:9/v1\n"
        "    api_key: dummy\n"
        "plugins:\n"
        "  enabled:\n"
        "    - apex-overlay\n"
    )

_MARK_CHECK = """
    def wrapped_by(obj, mark):
        while obj is not None:
            if getattr(obj, mark, False):
                return True
            obj = getattr(obj, "__wrapped__", None)
        return False

    def seam_marks():
        import gateway.display_config as display_config
        import gateway.platform_registry as platform_registry
        import gateway.platforms.base as base
        import gateway.run as run
        from apex_overlay import (cn_im_messages, feishu_supervisor, first_turn_ack, gateway_bootstrap,
                                  im_passthrough)
        runner = run.GatewayRunner
        return {
            "gateway_bootstrap": wrapped_by(runner._create_adapter, gateway_bootstrap._MARK),
            "first_turn_ack.turn": wrapped_by(runner._handle_message_with_agent, first_turn_ack._MARK_TURN),
            "first_turn_ack.resolve": wrapped_by(display_config.resolve_display_setting,
                                                 first_turn_ack._MARK_RESOLVE),
            "cn_im_messages.prepare": wrapped_by(run._prepare_gateway_status_message, cn_im_messages._MARK),
            "cn_im_messages.deliver": wrapped_by(runner._deliver_platform_notice, cn_im_messages._MARK),
            "cn_im_messages.handle": wrapped_by(runner._handle_message, cn_im_messages._MARK),
            "cn_im_messages.send": wrapped_by(base.BasePlatformAdapter._send_with_retry, cn_im_messages._MARK),
            "im_passthrough": wrapped_by(runner._handle_message, im_passthrough._MARK),
            "feishu_supervisor": wrapped_by(platform_registry.PlatformRegistry.create_adapter,
                                            feishu_supervisor._MARK),
        }
"""


def test_register_imports_no_gateway_module_and_seams_land_before_the_startup_loop(tmp_path):
    """Fresh interpreter, nothing gateway-side loaded: register() arms the gateway seams without
    importing anything under ``gateway``; ``import gateway.run`` returns with all of them installed
    (no GatewayRunner can exist before that), and the first ``_create_adapter`` for Feishu, called the
    way ``GatewayRunner.start()``'s platform loop calls it, takes the hc-384/385 background path."""
    script = _MARK_CHECK + """
    import asyncio, importlib.util, sys, types
    spec = importlib.util.spec_from_file_location("_hc989_apex_overlay_plugin", "plugins/apex-overlay/__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    plugin.register(types.SimpleNamespace())

    loaded = sorted(m for m in sys.modules if m == "gateway" or m.startswith("gateway."))
    assert loaded == [], f"register() imported {loaded}"
    # The other modules whose import runs plugin discovery (the hc-989 audit found these three).
    triggers = sorted({"model_tools", "run_agent", "cli"} & set(sys.modules))
    assert triggers == [], f"register() imported {triggers}"
    from apex_overlay import post_import
    assert set(post_import.pending_modules()) == {
        "gateway.run", "gateway.display_config", "gateway.platforms.base", "gateway.platform_registry",
    }, post_import.pending_modules()

    from gateway.run import GatewayRunner          # what run_gateway() does
    missing = [name for name, ok in seam_marks().items() if not ok]
    assert missing == [], f"not installed when import gateway.run returned: {missing}"
    assert post_import.pending_modules() == ()

    # GatewayRunner.start()'s platform loop calls self._create_adapter(platform, platform_config) on the
    # event loop. On a bare runner, Feishu must be scheduled in the background (no adapter returned)
    # instead of being created on the start-up stack.
    from gateway.config import Platform, PlatformConfig
    runner = GatewayRunner.__new__(GatewayRunner)
    background = []
    runner._background_tasks = set()
    runner._update_platform_runtime_status = lambda *a, **k: None

    async def in_background(platform, config, create, takeover):
        background.append(platform.value)

    runner._apex_create_and_connect_adapter_in_background = in_background

    async def start_up():
        adapter = runner._create_adapter(Platform.FEISHU, PlatformConfig(enabled=True))
        await asyncio.gather(*runner._background_tasks)
        return adapter

    adapter = asyncio.run(start_up())
    assert adapter is None, adapter
    assert background == ["feishu"], background
    print("HC989-OK")
    """
    result = _run_child(script, tmp_path, _aux_config())
    assert result.returncode == 0 and "HC989-OK" in result.stdout, result.stdout + result.stderr


_INTERLEAVING = _MARK_CHECK + """
    import faulthandler, sys, threading, time
    # A regression deadlocks: dump every thread and exit non-zero instead of hanging the suite.
    faulthandler.dump_traceback_later(60, exit=True)

    from hermes_cli import plugins

    main_waits_inside_gateway_run = threading.Event()
    original_discover = plugins.PluginManager.discover_and_load
    original_load = plugins.PluginManager._load_plugin

    def discover_and_load(self, *args, **kwargs):
        module = sys.modules.get("gateway.run")
        if (threading.current_thread() is threading.main_thread() and module is not None
                and getattr(module.__spec__, "_initializing", False)):
            main_waits_inside_gateway_run.set()
        return original_discover(self, *args, **kwargs)

    def load_plugin(self, manifest):
        if manifest.name == "apex-overlay":
            # Production order on 2026-10-20: the main thread is already inside `import gateway.run`,
            # waiting for this sweep, when apex-overlay's register() runs.
            assert main_waits_inside_gateway_run.wait(45), "main thread never waited inside gateway.run"
        return original_load(self, manifest)

    plugins.PluginManager.discover_and_load = discover_and_load
    plugins.PluginManager._load_plugin = load_plugin
    plugins.start_background_plugin_discovery()

    started = time.monotonic()
    import gateway.run                       # module body bridges auxiliary: -> waits on discovery
    elapsed = time.monotonic() - started

    assert main_waits_inside_gateway_run.is_set(), "the interleaving was not produced"
    missing = [name for name, ok in seam_marks().items() if not ok]
    assert missing == [], f"not installed when import gateway.run returned: {missing}"
    loaded = {key: p.error for key, p in plugins.get_plugin_manager()._plugins.items() if "apex-overlay" in key}
    assert loaded and all(error is None for error in loaded.values()), loaded
    print(f"HC989-OK {elapsed:.1f}s")
"""


def test_real_gateway_import_and_overlay_discovery_interleaving_completes(tmp_path):
    """This revision's loader has no per-plugin deadline (the production image v2026.8.31): before
    hc-989 this hung until faulthandler fired."""
    result = _run_child(_INTERLEAVING, tmp_path, _aux_config())
    assert result.returncode == 0 and "HC989-OK" in result.stdout, result.stdout + result.stderr
