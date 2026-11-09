"""hc-1193: what Desktop Settings saves for APEX's own voice is what the engine speaks APEX's voice for.

Settings › 语音 saves ``tts.provider: ''`` for 「APEX 配音（默认）」, and 恢复默认 sends upstream's
DEFAULT_CONFIG with that one value replaced (``apps/desktop/src/app/settings/apex-voice.ts``).
These run the real ``PUT /api/config`` (deep merge + default stripping) and the overlay's
``load_tts_config`` against the file it writes; the Desktop side is pinned by its own vitest.
"""

import copy
from pathlib import Path
from types import SimpleNamespace

import pytest

from apex_overlay import doubao_tts as adapter

ABSENT = "<absent>"


@pytest.fixture
def home(tmp_path, monkeypatch):
    import hermes_cli.config as config_mod
    from tui_gateway import server
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(server, "_hermes_home", tmp_path)
    for cache in (config_mod._LOAD_CONFIG_CACHE, config_mod._RAW_CONFIG_CACHE, config_mod._LAST_EXPANDED_CONFIG_BY_PATH):
        cache.clear()
    server._cfg_cache = server._cfg_sig = server._cfg_path = None
    yield tmp_path
    server._cfg_cache = server._cfg_sig = server._cfg_path = None


@pytest.fixture
def overlay(monkeypatch):
    """The overlay's TTS seams applied for real, put back after the test."""
    from tools import tts_tool, tts_tool_delivery
    from tools.registry import registry
    entry = registry.get_entry("text_to_speech")
    monkeypatch.setattr(entry, "dynamic_schema_overrides", entry.dynamic_schema_overrides)
    for name in ("_load_tts_config", "_select_builtin_engine", "_dispatch_to_plugin_provider", "DEFAULT_PROVIDER"):
        monkeypatch.setattr(tts_tool, name, getattr(tts_tool, name))
    monkeypatch.setattr(tts_tool_delivery, "PROVIDER_MAX_TEXT_LENGTH", dict(tts_tool_delivery.PROVIDER_MAX_TEXT_LENGTH))
    adapter.apply(SimpleNamespace(register_tts_provider=lambda provider: None))
    return tts_tool


def _write(home: Path, provider):
    text = "display:\n  skin: mono\n"
    if provider is not None:
        text += f"tts:\n  provider: {provider!r}\n"
    (home / "config.yaml").write_text(text, encoding="utf-8")


def _client():
    from starlette.testclient import TestClient
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app
    return TestClient(app, raise_server_exceptions=False), {_SESSION_HEADER_NAME: _SESSION_TOKEN}


def _put(config: dict) -> None:
    client, headers = _client()
    response = client.put("/api/config", json={"config": config}, headers=headers)
    assert response.status_code == 200, response.text


def _saved_provider():
    from hermes_cli.config_effective import load_user_config_effective
    return (load_user_config_effective(fail_closed=True).get("tts") or {}).get("provider", ABSENT)


def _desktop_reset_payload() -> dict:
    """What Desktop's 恢复默认 sends after hc-1193: GET /api/config/defaults with tts.provider ''."""
    from hermes_cli.config import DEFAULT_CONFIG
    payload = copy.deepcopy(DEFAULT_CONFIG)
    payload["tts"]["provider"] = ""
    return payload


@pytest.mark.parametrize("before", [None, "edge", "openai", "doubao", ""], ids=["nothing", "edge", "openai", "doubao", "empty"])
def test_reset_from_desktop_leaves_apex_voice_whatever_was_saved(home, overlay, before):
    _write(home, before)
    _put(_desktop_reset_payload())
    assert _saved_provider() == ""
    assert overlay._get_provider(overlay._load_tts_config()) == "doubao"
    # Both reads Desktop makes see the cleared value, not upstream's Edge default.
    client, headers = _client()
    for path in ("/api/config", "/api/config?include_defaults=false"):
        assert client.get(path, headers=headers).json()["tts"]["provider"] == "", path


@pytest.mark.parametrize("before, after", [(None, ABSENT), ("openai", "edge"), ("doubao", "edge"), ("", "edge")],
                         ids=["nothing", "openai", "doubao", "empty"])
def test_upstream_defaults_wrote_edge_only_over_a_saved_provider(home, overlay, before, after):
    """Before hc-1193 恢复默认 sent DEFAULT_CONFIG as it is: the backend strips defaults except at
    paths the file already had, so `edge` landed exactly where a provider had been saved."""
    from hermes_cli.config import DEFAULT_CONFIG
    _write(home, before)
    _put(copy.deepcopy(DEFAULT_CONFIG))
    assert _saved_provider() == after
    assert overlay._get_provider(overlay._load_tts_config()) == ("doubao" if after == ABSENT else "edge")


@pytest.mark.parametrize("before", ["edge", "openai"])
def test_choosing_apex_voice_in_settings_speaks_apex_voice(home, overlay, before):
    _write(home, before)
    _put({"tts": {"provider": ""}})  # the autosave diff for 「APEX 配音（默认）」
    assert _saved_provider() == ""
    assert overlay._get_provider(overlay._load_tts_config()) == "doubao"
    assert (home / "config.yaml").read_text(encoding="utf-8").count("skin: mono") == 1


@pytest.mark.parametrize("before", [None, "", "openai"], ids=["nothing", "empty", "openai"])
def test_a_provider_chosen_over_apex_voice_sticks(home, overlay, before):
    """Desktop writes a chosen provider onto a cleared value first (apex-voice.ts `saveOverApexVoice`)."""
    _write(home, before)
    _put({"tts": {"provider": ""}})
    _put({"tts": {"provider": "edge"}})
    assert _saved_provider() == "edge"
    assert overlay._get_provider(overlay._load_tts_config()) == "edge"


def test_edge_alone_over_nothing_saved_is_dropped_as_a_default(home, overlay):
    """Why the cleared value first: a lone `edge` equals upstream's default, and the backend strips it."""
    _write(home, None)
    _put({"tts": {"provider": "edge"}})
    assert _saved_provider() == ABSENT
    assert overlay._get_provider(overlay._load_tts_config()) == "doubao"


def test_the_no_engine_sentence_names_the_settings_entry_as_desktop_shows_it():
    """The sentence sends the user to 「APEX 配音（默认）」: that must be the entry's name in Desktop's
    zh copy (apps/desktop/src/i18n/settings-product.ts), and it must not tell the model to switch."""
    import re
    copy_file = Path(__file__).resolve().parents[2] / "apps/desktop/src/i18n/settings-product.ts"
    zh = copy_file.read_text(encoding="utf-8").split("const zh: SettingsProductCopy = {", 1)[1].split("\n}", 1)[0]
    label = re.search(r"apexVoice: '([^']+)'", zh).group(1)
    message = adapter.missing_engine_message("edge")
    assert f"「{label}」" in message
    assert "选不回" not in message and "不要替用户改设置" in message
