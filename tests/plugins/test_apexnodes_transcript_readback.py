"""hc-1189: when a transcript file cannot be opened, the text pasted back is that same
transcription, read back from disk, never rebuilt from chat memory.

liusession 10-08 (Desktop 0.17.52): the user transcribed two videos in a row; the second
one's .docx would not preview and the assistant pasted the first video's transcript
instead. ``media_transcribe`` now writes each transcription's verbatim text to
``<stem>.txt`` (``transcript_text_path``) next to the same call's ``<stem>.docx`` and
``<stem>.segments.json``. The douyin-video-transcript skill (served by hermes-cloud) tells
the assistant to read that file back, or, when the result has left the context, the sent
``.docx`` with its extension swapped to ``.txt``. These tests drive both legs with two fake
transcriptions (A, then B), let B be the file that would not open and follow that rule.
The cloud plugin has the same tests in hermes-cloud tests/test_hc1189_transcript_readback.py.

Only ``httpx.Client`` / ``urlopen`` are faked. The .docx checks read the document with
python-docx (CI installs it through the ``file-export`` extra) rather than the plugin's
own paragraph splitter.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

from tests.plugins.test_apexnodes_gateway_tools import (
    _VENDOR_AND_MASTER_ENV,
    GATEWAY_BASE,
    GATEWAY_KEY,
    FakeResponse,
    _gateway_module,
    _load_plugin,
    asr_job_done,
)

A_TITLE = "高三必看逆袭方法 高三考生如何正确看待模块？我们跟踪大量往届高三生"
A_TEXT = "咱们高三的家长和同学啊，刷到了先停一下。今天给大家讲一下咱们高三学生如何正确看待考试。所有模考都不是最终的定论。"
B_TITLE = "27高考报名早准备! 陕西27届高考生家长注意了！陕西高考报名通常从11月1号开始，这6 大关键事项"
B_TEXT = "陕西的高三家长注意了，国庆放假7天，那咱们高三家长可不能松懈。国庆假期结束后，咱们27年的高考报名工作即将全面启动。"


@pytest.fixture(autouse=True)
def documents(tmp_path, monkeypatch) -> Path:
    """A Desktop with WeChat connected (the .docx is rendered); runtime home in tmp."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    for name in _VENDOR_AND_MASTER_ENV:
        monkeypatch.delenv(name, raising=False)
    for marker in ("WEIXIN_TOKEN", "WECOM_BOT_ID", "DINGTALK_CLIENT_ID", "QQ_APP_ID"):
        monkeypatch.delenv(marker, raising=False)
    monkeypatch.setenv("WEIXIN_TOKEN", "wx-entry")
    monkeypatch.setenv("TOOLS_GATEWAY_BASE", GATEWAY_BASE)
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", GATEWAY_KEY)
    return home / "cache" / "documents"


@pytest.fixture
def douyin_mod():
    module = _load_plugin("apexnodes-douyin-tools")
    yield module
    sys.modules.pop(module.__name__, None)


@pytest.fixture
def gateway(monkeypatch, douyin_mod, tmp_path):
    """Gateway leg by share link: the link resolves to a title and a clip on this machine."""
    gateway_module = _gateway_module()
    responses: list[FakeResponse] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def request(self, method, url, **kwargs):
            return responses.pop(0)

    monkeypatch.setattr(gateway_module.httpx, "Client", FakeClient)
    monkeypatch.setattr(gateway_module.time, "sleep", lambda _s: None)
    monkeypatch.setattr(gateway_module, "extract_audio_for_asr", lambda _p, **_kw: None)

    def transcribe(text: str, title: str | None, video_name: str = "clip.mp4") -> dict:
        clip = tmp_path / video_name
        clip.write_bytes(b"A" * 8)
        meta = {"title": title} if title else {}
        monkeypatch.setattr(douyin_mod, "_gateway_resolve_download", lambda _url: (meta, "https://cdn.example/v.mp4"))
        monkeypatch.setattr(douyin_mod, "_gateway_download_resolved_media", lambda *_a: (meta, clip))
        responses.extend(asr_job_done({"ok": True, "text": text, "duration_seconds": 4.2}))
        args = {"url": "https://v.douyin.com/x/"} if title else {"video_path": str(clip)}
        return json.loads(douyin_mod._handle_media_transcribe(args))

    return transcribe


@pytest.fixture
def legacy(monkeypatch, douyin_mod):
    """``TOOLS_GATEWAY_DISABLED=1``: the master answers ``/media/transcribe``."""
    monkeypatch.setenv("TOOLS_GATEWAY_DISABLED", "1")
    monkeypatch.setenv("HERMES_PLATFORM_API_BASE", "http://master.test/api/v1")
    monkeypatch.setenv("API_SERVER_KEY", "legacy-key")

    def transcribe(text: str, title: str | None, video_name: str = "clip.mp4") -> dict:
        monkeypatch.setattr(douyin_mod, "_post", lambda *a, **k: {"ok": True, "transcript": text, "title": title})
        return json.loads(douyin_mod._handle_media_transcribe({"video_path": f"/data/media/{video_name}"}))

    return transcribe


