"""hc-1219 The jianying_draft tool: offered only with the switch on and 剪映 here; written drafts are checked against
剪映's own list (apex_overlay/jianying_draft.py)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from apex_overlay import jianying_build, jianying_draft, jianying_install


class Recorder:
    def __init__(self):
        self.tools = []

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)


@pytest.fixture
def switch(monkeypatch):
    monkeypatch.setenv(jianying_draft.SWITCH_ENV, "1")


def _installation(tmp_path, with_drafts=True):
    root = tmp_path / "Projects" / "com.lveditor.draft"
    if with_drafts:
        root.mkdir(parents=True)
    return jianying_install.Installation(app=tmp_path / "app", version="11.7.0", user_data=tmp_path,
                                         draft_root=root if with_drafts else None)


@pytest.mark.parametrize("value", ["", "0", "true", " 2 "])
def test_switch_off_registers_nothing(monkeypatch, value):
    monkeypatch.setenv(jianying_draft.SWITCH_ENV, value)
    host = Recorder()
    assert jianying_draft.apply(host) is True
    assert host.tools == []


def test_switch_on_registers_the_tool_offered_only_where_jianying_is(switch, monkeypatch, tmp_path):
    from tools.registry import _NO_CACHE_CHECK_FNS

    host = Recorder()
    assert jianying_draft.apply(host) is True
    [tool] = host.tools
    assert (tool["name"], tool["toolset"], tool["schema"]) == (jianying_draft.TOOL, jianying_draft.TOOLSET,
                                                               jianying_draft.SCHEMA)
    check = tool["check_fn"]
    assert check in _NO_CACHE_CHECK_FNS  # asked each time the list is built: 剪映 can be installed meanwhile

    for found, offered in ((None, False), (_installation(tmp_path, with_drafts=False), False),
                           (_installation(tmp_path), True)):
        monkeypatch.setattr(jianying_install, "find", lambda *a, _f=found, **k: _f)
        assert check() is offered
    monkeypatch.delenv(jianying_draft.SWITCH_ENV)
    assert check() is False


@pytest.fixture
def writing(monkeypatch, tmp_path, switch):
    """write_draft with the build stubbed: a real folder, so the checks read real files."""
    found = _installation(tmp_path)
    monkeypatch.setattr(jianying_install, "find", lambda *a, **k: found)
    monkeypatch.setattr(jianying_build, "load_plan", lambda *a, **k: object())
    folder = found.draft_root / "成片"

    def write(plan, root, name, **kwargs):
        folder.mkdir()
        (folder / "draft_info.json").write_text(json.dumps({"duration": 9_000_000, "materials": {}}),
                                                encoding="utf-8")
        (folder / "draft_meta_info.json").write_text("{}", encoding="utf-8")
        return jianying_build.Written(folder=folder, duration_us=9_000_000, shots=3, subtitles=2, notes=[])

    monkeypatch.setattr(jianying_build, "write", write)
    monkeypatch.setattr(jianying_draft, "POLL_SECONDS", 0.01)
    return folder


def _listed(monkeypatch, folder, entry_after_calls=0, duration=9_000_000, timeline=True):
    calls = {"n": 0}

    def registration(path):
        calls["n"] += 1
        if calls["n"] <= entry_after_calls:
            return None
        return {"timeline_exists": timeline, "duration_us": duration}

    monkeypatch.setattr(jianying_install, "registration", registration)
    return calls


@pytest.mark.parametrize(("platform", "export"), [("darwin", "文件 › 导出"), ("win32", "右上角「导出」")])
def test_a_draft_jianying_lists_is_handed_over(writing, monkeypatch, platform, export):
    monkeypatch.setattr(jianying_install, "running", lambda *a: True)
    _listed(monkeypatch, writing)
    result = jianying_draft.write_draft({"timeline": "t.json", "name": "成片"}, platform=platform, wait=1)
    assert result["status"] == "written"
    assert result["draft"] == {"name": "成片", "folder": str(writing), "seconds": 9.0, "shots": 3, "subtitles": 2}
    assert result["jianying"] == {"version": "11.7.0", "platform": platform, "registered": True}
    assert result["problem"] is None
    assert export in result["note"] and "不写草稿的文件夹路径" in result["note"]


@pytest.mark.parametrize(
    ("listed", "why"),
    [
        (dict(entry_after_calls=10_000), "首页没有出现这份草稿"),
        (dict(duration=0), "剪映登记的时长是 0"),
        (dict(timeline=False), "剪映登记的时间线文件不存在"),
    ],
)
def test_a_draft_jianying_does_not_take_in_is_reported_not_handed_over(writing, monkeypatch, listed, why):
    monkeypatch.setattr(jianying_install, "running", lambda *a: True)
    monkeypatch.setattr(jianying_build, "announce_again", lambda folder: None)
    _listed(monkeypatch, writing, **listed)
    result = jianying_draft.write_draft({"timeline": "t.json"}, platform="darwin", wait=0.2)
    assert (result["jianying"]["registered"], result["problem"]) == (False, why)
    assert "不要说草稿已经好了" in result["note"]


def test_a_draft_jianying_missed_is_shown_to_it_again_once(writing, monkeypatch):
    """剪映 11.7.0 now and then misses a new folder (2 of 18 in a row); moving it out and in again fixed both."""
    shown: list[Path] = []
    monkeypatch.setattr(jianying_install, "registration", lambda folder: (
        {"timeline_exists": True, "duration_us": 9_000_000} if shown else None))
    monkeypatch.setattr(jianying_build, "announce_again", shown.append)
    monkeypatch.setattr(jianying_draft, "ANNOUNCE_AGAIN_SECONDS", 0.05)
    result = jianying_draft._taken_in(writing, True, wait=2)
    assert result == (True, None)
    assert shown == [writing]


def test_a_draft_listed_at_once_is_not_moved(writing, monkeypatch):
    monkeypatch.setattr(jianying_install, "running", lambda *a: True)
    _listed(monkeypatch, writing)
    monkeypatch.setattr(jianying_build, "announce_again", lambda folder: pytest.fail("moved a listed draft"))
    assert jianying_draft._taken_in(writing, True, wait=2) == (True, None)


def test_with_jianying_closed_the_draft_waits_for_its_next_start(writing, monkeypatch):
    monkeypatch.setattr(jianying_install, "running", lambda *a: False)
    monkeypatch.setattr(jianying_install, "registration", lambda folder: pytest.fail("polled a closed 剪映"))
    result = jianying_draft.write_draft({"timeline": "t.json"}, platform="darwin")
    assert result["jianying"]["registered"] is None
    assert result["problem"] is None
    assert result["note"].endswith(jianying_draft.CLOSED_NOTE)


def test_no_jianying_and_a_bad_timeline_are_errors_the_agent_can_say(switch, monkeypatch, tmp_path):
    monkeypatch.setattr(jianying_install, "find", lambda *a, **k: None)
    assert json.loads(jianying_draft.handle({"timeline": "x"})) == {"error": jianying_draft.NOT_HERE}

    monkeypatch.setattr(jianying_install, "find", lambda *a, **k: _installation(tmp_path))
    out = json.loads(jianying_draft.handle({"timeline": str(tmp_path / "missing.json")}))
    assert out["error"].startswith("读不了时间轴")


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    assert "jianying_draft" in run_plugin_register_with_stubbed_seams("_jianying_draft_plugin_under_test")


def test_the_parameters_are_the_ones_short_video_studio_names():
    """apex-nodes tests/test_hc1219_jianying_draft_skill.py pins the same set from the skill's side."""
    assert set(jianying_draft.SCHEMA["parameters"]["properties"]) == {
        "timeline", "name", "subtitles", "subtitle_position", "narration", "music", "music_volume", "dissolve_after"}
    assert jianying_draft.SCHEMA["parameters"]["required"] == ["timeline"]
