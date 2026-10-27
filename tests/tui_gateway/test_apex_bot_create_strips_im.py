"""hc-1078: a new single-thread assistant never inherits APEX's IM binding (K7: WeChat and Feishu stay on APEX).

APEX Desktop creates an assistant with ``profiles.create`` cloned from default
(``apps/desktop/src/store/single-thread-bot-ops.ts``), which copies the root ``.env`` and
``config.yaml``. The root ``.env`` can still hold the IM-entry credentials Desktop writes
(``apps/desktop/electron/apex-im-entry.ts``: ``FEISHU_*`` from before hc-417 moved Feishu to spawn
injection, ``WEIXIN_*``). Upstream's channel strip (``hermes_cli.profile_channels``) drops them because
the clone never passes ``clone_channels``; these tests pin that for every key the IM entry knows, read
from its source so a key added there is covered too, and for the path where the stripped ``.env`` is left
empty and ``profiles.create`` mirrors the launch ``.env`` in again.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tui_gateway import server

REPO = Path(__file__).resolve().parents[2]
IM_ENTRY = REPO / "apps" / "desktop" / "electron" / "apex-im-entry.ts"

# What single-thread-bot-ops.ts sends (the SOUL is irrelevant here).
CREATE_PARAMS = {"name": "apex-bot-2", "clone_from": "default", "no_alias": True, "share_auth": True,
                 "soul": "You are 剪辑助手, an AI assistant from ApexNodes HK.\n"}


def _im_entry_keys() -> list[str]:
    keys = sorted(set(re.findall(r"'((?:FEISHU|WEIXIN)_[A-Z0-9_]+)'", IM_ENTRY.read_text(encoding="utf-8"))))
    assert {"FEISHU_APP_ID", "FEISHU_APP_SECRET", "WEIXIN_TOKEN", "WEIXIN_ACCOUNT_ID"} <= set(keys), keys
    return keys


def _env_keys(path: Path) -> set[str]:
    pattern = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")
    return {m.group(1) for line in path.read_text(encoding="utf-8").splitlines() if (m := pattern.match(line))}


def _root(tmp_path, monkeypatch, env_lines: list[str]) -> Path:
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    (home / ".env").write_text("\n".join(env_lines) + "\n", encoding="utf-8")
    (home / "config.yaml").write_text(
        "model:\n  provider: custom\n  default: apex-flash\n"
        "platforms:\n  feishu:\n    enabled: true\n  weixin:\n    enabled: true\n",
        encoding="utf-8")
    (home / "SOUL.md").write_text("You are APEX, an intelligent AI assistant from ApexNodes HK.\n", encoding="utf-8")
    return home


def _create(home: Path) -> Path:
    resp = server._methods["profiles.create"](1, dict(CREATE_PARAMS))
    assert "error" not in resp, resp.get("error")
    return home / "profiles" / CREATE_PARAMS["name"]


def test_every_im_entry_key_and_platform_block_stays_behind(tmp_path, monkeypatch):
    keys = _im_entry_keys()
    home = _root(tmp_path, monkeypatch, [f"{key}=from-root-{i}" for i, key in enumerate(keys)] + ["KEEP_ME=tool-key"])

    profile = _create(home)

    assert [key for key in keys if key in _env_keys(profile / ".env")] == []
    assert "KEEP_ME" in _env_keys(profile / ".env")
    config = (profile / "config.yaml").read_text(encoding="utf-8")
    assert "feishu" not in config and "weixin" not in config
    # The root keeps its binding: only the copy is stripped.
    assert set(keys) <= _env_keys(home / ".env")


@pytest.mark.parametrize("key", ["FEISHU_APP_ID", "WEIXIN_TOKEN"])
def test_a_root_env_holding_only_im_keys_is_not_mirrored_back_in(tmp_path, monkeypatch, key):
    home = _root(tmp_path, monkeypatch, [f"{name}=from-root" for name in _im_entry_keys()])

    profile = _create(home)

    assert key not in _env_keys(profile / ".env")
