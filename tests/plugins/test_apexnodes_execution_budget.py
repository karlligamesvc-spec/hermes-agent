"""hc-941: the outer tool executor never cuts an APEX platform tool before its own wait ends.

APEX Desktop 0.17.58 cut media_transcribe at the executor's shared 420 s deadline while the
plugin was still inside its own 2h10m ASR wait; the retry then succeeded. A tool whose
longest wait exceeds that default now registers it as ``execution_timeout``.

This guard runs every tool of the four network plugins on both legs (legacy master
endpoints, and the tools gateway) against fakes, and records each wait the handler arms:
``urllib.request.urlopen``, ``request_json``, the media download and the audio extraction.
The longest wait must fit inside the deadline the executor gives that tool: its registered
budget, or the shared default. The waits are observed at the fakes, not read from the
plugins' constants, so raising a wait without registering a matching budget turns this red.
Every registration is also bound against the real ``PluginContext.register_tool``
signature: a keyword the runtime does not accept would stop the plugin from loading.

It cannot catch a wait armed outside these fakes (a new HTTP client, the >threshold COS
direct-upload leg that tiny probe files never take), and it checks each wait on its own,
not the sum of a tool's sequential waits.
"""

from __future__ import annotations

import importlib.util
import inspect
import json
import sys
import types
from pathlib import Path

import pytest

