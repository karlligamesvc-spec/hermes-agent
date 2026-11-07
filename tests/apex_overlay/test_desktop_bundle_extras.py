"""hc-1170: every extra an APEX Desktop feature installs on first use ships in the runtime bundle.

A Desktop engine runs from the bundle's own venv. ``pm.ensure_import`` installs a missing extra into
a new pm generation, which that engine never loads (``pm/environments_adopt.restart_needed``), so on
Desktop a first-use install never makes a feature work. 2026-11-07: a freshly bound Feishu bot never
connected; lark_oapi was installed under ~/.apexnodes/installs/… and the gateway still logged
"requirements not met" (the 0.17.72 bundle had no lark_oapi).

The bundle's extras come from ``scripts/runtime-bundle-extras.mjs``, the lazily installed extras from
``pm.extras.ANCHORS``:

  1. Every lazily installed extra the bundle leaves out is classified: deferred (an APEX feature that
     still needs the user's call), fallback only, or not used by APEX. A new upstream extra turns this
     red until someone classifies it.
  2. The extras APEX features need are in the bundle and exist in pyproject.
  3. The premises: Feishu, the anthropic SDK (bring-your-own-key MiniMax) and document reading really
     do install these extras on first use, and MiniMax really talks the Anthropic protocol.
"""
from __future__ import annotations

import re
import tomllib
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

#: Extras the bundle installs for an APEX feature, beyond ``[all]``.
SHIPPED_FOR_APEX = {
    "feishu": "the IM 入口's Feishu bot",
    "anthropic": "bring-your-own-key MiniMax (Anthropic-compatible endpoints)",
    "doc-extract": "read_file on a PDF / Office document the user sends",
}

#: The anchor is a core dependency; the extra itself installs nothing.
CORE = {"vision": "Pillow"}

#: APEX features that still break on Desktop: shipping them needs the user's call.
DEFERRED = {
    "silk": "WeChat voice notes (pilk): uv.lock has no macOS / Python 3.14 wheel, the bundle would build a C extension",
    "stt-whisper": "local transcription (faster-whisper), upstream's default STT provider: large",
    "voice": "same faster-whisper as stt-whisper",
}

#: Reached only after APEX's own path failed.
FALLBACK_ONLY = {
    "ddgs": "web search after SearXNG fails; the keyless MCP ring answers last",
    "edge-tts": "upstream's default TTS; the overlay makes doubao APEX's default",
}

#: Not part of APEX on Desktop (other IM platforms, providers outside APEX's list, sandboxes,
#: local TTS / wake words, telemetry).
NOT_APEX = {
    "audio-io", "azure-identity", "bedrock", "computer-use", "daytona", "dingtalk", "discord", "exa",
    "fal", "firecrawl", "google-chat", "google-meet", "kittentts", "matrix", "messaging", "mistral",
    "modal", "neutts", "otlp", "parallel-web", "piper", "slack", "teams", "telegram", "trace-upload",
    "tts-premium", "vercel", "vertex", "wake", "wake-openwakeword", "wake-porcupine", "wake-sherpa",
    "wecom",
}


def bundle_extras() -> list[str]:
    text = (REPO / "scripts" / "runtime-bundle-extras.mjs").read_text(encoding="utf-8")
    block = re.search(r"DESKTOP_BUNDLE_EXTRAS = Object\.freeze\(\[(.*?)\]\)", text, re.DOTALL)
    assert block, "DESKTOP_BUNDLE_EXTRAS not found"
    return re.findall(r"'([a-z0-9-]+)'", re.sub(r"//[^\n]*", "", block.group(1)))


def _pyproject() -> dict:
    return tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))


def installed_extras(extras: list[str]) -> set[str]:
    """``extras`` plus every extra they pull in (``hermes-agent[x]`` references)."""
    project = _pyproject()["project"]
    defined = project["optional-dependencies"]
    seen: set[str] = set()
    todo = list(extras)
    while todo:
        extra = todo.pop()
        if extra in seen:
            continue
        seen.add(extra)
        for requirement in defined.get(extra, []):
            ref = re.match(re.escape(project["name"]) + r"\[([^\]]+)\]", requirement.replace(" ", ""))
            if ref:
                todo.extend(part.strip() for part in ref.group(1).split(","))
    return seen


def test_every_lazily_installed_extra_left_out_of_the_bundle_is_classified():
    from pm.extras import ANCHORS

    left_out = set(ANCHORS) - installed_extras(bundle_extras())
    groups = [set(CORE), set(DEFERRED), set(FALLBACK_ONLY), NOT_APEX]
    classified = set().union(*groups)

    assert sum(map(len, groups)) == len(classified), "an extra is classified twice"
    assert left_out - classified == set(), "classify these lazily installed extras (shipped, deferred, fallback or not APEX)"
    assert classified - left_out == set(), "these are no longer left out: drop them from the classification"


def test_the_bundle_ships_what_apex_features_install_on_first_use():
    extras = bundle_extras()
    defined = _pyproject()["project"]["optional-dependencies"]

    assert extras[0] == "all"
    assert set(extras) - {"all"} == set(SHIPPED_FOR_APEX)
    assert [extra for extra in extras if extra not in defined] == []


def _record_installs(monkeypatch) -> list[str]:
    import pm

    asked: list[str] = []

    def ensure_import(extra: str) -> None:
        asked.append(extra)
        raise RuntimeError(f"{extra} installed; restart Hermes to activate it")  # what a Desktop engine gets

    monkeypatch.setattr(pm, "ensure_import", ensure_import)
    return asked


def test_feishu_installs_its_extra_on_first_use(monkeypatch):
    from plugins.platforms.feishu import adapter

    asked = _record_installs(monkeypatch)
    monkeypatch.setattr(adapter, "FEISHU_AVAILABLE", False)

    assert adapter.check_feishu_requirements() is False
    assert asked == ["feishu"]


def test_the_anthropic_sdk_installs_its_extra_on_first_use(monkeypatch):
    from agent import anthropic_adapter

    asked = _record_installs(monkeypatch)
    monkeypatch.setattr(anthropic_adapter, "_anthropic_sdk", ...)
    monkeypatch.setattr(anthropic_adapter, "_anthropic_install_error", None)

    anthropic_adapter._get_anthropic_sdk()
    assert asked == ["anthropic"]


def test_document_reading_installs_its_extra_on_first_use(monkeypatch):
    from tools import read_extract

    asked = _record_installs(monkeypatch)
    monkeypatch.setattr(read_extract, "_anydoc_module", read_extract._ANYDOC_UNSET)
    monkeypatch.setattr(read_extract, "_anydoc_failed_at", None)

    read_extract._anydoc()
    assert asked == ["doc-extract"]


@pytest.mark.parametrize("name", ["minimax", "minimax-cn", "minimax-oauth"])
def test_bring_your_own_key_minimax_talks_the_anthropic_protocol(name):
    from providers import get_provider_profile

    profile = get_provider_profile(name)
    assert profile is not None and profile.api_mode == "anthropic_messages"
