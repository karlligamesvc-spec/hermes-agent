"""hc-1083: the multi-bot acceptance tool must catch every fault it claims to check.

apps/desktop/docs/qa/hc-1083/multi_bot_qa.py is a read-only probe the M7 acceptance runs
against a packaged APEX's test home. These tests build real homes (real config.yaml, real
state.db written through SessionDB, real SKILL.md trees), inject one fault at a time and
require the matching check to FAIL, so a checker that cannot see a fault cannot pass review.
The log patterns are pinned to the product source so a reworded log line cannot make
`watch` silently count zero evictions.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
from argparse import Namespace
from pathlib import Path

import pytest

from hermes_state import SessionDB
from tests.waiting import wait_until

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "apps/desktop/docs/qa/hc-1083/multi_bot_qa.py"
_spec = importlib.util.spec_from_file_location("multi_bot_qa", TOOL)
qa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(qa)

RELAY = "https://apex-nodes.com/relay/v1"
KEY = "sk-relay-live-0001-do-not-print"
OLD_KEY = "sk-relay-rotated-out-0000"
PLUGINS = ["apex-overlay", "apexnodes-image-tools", "apexnodes-video-tools"]
DATE = "Conversation started: Monday, October 26, 2026 (Asia/Shanghai, UTC+08:00)"
SKILL = "---\nname: short-video-studio\nversion: 2.8.1\n---\n# 短视频工作室\n"
# hc-1078 writes this first line into a new assistant's SOUL.md; hc-1082's apex_rename rewrites the name in it.
SOUL_LINE = "You are {name}, an AI assistant from ApexNodes HK, working alongside APEX for the same person."


def _config(key: str = KEY, base_url: str = RELAY, plugins: list[str] = PLUGINS) -> dict:
    return {
        "model": {"provider": "custom", "base_url": base_url, "api_key": key, "default": "apex-flash"},
        "custom_providers": [{"name": "apexnodes", "base_url": base_url, "api_key": key, "model": "apex-flash"}],
        "plugins": {"enabled": list(plugins)},
        "skills": {"disabled": []},
    }


def _write_home(home: Path, name: str | None, prompt: str) -> None:
    home.mkdir(parents=True, exist_ok=True)
    _dump(home / "config.yaml", _config())
    (home / ".env").write_text(f"APEXNODES_API_KEY={KEY}\nTZ=Asia/Shanghai\n", encoding="utf-8")
    first = SOUL_LINE.format(name=name) if name else "# APEX"
    (home / "SOUL.md").write_text(f"{first}\n\n## 分工\n剪辑出片\n", encoding="utf-8")
    skill = home / "skills" / "apexnodes" / "short-video-studio"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(SKILL, encoding="utf-8")
    (skill / "scripts").mkdir()
    (skill / "scripts" / "cut.py").write_text("print('cut')\n", encoding="utf-8")
    if name:
        # hc-1081 stamps each assistant's copy with the manifest hash; the root has no stamp
        (home / "skills" / "apexnodes" / qa.PROFILE_SKILLS_STAMP).write_text("176858b8d69bd5fb\n", encoding="utf-8")
        # What hc-1078 writes on create (origin: product) and hc-1079 after the three questions.
        meta = {"ui_meta": {"apex": {"name": name, "shape": "squircle", "color": "teal", "origin": "product"},
                            "apex-intake": {"v": 1, "status": "noted", "answers": {"role": "editing"}}}}
        _dump(home / "profile.yaml", meta)
    _add_main_thread(home, prompt)


def _add_main_thread(home: Path, prompt: str, title: str = qa.MAIN_THREAD_TITLE) -> None:
    """A compressed main thread: the titled root plus a newer segment that holds the live prompt."""
    db = SessionDB(home / "state.db")
    try:
        db.create_session("root", "desktop", system_prompt="旧的提示\n" + DATE, model="apex-flash")
        db.set_session_title("root", title)
        db.create_session("segment", "desktop", system_prompt=prompt, parent_session_id="root", model="apex-flash")
        db.update_token_counts("segment", input_tokens=45_000, output_tokens=900, api_call_count=1)
    finally:
        db.close()


def _prompt(name: str) -> str:
    return f"你叫 {name}。\n\n{DATE}\nModel: apex-flash"


@pytest.fixture
def home(tmp_path: Path) -> Path:
    root = tmp_path / "hermes"
    _write_home(root, None, _prompt("APEX"))
    _write_home(root / "profiles" / "apex-bot-2", "剪辑助手", _prompt("剪辑助手"))
    _write_home(root / "profiles" / "apex-bot-3", "选题助手", _prompt("选题助手"))
    (root / "apex").mkdir()
    (root / "apex" / "memory-ledger-prompt.md").write_text("关于你：做美妆测评\n", encoding="utf-8")
    return root


def _results(home: Path, max_bots: int = 4) -> dict[str, tuple[str, str]]:
    snap = qa.take_snapshot(home)
    return {cid: (status, detail) for cid, _title, status, detail in qa.run_checks(snap, Namespace(max_bots=max_bots))}


def _dump(path: Path, data: dict) -> None:
    """JSON is valid YAML, so the fixture needs no YAML writer; the tool parses it with its own reader."""
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _edit_yaml(path: Path, mutate) -> None:
    data = qa.load_yaml(path)
    mutate(data)
    _dump(path, data)


def test_healthy_home_passes_every_check(home: Path) -> None:
    results = _results(home)

    assert {cid: status for cid, (status, _) in results.items()} == {f"C{i}": "PASS" for i in range(1, 10)}
    assert "3 个主线" in results["C6"][1]  # prompts are read from the system_prompts table, not sessions.system_prompt
    assert "['apex-bot-2', 'apex-bot-3']" in results["C7"][1]


def _lag_custom_provider(home: Path) -> None:
    _edit_yaml(home / "profiles/apex-bot-2/config.yaml", lambda d: d["custom_providers"][0].update(api_key=OLD_KEY))


def _lag_model_key(home: Path) -> None:
    _edit_yaml(home / "profiles/apex-bot-2/config.yaml", lambda d: d["model"].update(api_key=OLD_KEY))


def _bot_off_relay(home: Path) -> None:
    _dump(home / "profiles/apex-bot-2/config.yaml", _config(key="sk-byok", base_url="https://api.example.com/v1"))


def _skill_missing(home: Path) -> None:
    (home / "profiles/apex-bot-3/skills/apexnodes/short-video-studio/scripts/cut.py").unlink()


def _skill_stale(home: Path) -> None:
    (home / "profiles/apex-bot-3/skills/apexnodes/short-video-studio/SKILL.md").write_text(
        SKILL.replace("2.8.1", "2.0.0"), encoding="utf-8")


def _plugin_missing(home: Path) -> None:
    _edit_yaml(home / "profiles/apex-bot-2/config.yaml", lambda d: d["plugins"].update(enabled=PLUGINS[:1]))


def _bot_chat_title(home: Path) -> None:
    db = SessionDB(home / "profiles/apex-bot-2/state.db")
    try:
        db.create_session("bot-chat", "desktop", system_prompt=_prompt("剪辑助手"))
        db.set_session_title("bot-chat", qa.BOT_CHAT_TITLE)
    finally:
        db.close()


def _hermes_bots_meta(home: Path) -> None:
    _edit_yaml(home / "profiles/apex-bot-2/profile.yaml", lambda d: d["ui_meta"].update({"hermes-bots": {"title": "x"}}))


def _replace_prompt(home: Path, prompt: str) -> None:
    db_path = home / "profiles/apex-bot-2/state.db"
    db_path.unlink()
    for extra in ("state.db-wal", "state.db-shm"):
        (home / "profiles/apex-bot-2" / extra).unlink(missing_ok=True)
    _add_main_thread(home / "profiles/apex-bot-2", prompt)


def _origin_missing(home: Path) -> None:
    _edit_yaml(home / "profiles/apex-bot-2/profile.yaml", lambda d: d["ui_meta"]["apex"].pop("origin"))


def _origin_other(home: Path) -> None:
    _edit_yaml(home / "profiles/apex-bot-3/profile.yaml", lambda d: d["ui_meta"]["apex"].update(origin="Product"))


def _soul_name_stale(home: Path) -> None:
    _edit_yaml(home / "profiles/apex-bot-2/profile.yaml", lambda d: d["ui_meta"]["apex"].update(name="小剪"))


def _too_many_bots(home: Path) -> None:
    for n in (4, 5, 6):
        _write_home(home / "profiles" / f"apex-bot-{n}", f"助手{n}", _prompt(f"助手{n}"))


FAULTS = [
    ("key-lag-custom-provider", _lag_custom_provider, "C1"),
    ("key-lag-model", _lag_model_key, "C1"),
    ("bot-off-relay", _bot_off_relay, "C1"),
    ("skill-file-missing", _skill_missing, "C2"),
    ("skill-stale", _skill_stale, "C2"),
    ("plugin-missing", _plugin_missing, "C3"),
    ("bot-chat-title", _bot_chat_title, "C4"),
    ("hermes-bots-meta", _hermes_bots_meta, "C5"),
    ("no-date-line", lambda h: _replace_prompt(h, "你叫 剪辑助手。\nTimezone: Asia/Shanghai"), "C6"),
    ("bot-protocol", lambda h: _replace_prompt(h, _prompt("剪辑助手") + "\n\n" + qa.BOT_PROTOCOL_HEADING), "C6"),
    ("wrong-name", lambda h: _replace_prompt(h, _prompt("APEX")), "C6"),
    ("too-many-bots", _too_many_bots, "C7"),
    ("soul-name-stale", _soul_name_stale, "C8"),
    ("origin-missing", _origin_missing, "C9"),
    ("origin-not-exactly-product", _origin_other, "C9"),
]


@pytest.mark.parametrize(("fault", "inject", "check"), FAULTS, ids=[f[0] for f in FAULTS])
def test_each_fault_fails_its_check(home: Path, fault: str, inject, check: str) -> None:
    assert _results(home)[check][0] == "PASS"
    inject(home)

    status, detail = _results(home)[check]

    assert status == "FAIL", f"{fault}: {check} stayed {status} ({detail})"


def _upstream_bot(home: Path, renamed: bool) -> None:
    """A Bot-mode profile from developer mode; hc-1082's rename tool may give it a ui_meta.apex name, never an origin."""
    bot = home / "profiles" / "upstream-bot"
    _write_home(bot, "上游助手", _prompt("上游助手"))
    meta = {"ui_meta": {"hermes-bots": {"title": "Bot"}}}
    if renamed:
        meta["ui_meta"]["apex"] = {"name": "上游助手"}
    _dump(bot / "profile.yaml", meta)
    _dump(bot / "config.yaml", _config(key="sk-byok", base_url="https://api.example.com/v1"))