def _paste_per_skill(sent_media_line: str, result_in_view: dict | None) -> str:
    """The skill's readback: the call's transcript_text_path while its result is in view,
    otherwise the sent .docx with its extension swapped to .txt."""
    if result_in_view is not None:
        return Path(result_in_view["transcript_text_path"]).read_text(encoding="utf-8")
    return Path(sent_media_line.removeprefix("MEDIA:")).with_suffix(".txt").read_text(encoding="utf-8")


def _squash(text: str) -> str:
    return re.sub(r"\s+", "", text)


@pytest.mark.parametrize("leg", ["gateway", "legacy"])
def test_b_would_not_open_and_the_paste_is_b(leg, request):
    transcribe = request.getfixturevalue(leg)
    a = transcribe(A_TEXT, A_TITLE, "a.mp4")
    b = transcribe(B_TEXT, B_TITLE, "b.mp4")

    pasted = _paste_per_skill("", b)
    assert _squash(pasted) == _squash(B_TEXT) and _squash(A_TEXT) not in _squash(pasted)
    assert Path(b["transcript_text_path"]).name.startswith("27高考报名早准备! 陕西27届")
    assert _squash(_paste_per_skill("", a)) == _squash(A_TEXT)  # A's own file is untouched
    if leg == "gateway":  # the local transcript file is that same readback file
        assert b["transcript_path"] == b["transcript_text_path"]


@pytest.mark.parametrize("leg", ["gateway", "legacy"])
def test_the_sent_docx_leads_back_to_its_own_text(leg, request):
    pytest.importorskip("docx")
    from docx import Document

    transcribe = request.getfixturevalue(leg)
    a = transcribe(A_TEXT, A_TITLE, "a.mp4")
    blob = "。".join(f"第{i}句话说得比较长一点，好让它分成好几段" for i in range(1, 13)) + "。"
    b = transcribe(blob, B_TITLE, "b.mp4")
    doc_path = Path(b["transcript_doc_path"])

    pasted = _paste_per_skill(b["transcript_doc_media_tag"], None)  # B's result left the context
    body = [p.text for p in Document(str(doc_path)).paragraphs if p.style.name != "Title"]
    assert len(body) > 1 and pasted.split("\n\n") == body
    assert _squash(_paste_per_skill(a["transcript_doc_media_tag"], None)) == _squash(A_TEXT)
    assert "transcript_text_path" in b["transcript_doc_instruction"]


@pytest.mark.parametrize("leg", ["gateway", "legacy"])
def test_untitled_local_videos_are_named_after_their_files(leg, request):
    transcribe = request.getfixturevalue(leg)
    a = transcribe(A_TEXT, None, "高三必看逆袭方法_高三考生如何正确看待模块_6ac836db.mp4")
    b = transcribe(B_TEXT, None, "27高考报名早准备_陕西27届高考生家长注意了_8a181ff7.mp4")

    assert Path(a["transcript_text_path"]).name.startswith("高三必看逆袭方法_高三考生如何正确看待模块_逐字稿_")
    assert Path(b["transcript_text_path"]).name.startswith("27高考报名早准备_陕西27届高考生家长注意了_逐字稿_")
    assert "6ac836db" not in Path(a["transcript_text_path"]).name
    assert not a.get("title") and not b.get("title")  # naming only; the platform metadata stays as given


def test_a_paragraph_without_full_stops_never_exceeds_a_readable_line(legacy):
    talk = "，".join(f"然后我们说到第{i}个要点" for i in range(400))  # one ASR blob, no 。
    lines = Path(legacy(talk, "长")["transcript_text_path"]).read_text(encoding="utf-8").splitlines()

    assert len(lines) > 1
    assert max(len(line) for line in lines) <= 1000  # read_file cuts lines over 2000 chars
    assert "".join(lines) == talk  # only line breaks were added, each after a pause


@pytest.mark.parametrize("leg", ["gateway", "legacy"])
def test_no_speech_writes_no_text_file(leg, request, documents):
    result = request.getfixturevalue(leg)("", "无人声")

    assert result["speech"] is False and "transcript_text_path" not in result
    assert not documents.exists() or not list(documents.glob("*.txt"))


@pytest.mark.parametrize("leg", ["gateway", "legacy"])
def test_an_unwritable_cache_keeps_the_transcript(leg, request, douyin_mod, monkeypatch):
    transcribe = request.getfixturevalue(leg)

    def no_cache_dir():
        raise PermissionError("read-only")

    monkeypatch.setattr(douyin_mod, "_document_cache_dir", no_cache_dir)
    result = transcribe(B_TEXT, B_TITLE)

    assert result["ok"] is True and result["transcript"] == B_TEXT
    assert "transcript_text_path" not in result