from agent.tool_executor import _DEFAULT_CONCURRENT_TOOL_TIMEOUT_S
from hermes_cli.plugins import PluginContext
from tests.plugins.test_apexnodes_plugin_contract import (
    GATEWAY_BASE,
    GATEWAY_KEY,
    LEGACY_BASE,
    PROBES,
    GatewayHarness,
    LegacyHarness,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
NETWORK_PLUGINS = (
    "apexnodes-douyin-tools",
    "apexnodes-social-tools",
    "apexnodes-video-tools",
    "apexnodes-image-tools",
)
EXTRA_PROBES = {"generate_image": {"prompt": "一只猫在弹钢琴"}}

# Tools that register a budget, and the budget: their longest wait (seconds).
EXPECTED_BUDGETS = {
    "social_download": 600,
    "media_transcribe": 2 * 60 * 60 + 10 * 60,
    "image_ocr": 600,
    "generate_video": 660,
}

_REGISTER_TOOL = inspect.signature(PluginContext.register_tool)


class _BudgetCtx:
    def __init__(self):
        self.tools: dict[str, dict] = {}

    def register_tool(self, **kwargs):
        # Raises TypeError for a keyword the runtime's PluginContext does not accept.
        _REGISTER_TOOL.bind(None, **kwargs)
        assert kwargs["name"] not in self.tools, f"duplicate tool registration: {kwargs['name']}"
        self.tools[kwargs["name"]] = kwargs


def _load_plugin(name: str):
    module_name = f"hc941_budget.{name.replace('-', '_')}"
    plugin_dir = REPO_ROOT / "plugins" / name
    if "hc941_budget" not in sys.modules:
        namespace = types.ModuleType("hc941_budget")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hc941_budget"] = namespace
    spec = importlib.util.spec_from_file_location(
        module_name, plugin_dir / "__init__.py", submodule_search_locations=[str(plugin_dir)]
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _register_all() -> dict[str, dict]:
    tools: dict[str, dict] = {}
    for plugin_name in NETWORK_PLUGINS:
        ctx = _BudgetCtx()
        _load_plugin(plugin_name).register(ctx)
        tools.update(ctx.tools)
    return tools


TOOLS = _register_all()


def _default_of(func, parameter: str):
    return inspect.signature(func).parameters[parameter].default


class _WaitRecorder:
    """Install one leg's fakes; every armed wait lands in ``waits`` as (label, seconds)."""

    def __init__(self, monkeypatch, tmp_path, leg: str):
        self.waits: list[tuple[str, float]] = []
        if leg == "legacy":
            self._install_legacy(monkeypatch)
        else:
            self._install_gateway(monkeypatch, tmp_path)

    def _install_legacy(self, monkeypatch):
        monkeypatch.setenv("TOOLS_GATEWAY_DISABLED", "1")
        monkeypatch.delenv("TOOLS_GATEWAY_BASE", raising=False)
        monkeypatch.delenv("TOOLS_GATEWAY_KEY", raising=False)
        monkeypatch.setenv("HERMES_PLATFORM_API_BASE", LEGACY_BASE)
        monkeypatch.setenv("API_SERVER_KEY", "legacy-key")
        recorder = self

        class _Response:
            def __init__(self, body: dict):
                self._body = json.dumps(body, ensure_ascii=False).encode("utf-8")

            def read(self):
                return self._body

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def _fake_urlopen(request, timeout=None):
            path = request.full_url[len(LEGACY_BASE):]
            # urlopen without a timeout waits forever; record that as an unbounded wait.
            recorder.waits.append((f"urlopen {path}", float("inf") if timeout is None else timeout))
            return _Response(LegacyHarness._canned(path))

        monkeypatch.setattr("urllib.request.urlopen", _fake_urlopen)

    def _install_gateway(self, monkeypatch, tmp_path):
        import plugins.apexnodes_gateway as gateway

        monkeypatch.delenv("TOOLS_GATEWAY_DISABLED", raising=False)
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", GATEWAY_BASE)
        monkeypatch.setenv("TOOLS_GATEWAY_KEY", GATEWAY_KEY)
        recorder = self
        request_default = _default_of(gateway.request_json, "timeout")
        download_default = _default_of(gateway.download_media, "timeout")
        extract_default = _default_of(gateway.extract_audio_for_asr, "timeout")

        def _fake_request_json(
            method, path, payload=None, *, timeout=request_default, files=None, form_data=None, headers=None
        ):
            recorder.waits.append((f"request_json {path}", timeout))
            return GatewayHarness._canned(path)

        def _fake_download_media(url, *, headers=None, timeout=download_default, dest_dir=None, filename_hint=""):
            recorder.waits.append((f"download_media {url}", timeout))
            downloaded = tmp_path / "downloaded.mp4"
            downloaded.write_bytes(b"fake-media")
            return downloaded

        def _fake_extract_audio(media_path, *, timeout=extract_default):
            # Answers None, as without ffmpeg: the handler then uploads the original file.
            recorder.waits.append(("extract_audio_for_asr", timeout))

        monkeypatch.setattr(gateway, "request_json", _fake_request_json)
        monkeypatch.setattr(gateway, "download_media", _fake_download_media)
        monkeypatch.setattr(gateway, "extract_audio_for_asr", _fake_extract_audio)


def test_registrations_cover_every_network_tool():
    expected = set(PROBES) | set(EXTRA_PROBES)
    assert set(TOOLS) == expected, "a tool was added or dropped: give it a probe here"


@pytest.mark.parametrize("leg", ["legacy", "gateway"])
@pytest.mark.parametrize("tool_name", sorted(TOOLS))
def test_executor_deadline_covers_the_longest_wait(tool_name, leg, monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes_home"))
    recorder = _WaitRecorder(monkeypatch, tmp_path, leg)
    args = dict(PROBES.get(tool_name) or EXTRA_PROBES[tool_name])

    TOOLS[tool_name]["handler"](args)

    assert recorder.waits, f"{tool_name} ({leg}): the probe armed no wait; probe args stale?"
    label, longest = max(recorder.waits, key=lambda wait: wait[1])
    budget = TOOLS[tool_name].get("execution_timeout")
    deadline = max(_DEFAULT_CONCURRENT_TOOL_TIMEOUT_S, budget or 0)
    assert longest <= deadline, (
        f"{tool_name} ({leg}) waits up to {longest}s in {label}, but the executor cuts it at "
        f"{deadline}s; register execution_timeout={longest} for it"
    )


def test_registered_budgets_are_the_expected_table():
    registered = {
        name: entry["execution_timeout"]
        for name, entry in TOOLS.items()
        if entry.get("execution_timeout") is not None
    }
    assert registered == EXPECTED_BUDGETS