@pytest.mark.parametrize("renamed", [False, True], ids=["plain", "renamed-by-tool"])
def test_upstream_bot_profiles_are_not_held_to_product_rules(home: Path, renamed: bool) -> None:
    """Only origin: product marks a product assistant (fork shared/apex-product-assistant.ts), not ui_meta.apex."""
    _upstream_bot(home, renamed)

    results = _results(home, max_bots=4)

    assert {cid: status for cid, (status, _) in results.items()} == {f"C{i}": "PASS" for i in range(1, 10)}
    assert "上游 Bot 模式的不算：['upstream-bot']" in results["C9"][1]


def test_diff_of_an_undo_shows_the_intake_status(home: Path) -> None:
    """C3 in the checklist: undoing the three questions flips ui_meta['apex-intake'].status, nothing else in profile.yaml."""
    before = qa.take_snapshot(home)
    _edit_yaml(home / "profiles/apex-bot-2/profile.yaml", lambda d: d["ui_meta"]["apex-intake"].update(status="undone"))

    assert qa.diff_snapshots(before, qa.take_snapshot(home)) == ["~ homes.apex-bot-2.meta.intake_status: 'noted' -> 'undone'"]


def test_diff_of_a_settings_change_names_the_section_and_the_bot(home: Path) -> None:
    """Settings while several assistants are on edit the assistant on screen (Kael, option A): the diff must say which."""
    before = qa.take_snapshot(home)
    _edit_yaml(home / "profiles/apex-bot-2/config.yaml", lambda d: d.update(tts={"provider": "edge", "voice": "zh-CN-XiaoxiaoNeural"}))
    _edit_yaml(home / "profiles/apex-bot-3/config.yaml", lambda d: d["skills"].update(disabled=[]))  # rewritten, same value
    after = qa.take_snapshot(home)

    lines = qa.diff_snapshots(before, after)

    assert [line.split(" = ")[0] for line in lines] == ["+ homes.apex-bot-2.config.sections.tts"]
    assert "zh-CN-XiaoxiaoNeural" not in json.dumps(after, ensure_ascii=False)


