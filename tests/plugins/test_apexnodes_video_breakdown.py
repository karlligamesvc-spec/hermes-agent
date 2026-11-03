"""video_breakdown on APEX Desktop: the remake card of a local video (hc-1136).

``plugins/apexnodes-video-tools/breakdown.py`` is a byte-identical copy of apex-nodes'
hosted plugin (apex-nodes CI compares the bytes and runs its behaviour tests). Here, on the
fork's own plugin path:

* the tool registers with a budget the runtime accepts, and its labels request goes to the
  tools gateway's ``/tools/v1/video/shot-labels`` with the managed key;
* a gateway that refuses (no quota, offline) still leaves a card on disk: the labelled fields
  are 「不确定」 and the result says why, it never guesses;
* footage_motion.py is found where APEX Desktop installs platform skills
  (``HERMES_HOME/skills/apexnodes/short-video-studio/scripts/``);
* with a real ffmpeg (the bundled 9.x; skipped without one) a synthetic video's cuts come back.
"""

from __future__ import annotations

import base64
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO_ROOT / "plugins" / "apexnodes-video-tools"
GATEWAY_BASE = "https://gw.test"
GATEWAY_KEY = "desktop-key"
# A 1×1 JPEG.
JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAx"
    "NDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAI"
    "AQEAAD8AKp//2Q=="
)


def _load_plugin():
    if "hc1136_fork" not in sys.modules:
        namespace = types.ModuleType("hc1136_fork")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hc1136_fork"] = namespace
    name = "hc1136_fork.apexnodes_video_tools"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


plugin = _load_plugin()
breakdown = plugin._BREAKDOWN


class _Ctx:
    def __init__(self):
        self.tools: dict[str, dict] = {}

    def register_tool(self, **kwargs):
        from hermes_cli.plugins import PluginContext
        import inspect

        inspect.signature(PluginContext.register_tool).bind(None, **kwargs)
        self.tools[kwargs["name"]] = kwargs


def _labels(payload: dict) -> dict:
    return {
        "labels_from": "server",
        "ocr_from": "server",
        "model": "apex-flash",
        "shots": [
            {"n": s["n"], "shot_size": "近景", "subject": "人", "action": "说话", "scene": "厨房", "has_face": True,
             "beat": "钩子", "seen": "女人对着镜头说话", "uncertain": [], "text_overlays": []}
            for s in payload["shots"]
        ],
    }


@pytest.fixture
def desktop(monkeypatch, tmp_path):
    """The gateway leg as APEX Desktop runs it, with breakdown's ffmpeg steps standing still:
    a 6-second portrait video cut at 3.0 s."""
    import plugins.apexnodes_gateway as gateway

    monkeypatch.delenv("TOOLS_GATEWAY_DISABLED", raising=False)
    monkeypatch.setenv("TOOLS_GATEWAY_BASE", GATEWAY_BASE)
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", GATEWAY_KEY)
    video = tmp_path / "原片.mp4"
    video.write_bytes(b"not really a video")
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(breakdown, "tools", lambda: ("ffmpeg", "ffprobe"))
    monkeypatch.setattr(breakdown, "probe", lambda ffprobe, path: {"duration": 6.0, "width": 720, "height": 1280, "fps": 30.0})
    monkeypatch.setattr(breakdown, "scene_scores", lambda ffmpeg, path, seconds: [(3.0, 0.7)])
    monkeypatch.setattr(breakdown, "extract_frame", lambda ffmpeg, path, time, out, scale: out.write_bytes(JPEG))

    def sheet(ffmpeg, root, shots, out, portrait):
        out.write_bytes(JPEG)
        return True

    monkeypatch.setattr(breakdown, "contact_sheet", sheet)
    monkeypatch.setattr(breakdown, "load_motion", lambda: None)
    monkeypatch.setattr(breakdown, "work_dir", lambda: work)
    calls: list[dict] = []

    def request_json(method, path, payload=None, *, timeout=90, **_kwargs):
        calls.append({"method": method, "path": path, "payload": payload, "timeout": timeout})
        answer = calls_answer[0]
        if isinstance(answer, BaseException):
            raise answer
        return {"ok": True, "data": answer(payload)}

    calls_answer: list = [_labels]
    monkeypatch.setattr(gateway, "request_json", request_json)
    return types.SimpleNamespace(video=video, work=work, calls=calls, answer=calls_answer, gateway=gateway)


