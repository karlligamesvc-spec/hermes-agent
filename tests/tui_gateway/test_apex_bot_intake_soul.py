"""hc-1079 (APEX Desktop, 多助手第一期 M3): the engine seams a new assistant's first-open questions use.

Desktop saves each answer as a 「分工」 section of the assistant's own SOUL.md through
``profiles.describe`` / ``profiles.configure`` and keeps its progress in
``ui_meta['apex-intake']``, all before the assistant's first message. These pin what that
relies on: the SOUL written through ``profiles.configure`` is what the next new session's
identity part reads (read from disk on every build, no cache, so no engine restart), and the
intake's own ``ui_meta`` key round-trips through ``profiles.list`` without making the profile
Bot-Mode-managed (only ``hermes-bots`` does).
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from tui_gateway import server

TEMPLATE = "You are 剪辑助手, an AI assistant made in APEX by ApexNodes HK.\n"
DIVISION = (
    "## 分工\n\n用户第一次打开你时定的（用户这次说的不一样时以这次为准）：\n"
    "- 主要帮用户：剪辑出片\n- 说话风格：简短直接。先说结论，少铺垫。\n"
)


@pytest.fixture
def profile_dir(tmp_path, monkeypatch) -> Path:
    """A temp hermes root with one named profile, ``bot``, made from the template."""
    root = tmp_path / "hermes_home"
    path = root / "profiles" / "bot"
    path.mkdir(parents=True)
    (path / "SOUL.md").write_text(TEMPLATE, encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(root))
    return path


def _call(method: str, params: dict) -> dict:
    resp = server._methods[method](1, params)
    assert "error" not in resp, resp.get("error")
    return resp["result"]


def _identity(profile_dir: Path) -> str:
    """The identity part a new session's first prompt build gets for an agent of this profile."""
    from agent.system_prompt import _identity_parts

    agent = SimpleNamespace(
        load_soul_identity=False,
        skip_context_files=False,
        _session_db=SimpleNamespace(db_path=str(profile_dir / "state.db")),
    )
    parts, soul_loaded = _identity_parts(agent, None)
    assert soul_loaded
    return parts[0]


def test_soul_written_through_configure_reaches_the_next_prompt_build(profile_dir):
    assert _call("profiles.describe", {"name": "bot"})["soul"] == TEMPLATE
    # A build before the answer reads the template, so a cache would show up below.
    assert _identity(profile_dir) == TEMPLATE.strip()

    soul = f"{TEMPLATE}\n{DIVISION}"
    applied = _call("profiles.configure", {"name": "bot", "soul": soul})["applied"]

    assert applied == {"soul": True}
    assert _call("profiles.describe", {"name": "bot"})["soul"] == soul
    assert _identity(profile_dir) == soul.strip()

    # 撤销 writes the template back; the next build reads it again.
    assert _call("profiles.configure", {"name": "bot", "soul": TEMPLATE})["applied"] == {"soul": True}
    assert _identity(profile_dir) == TEMPLATE.strip()


def test_intake_record_round_trips_and_does_not_make_the_profile_bot_managed(profile_dir):
    from tools.bot_mode_probe import is_bot_mode_managed

    record = {"answers": {"role": "editing", "style": "brief", "platform": "same"}, "status": "noted", "v": 1}
    applied = _call("profiles.configure", {"name": "bot", "ui_meta": {"apex-intake": record}})["applied"]

    assert applied["ui_meta"] is True
    row = next(p for p in _call("profiles.list", {"include_sessions": False})["profiles"] if p["name"] == "bot")
    assert row["ui_meta"] == {"apex-intake": record}
    assert is_bot_mode_managed(profile_dir) is False
    # The record lives in profile.yaml; SOUL.md is untouched by a ui_meta write.
    assert (profile_dir / "SOUL.md").read_text(encoding="utf-8") == TEMPLATE