def test_skills_stamp_is_recorded_not_compared(home: Path) -> None:
    """The real 0.17.66 run: every assistant has .apex-manifest and the root has none; C2 must still pass."""
    snap = qa.take_snapshot(home)

    assert snap["homes"]["apex-bot-2"]["platform_skills"]["stamp"] == "176858b8d69b"
    assert snap["homes"]["default"]["platform_skills"]["stamp"] is None
    assert qa.PROFILE_SKILLS_STAMP not in snap["homes"]["apex-bot-2"]["platform_skills"]["files"]


def _prompt_with_template(name: str) -> str:
    return f"{SOUL_LINE.format(name=name)}\n\n{DATE}\nModel: apex-flash"


@pytest.mark.parametrize("who", ["apex-bot-2", "default"])
def test_rename_after_the_session_started_is_a_warning(home: Path, who: str) -> None:
    """G2/G4 on the real run: the thread's prompt keeps the old name until a new segment; the reply is the proof."""
    if who == "default":
        _dump(home / "profile.yaml", {"ui_meta": {"apex": {"name": "小橙"}}})
    else:
        _replace_prompt(home, _prompt_with_template("剪辑助手"))
        _edit_yaml(home / "profiles/apex-bot-2/profile.yaml", lambda d: d["ui_meta"]["apex"].update(name="小剪"))
        (home / "profiles/apex-bot-2/SOUL.md").write_text(SOUL_LINE.format(name="小剪") + "\n", encoding="utf-8")

    status, detail = _results(home)["C6"]

    assert status == "WARN", detail
    assert ("剪辑助手" if who != "default" else "APEX") in detail