def test_registers_with_a_budget_the_runtime_accepts():
    ctx = _Ctx()
    plugin.register(ctx)
    entry = ctx.tools["video_breakdown"]
    assert entry["toolset"] == "skills" and entry["execution_timeout"] == 600
    assert entry["schema"]["parameters"]["required"] == ["video_path"]


def test_labels_go_to_the_gateway_and_the_card_lands(desktop):
    result = json.loads(plugin._handle_video_breakdown({"video_path": str(desktop.video), "title": "收纳"}))
    assert [(c["method"], c["path"], c["timeout"]) for c in desktop.calls] == [
        ("POST", "/tools/v1/video/shot-labels", plugin._SHOT_LABELS_TIMEOUT)
    ]
    sent = desktop.calls[0]["payload"]
    assert [s["n"] for s in sent["shots"]] == [1, 2] and all(len(s["frames"]) == 3 for s in sent["shots"])
    assert result["labels_from"] == "server" and result["shot_count"] == 2
    card = json.loads(Path(result["shots_path"]).read_text(encoding="utf-8"))
    assert Path(result["package_dir"]).parent == desktop.work
    assert all(s["shot_size"] == "近景" and s["evidence"]["shot_size"] == "看图" for s in card["shots"])


def test_a_refusing_gateway_still_leaves_an_honest_card(desktop):
    desktop.answer[0] = desktop.gateway.GatewayError("本月额度已用完", code="quota_exceeded")
    result = json.loads(plugin._handle_video_breakdown({"video_path": str(desktop.video)}))
    assert result["labels_from"] == "none" and "本月额度已用完" in result["note"]
    card = json.loads(Path(result["shots_path"]).read_text(encoding="utf-8"))
    assert all(s["shot_size"] == "不确定" and "shot_size" in s["uncertain"] for s in card["shots"])


def test_a_missing_file_is_said_plainly(desktop, tmp_path):
    result = json.loads(plugin._handle_video_breakdown({"video_path": str(tmp_path / "nope.mp4")}))
    assert result["error"].startswith("复刻卡没做成：找不到视频文件")
    assert desktop.calls == []


def test_footage_motion_is_found_where_desktop_installs_skills(monkeypatch, tmp_path):
    from hermes_constants import get_hermes_home

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    script = Path(get_hermes_home()) / "skills" / "apexnodes" / "short-video-studio" / "scripts" / "footage_motion.py"
    script.parent.mkdir(parents=True)
    script.write_text("FPS = 10\n", encoding="utf-8")
    assert breakdown.motion_script() == script
    assert breakdown.load_motion().FPS == 10


FFMPEG, FFPROBE = shutil.which("ffmpeg"), shutil.which("ffprobe")


@pytest.mark.skipif(not (FFMPEG and FFPROBE), reason="no ffmpeg / ffprobe here (APEX Desktop bundles 9.x)")
def test_a_synthetic_videos_cuts_come_back(monkeypatch, tmp_path):
    video = tmp_path / "two.mp4"
    subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x568:r=25:d=2", "-f", "lavfi", "-i",
         "color=c=0x3040C0:s=320x568:r=25:d=2", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[o]", "-map", "[o]",
         "-c:v", "mpeg4", "-q:v", "3", str(video)],
        check=True,
    )
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "empty-home"))
    result = breakdown.build(str(video), label_fn=_labels, out_root=tmp_path)
    card = json.loads(Path(result["shots_path"]).read_text(encoding="utf-8"))
    assert [s["start"] for s in card["shots"]] == [0.0, 2.0]
    # No platform skills on this machine: the camera is unsure and the note says why.
    assert card["shots"][0]["camera"] == "不确定" and card["analysis"]["motion_from"] == "none"
    from PIL import Image

    assert Image.open(io.BytesIO((Path(result["package_dir"]) / "复刻卡.jpg").read_bytes())).size == (480, 426)