def test_watcher_survives_a_process_that_fails_mid_exit(home: Path, monkeypatch) -> None:
    """psutil raises SystemError from cmdline() while a process exits (seen at L2 on the real run)."""
    if qa.psutil is None:
        pytest.skip("needs psutil")

    class Exiting:
        pid = 424242

        def environ(self):
            return {"HERMES_HOME": str(home)}

        def as_dict(self, attrs=None):
            raise SystemError("<built-in function proc_cmdline> returned a result with an exception set")

    monkeypatch.setattr(qa.psutil, "process_iter", lambda *a, **k: iter([Exiting()]))

    assert qa.our_processes(home, {}) == {}


def test_snapshot_never_contains_secret_values(home: Path) -> None:
    _lag_custom_provider(home)
    text = json.dumps(qa.take_snapshot(home), ensure_ascii=False)

    assert KEY not in text and OLD_KEY not in text
    assert qa.fingerprint(KEY) in text and qa.fingerprint(OLD_KEY) in text


def test_cli_check_exit_code_follows_failures(home: Path, capsys) -> None:
    assert qa.main(["check", "--home", str(home)]) == 0
    _plugin_missing(home)
    assert qa.main(["check", "--home", str(home)]) == 1
    assert "FAIL C3" in capsys.readouterr().out


def test_diff_of_a_rename_touches_only_that_bot(home: Path, tmp_path: Path) -> None:
    before = qa.take_snapshot(home)
    _edit_yaml(home / "profiles/apex-bot-2/profile.yaml", lambda d: d["ui_meta"]["apex"].update(name="小剪"))

    lines = qa.diff_snapshots(before, qa.take_snapshot(home))

    assert lines and all(line[2:].startswith("homes.apex-bot-2.") for line in lines), lines
    assert any("ui_meta_apex.name" in line and "小剪" in line for line in lines)


def test_snapshot_counts_requested_and_ran_tool_calls(home: Path) -> None:
    """G2 in the checklist: a one-sentence rename must show apex_rename called, and no apex_memory write."""
    before = qa.take_snapshot(home)
    db = SessionDB(home / "profiles/apex-bot-2/state.db")
    try:
        call = {"id": "call-1", "type": "function", "function": {"name": "apex_rename", "arguments": '{"name": "小剪"}'}}
        db.append_message("segment", "assistant", content="", tool_calls=[call])
        db.append_message("segment", "tool", content="已改名为小剪", tool_name="apex_rename", tool_call_id="call-1")
        mid = qa.take_snapshot(home)["homes"]["apex-bot-2"]["sessions"]["main_thread_last_message"]
        db.append_message("segment", "assistant", content="好的，以后我叫小剪。", finish_reason="stop")
    finally:
        db.close()

    after = qa.take_snapshot(home)
    # F4–F6: a background turn that finished and was delivered ends on the assistant's answer, not on a tool result
    assert (mid["role"], mid["tool_name"]) == ("tool", "apex_rename")
    last = after["homes"]["apex-bot-2"]["sessions"]["main_thread_last_message"]
    assert (last["role"], last["finish_reason"], last["chars"]) == ("assistant", "stop", len("好的，以后我叫小剪。"))

    assert after["homes"]["apex-bot-2"]["sessions"]["tool_calls"] == {"requested": {"apex_rename": 1}, "ran": {"apex_rename": 1}}
    assert after["homes"]["apex-bot-3"]["sessions"]["tool_calls"] == {"requested": {}, "ran": {}}
    lines = qa.diff_snapshots(before, after)
    assert "+ homes.apex-bot-2.sessions.tool_calls.requested.apex_rename = 1" in lines
    assert not [line for line in lines if "apex_memory" in line or line[2:].startswith("shared")]


def test_tokens_sums_every_assistant(home: Path, capsys) -> None:
    assert qa.main(["tokens", "--home", str(home)]) == 0
    assert "合计：调用 3，输入 135000，输出 2700" in capsys.readouterr().out


# Product log text the watcher matches: (event, [(source file, literal in it), ...], rendered line).
# Any listed source may carry it: hc-1080 (fork #500) moves the reap and relay-key lines out of main.ts.
_MAIN = "apps/desktop/electron/main.ts"
_POOL = "apps/desktop/electron/apex-pool-engines.ts"
_PROFILE_CONFIG = "apps/desktop/electron/apex-profile-config.ts"
_KEY_HOLDERS = "apps/desktop/electron/apex-engine-relay-key.ts"
_BOT_SWITCH = "apps/desktop/src/store/bot-switch-log.ts"
_RENDERER_LOG = "apps/desktop/electron/renderer-log.ts"
_SWITCH_LINE = ("[renderer console:main] [multi-bot] switch default → apex-bot-5 still waiting after 15003 ms "
                "(app://-/assets/index-Bx1.js:41)")
LOG_CONTRACT = [
    ("pool_start", [(_MAIN, 'Starting Hermes backend for profile "${profile}" via ${backend.label}')],
     'Starting Hermes backend for profile "apex-bot-2" via bundled runtime'),
    ("primary_start", [(_MAIN, "rememberLog(`Starting Hermes backend via ${backend.label}`)")],
     "Starting Hermes backend via bundled runtime"),
    ("ready", [("hermes_cli/web_server.py", 'f"HERMES_BACKEND_READY port={actual_port}"')], "HERMES_BACKEND_READY port=50123"),
    ("slot_wait", [(_MAIN, "waiting for a free local slot (${localBackendSpawnCoordinator.activeCount}/${poolMaxBackends()} busy, "
                           "${localBackendSpawnCoordinator.queuedCount} queued)")],
     'Profile backend "apex-bot-5" waiting for a free local slot (3/3 busy, 1 queued)'),
    ("slot_timeout", [("apps/desktop/electron/pool-spawn-coordinator.ts",
                       "`Local backend start for \"${key}\" timed out while waiting for a free slot.`")],
     'Local backend start for "apex-bot-5" timed out while waiting for a free slot.'),
    ("evict", [(_MAIN, 'Evicting idle profile backend "${profile}" (LRU cap')],
     'Evicting idle profile backend "apex-bot-2" (LRU cap 3)'),
    ("evict_room", [(_POOL, 'Evicting profile backend "${key}" to make room for another assistant (${verdict.reason})')],
     'Evicting profile backend "apex-bot-2" to make room for another assistant (committed)'),
    ("reap", [(_MAIN, 'Reaping idle profile backend "${profile}" (idle >'),
              (_POOL, 'Reaping idle profile backend "${label}" (idle >')],
     'Reaping idle profile backend "apex-bot-2" (idle > 600s): committed'),
    ("reap", [(_MAIN, 'Reaping idle profile backend "${profile}" (idle >'),
              (_POOL, 'Reaping idle profile backend "${label}" (idle >')],
     'Reaping idle profile backend "apex-bot-2" (idle > 600s)'),
    ("reap_kept", [(_POOL, 'Keeping idle profile backend "${label}" another ${deps.idleSeconds}s: '
                           "the engine did not retire (${verdict.reason})")],
     'Keeping idle profile backend "apex-bot-2" another 600s: the engine did not retire (turn-running)'),
    ("start_failed", [(_MAIN, 'Hermes backend for profile "${profile}" exited before it became ready')],
     'Hermes backend for profile "apex-bot-2" exited before it became ready (1).'),
    ("exit", [(_MAIN, 'Hermes backend for profile "${profile}" exited (${signal || code})')],
     'Hermes backend for profile "apex-bot-2" exited (SIGTERM)'),
    ("relay_key", [(_MAIN, "[apexnodes] config.yaml relay key refreshed (${reason})"),
                   (_PROFILE_CONFIG, "`[apexnodes] ${subject} relay key refreshed (${reason})")],
     "[apexnodes] config.yaml relay key refreshed (sign-in) to sk-…0001 — model.api_key:updated"),
    ("relay_key", [(_MAIN, "[apexnodes] config.yaml relay key refreshed (${reason})"),
                   (_PROFILE_CONFIG, "`[apexnodes] ${subject} relay key refreshed (${reason})")],
     "[apexnodes] profile apex-bot-2 config.yaml relay key refreshed (sign-in) to sk-…0001 — model.api_key:updated"),
    ("relay_key", [(_MAIN, "[apexnodes] config.yaml relay key write FAILED (${reason})"),
                   (_PROFILE_CONFIG, "`[apexnodes] ${subject} relay key write FAILED (${reason})")],
     "[apexnodes] config.yaml relay key write FAILED (sign-in): unreadable"),
    # hc-1106 moved these to one module; the holder labels are pinned next to them
    ("key_restart", [(_KEY_HOLDERS, "`[apexnodes] restarting ${holder.label} for the refreshed relay key (${reason}; ${verdict.reason})`")],
     '[apexnodes] restarting primary backend "apex-bot-2" for the refreshed relay key (managed-runtime-complete; committed)'),
    ("key_restart", [(_KEY_HOLDERS, 'label: `primary backend "${profile}"`')],
     '[apexnodes] restarting primary backend "default" for the refreshed relay key (sign-in; idle)'),
    ("key_restart", [(_KEY_HOLDERS, 'label: `profile backend "${key}"`')],
     '[apexnodes] restarting profile backend "apex-bot-3" for the refreshed relay key (sign-in; committed)'),
    ("key_restart", [(_KEY_HOLDERS, "label: 'messaging gateway'")],
     "[apexnodes] restarting messaging gateway for the refreshed relay key (sign-in; idle)"),
    ("key_wait", [(_KEY_HOLDERS, "`[apexnodes] ${holder.label} still holds the previous relay key; restarting it once idle (${verdict.reason}; ${reason})`")],
     '[apexnodes] primary backend "apex-bot-2" still holds the previous relay key; restarting it once idle (turn-running; sign-in)'),
    ("key_adopt", [(_KEY_HOLDERS, "`[apexnodes] ${holder.label} was started signed out; its new sessions take the relay key from config.yaml (${reason})`")],
     '[apexnodes] primary backend "default" was started signed out; its new sessions take the relay key from config.yaml (managed-runtime-complete)'),
    ("key_reload_primary", [(_MAIN, "[apexnodes] reloading the local backend so it picks up the refreshed relay key (${reason})")],
     "[apexnodes] reloading the local backend so it picks up the refreshed relay key (sign-in)…"),
    # hc-1099: the renderer writes the line, main's console capture puts it in desktop.log; both halves are pinned
    ("bot_switch", [(_BOT_SWITCH, "console.error(`[multi-bot] ${text}`)")], _SWITCH_LINE),
    ("bot_switch", [(_RENDERER_LOG, "`[renderer console:${label}] ${String(text)} (${String(src)}:${String(lineNo)})`")],
     _SWITCH_LINE),
]


@pytest.mark.parametrize(("event", "sources", "line"), LOG_CONTRACT, ids=[f"{c[0]}-{i}" for i, c in enumerate(LOG_CONTRACT)])
def test_log_patterns_match_the_product_text(event: str, sources: list[tuple[str, str]], line: str) -> None:
    present = [(path, literal) for path, literal in sources if (REPO / path).exists()]
    if not present:
        pytest.skip(f"none of {[p for p, _ in sources]} is on this tree yet")
    assert any(literal in (REPO / path).read_text(encoding="utf-8-sig") for path, literal in present), \
        f"no longer logged anywhere: {sources}"
    stamp_format = (REPO / "apps/desktop/electron/desktop-log-line.ts").read_text(encoding="utf-8-sig")
    assert "`[${stamp}] [hermes] ${text}`" in stamp_format

    parsed = qa.parse_log_line(f"[2026-10-26T12:00:00.000Z] [hermes] {line}")

    assert parsed is not None and parsed["event"] == event
    if "profile apex-bot-2 config.yaml" in line:
        assert parsed["profile"] == "apex-bot-2"
    if event in ("evict_room", "reap") and "committed" in line:
        assert parsed["profile"] == "apex-bot-2" and parsed["reason"] == "committed"


@pytest.mark.parametrize(("detail", "also_401"), [
    # the reason carries main's own words; it must not be counted as a second slot_timeout
    ('switch default → apex-bot-5 failed after 30012 ms: Local backend start for "apex-bot-5" timed out while '
     "waiting for a free slot.", False),
    ("switch to apex-bot-2 undone: the conversation on screen belongs to default (while that switch was still under way)", False),
    ("switch default → apex-bot-2 failed after 812 ms: HTTP 401 Unauthorized", True),
])
def test_switch_diagnostics_are_read_whole(detail: str, also_401: bool) -> None:
    line = f"[2026-10-28T20:00:00.000Z] [hermes] [renderer console:main] [multi-bot] {detail} (app://-/assets/index-Bx1.js:41)"

    parsed = qa.parse_log_line(line)

    assert (parsed["event"], parsed["detail"]) == ("bot_switch", detail)
    assert bool(parsed.get("also_401")) is also_401


def _ev(t: float, kind: str, **fields) -> dict:
    return {"t": t, "iso": qa.iso(t), "kind": kind, **fields}


def test_report_times_cold_starts_and_slot_waits() -> None:
    mb = 2**20
    events = [
        _ev(100.0, "log", event="primary_start", text="Starting Hermes backend via x"),
        _ev(100.2, "proc_new", pid=10, proc_kind="engine", profile="default"),
        _ev(104.0, "listen", pid=10, ports=[50001], profile="default"),
        _ev(104.1, "log", event="ready", port="50001", text="HERMES_BACKEND_READY port=50001"),
        _ev(200.0, "mark", label="点了剪辑助手"),
        _ev(200.5, "log", event="pool_start", profile="apex-bot-2", text="Starting …"),
        _ev(200.6, "proc_new", pid=11, proc_kind="engine", profile="apex-bot-2"),
        _ev(205.0, "log", event="ready", port="59999", text="HERMES_BACKEND_READY port=59999"),  # someone else's port
        _ev(209.0, "listen", pid=11, ports=[50002], profile="apex-bot-2"),  # its READY line never reached the log
        _ev(240.0, "mem", engines={"11": {"profile": "apex-bot-2", "rss": 300 * mb, "uss": 200 * mb, "tree_rss": 320 * mb}},
            all_rss=900 * mb, processes=9),
        _ev(260.0, "mem", engines={"11": {"profile": "apex-bot-2", "rss": 310 * mb, "uss": 205 * mb, "tree_rss": 500 * mb}},
            all_rss=1100 * mb, processes=10),
        _ev(300.0, "log", event="slot_wait", profile="apex-bot-5", text="waiting"),
        _ev(314.0, "log", event="evict", profile="apex-bot-3", text="Evicting idle profile backend"),
        _ev(314.5, "proc_gone", pid=12, proc_kind="engine", profile="apex-bot-3"),
        _ev(314.8, "log", event="reap_kept", profile="apex-bot-2", reason="turn-running", text="Keeping idle profile backend"),
        _ev(314.9, "log", event="evict_room", profile="apex-bot-4", reason="committed", text="Evicting profile backend"),
        _ev(315.0, "log", event="pool_start", profile="apex-bot-5", text="Starting …"),
        _ev(315.1, "proc_new", pid=14, proc_kind="engine", profile="apex-bot-5"),
        _ev(321.9, "listen", pid=14, ports=[50004], profile="apex-bot-5"),
        _ev(322.0, "log", event="ready", port="50004", text="HERMES_BACKEND_READY port=50004"),
        _ev(330.0, "proc_new", pid=20, proc_kind="gateway", profile="default"),
    ]

    report = qa.build_report(events)
    rows = {r["profile"]: r for r in report["engines"]}

    assert set(rows) == {"default", "apex-bot-2", "apex-bot-5"}
    assert (rows["default"]["cold_start"], rows["default"]["ready_source"]) == (4.1, "READY")
    assert (rows["apex-bot-2"]["cold_start"], rows["apex-bot-2"]["ready_source"]) == (8.5, "listen")
    assert (rows["apex-bot-2"]["mark"], rows["apex-bot-2"]["mark_to_ready"]) == ("点了剪辑助手", 9.0)
    assert (rows["apex-bot-5"]["slot_wait"], rows["apex-bot-5"]["cold_start"]) == (15.0, 22.0)
    assert report["memory"] == [{"profile": "apex-bot-2", "pid": 11, "rss_settled_mb": 300, "uss_settled_mb": 200, "tree_peak_mb": 500}]
    assert [e["event"] for e in report["pool_events"]] == ["slot_wait", "evict", "reap_kept", "evict_room"]
    assert report["engine_exits"] == [{"iso": qa.iso(314.5), "profile": "apex-bot-3", "pid": 12}]
    assert (report["peak_all_rss_mb"], report["peak_engines"]) == (1100, 1)
    assert "| apex-bot-5 | 14 | 15.0 | 22.0 | READY |" in qa.render_report(report)


@pytest.mark.parametrize(("line", "event", "holder"), [
    ('[apexnodes] restarting primary backend "apex-bot-2" for the refreshed relay key (sign-in; committed)', "key_restart", "apex-bot-2"),
    ('[apexnodes] restarting profile backend "apex-bot-3" for the refreshed relay key (sign-in; committed)', "key_restart", "apex-bot-3"),
    ("[apexnodes] restarting messaging gateway for the refreshed relay key (sign-in; idle)", "key_restart", "消息网关"),
    ('[apexnodes] primary backend "default" still holds the previous relay key; restarting it once idle (x; y)', "key_wait", "default"),
    ('[apexnodes] primary backend "default" was started signed out; its new sessions take the relay key from config.yaml (x)', "key_adopt", "default"),
    ("[apexnodes] reloading the local backend so it picks up the refreshed relay key (sign-in)…", "key_reload_primary", "主引擎"),
])
def test_key_holder_lines_name_the_engine(line: str, event: str, holder: str) -> None:
    parsed = qa.parse_log_line(f"[2026-10-30T16:07:27.047Z] [hermes] {line}")

    assert parsed["event"] == event
    assert qa._key_holder(parsed) == holder


def test_report_lists_key_restarts_switch_diagnostics_and_every_401() -> None:
    detail = "switch default → apex-bot-2 failed after 812 ms: HTTP 401 Unauthorized"
    events = [
        _ev(10.0, "log", event="key_restart", profile="apex-bot-3", text="[apexnodes] restarting profile backend"),
        _ev(10.1, "log", event="key_reload_primary", text="[apexnodes] reloading the local backend"),
        _ev(20.0, "log", event="bot_switch", detail=detail, also_401=True, text="[renderer console:main] [multi-bot] …"),
        _ev(21.0, "log", event="http_401", text="POST /v1/chat/completions 401"),
    ]

    report = qa.build_report(events)
    text = qa.render_report(report)

    # problem 9: the primary engine shows up only when something reloaded it
    assert report["key_restarts"] == [{"iso": qa.iso(10.0), "profile": "apex-bot-3"}, {"iso": qa.iso(10.1), "profile": "主引擎"}]
    assert report["http_401"] == 2
    assert f"- {qa.iso(10.1)} 为新 key 重启 主引擎" in text
    assert f"- {qa.iso(20.0)} 切换诊断 [multi-bot] {detail}" in text
    assert "- 含 401 的日志行：2" in text


def test_report_says_which_engines_waited_or_were_not_restarted() -> None:
    report = qa.build_report([
        _ev(30.0, "log", event="key_wait", profile="apex-bot-2", text="[apexnodes] primary backend"),
        _ev(31.0, "log", event="key_adopt", profile="default", text="[apexnodes] primary backend"),
        _ev(32.0, "log", event="key_restart", text="[apexnodes] restarting messaging gateway"),
    ])
    text = qa.render_report(report)

    assert report["key_restarts"] == [{"iso": qa.iso(32.0), "profile": "消息网关"}]
    assert f"- {qa.iso(30.0)} apex-bot-2 还拿着旧 key，等它闲下来再重启" in text
    assert f"- {qa.iso(31.0)} default 是没登录时起的，没重启" in text


@pytest.mark.parametrize(("argv", "expected"), [
    (["/h/versions/a1/venv/bin/python3.14", "/h/versions/a1/venv/bin/hermes", "--profile", "apex-bot-2", "serve", "--port", "0"],
     ("engine", "apex-bot-2")),
    (["C:\\Users\\u\\.apexnodes\\versions\\a1\\venv\\Scripts\\hermes.exe", "serve", "--host", "127.0.0.1"], ("engine", "default")),
    (["/h/venv/bin/python3", "-m", "hermes_cli.main", "gateway", "run", "--replace"], ("gateway", "default")),
    (["/qa/APEX.app/Contents/MacOS/APEX", "--use-mock-keychain"], ("other", None)),
    (["/h/versions/a1/.runtime/bin/ffmpeg", "-i", "serve.mp4"], ("other", None)),
])
def test_classify_engine_gateway_and_others(argv: list[str], expected: tuple) -> None:
    assert qa.classify(argv) == expected


_FAKE_ENGINE = """
import socket, subprocess, sys
tool = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE)
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen()
sys.stdout.write(f"{s.getsockname()[1]} {tool.pid}\\n"); sys.stdout.flush()
sys.stdin.read()
tool.stdin.close(); tool.wait()
"""


def _spawn_fake_engine(home: Path, profile: str) -> tuple[subprocess.Popen, int, int]:
    """A stand-in engine (hermes --profile X serve) that listens on a port and owns one tool child."""
    argv = [sys.executable, "-c", _FAKE_ENGINE, "hermes", "--profile", profile, "serve"]
    proc = subprocess.Popen(argv, env={**os.environ, "HERMES_HOME": str(home)}, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, text=True, encoding="utf-8")
    port, tool_pid = (int(x) for x in proc.stdout.readline().split())
    return proc, port, tool_pid


def _stop(proc: subprocess.Popen) -> None:
    proc.stdin.close()
    proc.wait(timeout=20)


@pytest.mark.skipif(qa.psutil is None, reason="needs psutil")
def test_watcher_follows_a_real_engine_process_of_the_test_home(tmp_path: Path) -> None:
    home, other = tmp_path / "hermes", tmp_path / "someone-elses-home"
    home.mkdir()
    other.mkdir()
    out = tmp_path / "run.jsonl"
    watcher = qa.Watcher(home, qa.Recorder(out), uss=False)
    foreign, _, _ = _spawn_fake_engine(other, "apex-bot-9")
    engine, port, tool_pid = _spawn_fake_engine(home, "apex-bot-2")
    try:
        wait_until(lambda: {engine.pid, tool_pid} <= watcher.poll_processes().keys(), timeout=20, what="engine + tool seen")
        wait_until(lambda: watcher.poll_listen() or engine.pid not in watcher.unready, timeout=20, what="listen seen")
        watcher.sample_memory(watcher.known)
        assert foreign.pid not in watcher.known
    finally:
        _stop(engine)
        _stop(foreign)
    wait_until(lambda: engine.pid not in watcher.poll_processes(), timeout=20, what="engine gone")

    events = qa.load_events(out)
    kinds = [(e["kind"], e.get("profile")) for e in events if e.get("pid") == engine.pid]
    assert kinds == [("proc_new", "apex-bot-2"), ("listen", "apex-bot-2"), ("proc_gone", "apex-bot-2")]
    assert not [e for e in events if e.get("pid") == foreign.pid or e.get("profile") == "apex-bot-9"]
    assert next(e for e in events if e["kind"] == "listen")["ports"] == [port]
    sample = next(e for e in events if e["kind"] == "mem")["engines"][str(engine.pid)]
    assert sample["tree_rss"] > sample["rss"]  # the tool child counts toward its engine


def test_fixture_writes_a_video_of_the_requested_length(tmp_path: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not (ffmpeg and ffprobe):
        pytest.skip("needs ffmpeg + ffprobe on PATH")
    out = tmp_path / "long.mp4"

    assert qa.main(["fixture", "--out", str(out), "--minutes", "0.05", "--ffmpeg", ffmpeg]) == 0

    probe = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)],
                           capture_output=True, text=True, encoding="utf-8", check=True, timeout=60)
    assert abs(float(probe.stdout) - 3.0) < 0.2
