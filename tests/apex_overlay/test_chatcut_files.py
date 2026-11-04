"""hc-1122 ChatCut file tools: the user's footage in and finished exports out, both through the Scheduler.

A local fake stands in for apex-nodes' ``/api/v1/chatcut/uploads`` and ``/api/v1/chatcut/exports/<id>``; nothing
here touches ChatCut. Pinned:

1. The first upload is asked on a card; a no sends nothing, a yes is kept, and the next sign-in asks again.
2. Only media files, by absolute path, under the size limit; each one goes to the Scheduler with the APEX key and
   nothing else, and the answer names asset ids only.
3. A finished export is saved into Downloads whole or not at all, never over another file.
4. With the switch off or signed out, neither tool does anything.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from apex_overlay import chatcut, chatcut_files

APEX_KEY = "apex-agent-key-SECRET"
PROJECT = "219bbfaf-c0ea-43d3-9055-101630f26b34"
RENDER = "f585d36c-66e1-4a3f-940e-f714c56fa318"
EXPORT = b"\x00\x00\x00 ftypisom" + b"y" * 3000


class FakeScheduler:
    """The two Scheduler routes, recording what arrives."""

    def __init__(self):
        self.uploads: list[dict] = []
        self.exports: list[dict] = []
        self.upload_status = 200
        self.export_status = 200
        self.export_body = EXPORT
        self.declared_size: str | None = str(len(EXPORT))
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def _json(self, status, body):
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_POST(self):
                url = urlparse(self.path)
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                fake.uploads.append({"path": url.path, "query": parse_qs(url.query), "headers": dict(self.headers),
                                     "body": body})
                if fake.upload_status != 200:
                    self._json(fake.upload_status, {"error": {"code": "x", "message": "ChatCut 没收下这个文件。"}})
                    return
                self._json(200, {"assetId": f"asset-{len(fake.uploads)}", "byteReady": True, "filename": "x"})

            def do_GET(self):
                url = urlparse(self.path)
                fake.exports.append({"path": url.path, "query": parse_qs(url.query), "headers": dict(self.headers)})
                if fake.export_status != 200:
                    self._json(fake.export_status, {"error": {"code": "x", "message": "这个导出还没完成"}})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Disposition", "attachment; filename*=UTF-8''%E6%88%90%E7%89%87.mp4")
                if fake.declared_size:
                    self.send_header("X-ChatCut-Size", fake.declared_size)
                self.end_headers()
                self.wfile.write(fake.export_body)

            def log_message(self, format, *args):
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class Agent:
    """Just enough of an agent for the card: answers with ``answer``, or has no card at all."""

    def __init__(self, answer=None, *, card=True):
        self.answer, self.asked = answer, []
        if card:
            self.clarify_callback = self._clarify

    def _clarify(self, questions):
        self.asked.append(questions[0]["question"])
        if self.answer is None:
            return {"answers": {}, "outcome": "timeout"}
        return {"answers": {questions[0]["qid"]: self.answer}, "outcome": "submitted"}


@pytest.fixture
def scheduler(tmp_path, monkeypatch):
    home = tmp_path / "apexnodes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    # The fake listens on loopback; no proxy may stand in between. With no proxy variable at all (the hermetic
    # runner), httpx falls back to the system's proxy settings, which on macOS do not exempt loopback.
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    monkeypatch.setattr(chatcut_files, "_downloads", lambda: tmp_path / "user" / "Downloads")
    fake = FakeScheduler()
    monkeypatch.setenv(chatcut.SWITCH_ENV, "1")
    monkeypatch.setenv(chatcut.KEY_ENV, APEX_KEY)
    monkeypatch.setenv(chatcut.BASE_ENV, fake.base)
    monkeypatch.setattr(chatcut_files, "copy", lambda key: chatcut_files._COPY["zh"][key])
    yield fake
    fake.stop()


def media(tmp_path: Path, name="口播.mp4", body=b"a talking-head take") -> str:
    path = tmp_path / name
    path.write_bytes(body)
    return str(path)


def upload(agent, paths, project=PROJECT) -> dict:
    return json.loads(chatcut_files.upload_files(agent, {"project_id": project, "paths": paths}, None))


def save(render=RENDER, project=PROJECT) -> dict:
    return json.loads(chatcut_files.save_export({"project_id": project, "render_id": render}))


# ---------------------------------------------------------------------------
# 1. Asked before the first upload
# ---------------------------------------------------------------------------


def test_the_first_upload_is_asked_and_a_yes_is_kept(scheduler, tmp_path):
    agent = Agent("同意上传")

    first = upload(agent, [media(tmp_path)])
    second = upload(agent, [media(tmp_path, "b.mov")])

    assert first["status"] == second["status"] == "uploaded"
    assert len(agent.asked) == 1
    question = agent.asked[0]
    for words in ("「口播.mp4」", "APEX 的服务器", "ChatCut 在美国的服务器", "APEX 使用的 ChatCut 账号", "不花你的额度"):
        assert words in question


@pytest.mark.parametrize("answer", ["先不传", None])
def test_without_a_yes_nothing_leaves_this_computer(scheduler, tmp_path, answer):
    result = upload(Agent(answer), [media(tmp_path)])

    assert result["status"] == "declined"
    assert scheduler.uploads == []
    assert not chatcut_files.has_consent()


def test_with_no_card_nothing_is_uploaded(scheduler, tmp_path):
    result = upload(Agent(card=False), [media(tmp_path)])

    assert result["error"] == chatcut_files.NO_CARD
    assert scheduler.uploads == []


def test_signing_out_takes_the_consent_back(scheduler, tmp_path, monkeypatch):
    upload(Agent("同意上传"), [media(tmp_path)])
    assert chatcut_files.has_consent()

    monkeypatch.delenv(chatcut.KEY_ENV)
    chatcut.reconcile_at_boot()

    assert not chatcut_files.has_consent()


def test_the_switch_going_off_takes_the_consent_back(scheduler, tmp_path, monkeypatch):
    upload(Agent("同意上传"), [media(tmp_path)])

    monkeypatch.delenv(chatcut.SWITCH_ENV)
    chatcut.reconcile_at_boot()

    assert not chatcut_files.has_consent()


# ---------------------------------------------------------------------------
# 2. What goes, and how
# ---------------------------------------------------------------------------


def test_each_file_goes_to_the_scheduler_with_the_apex_key_only(scheduler, tmp_path):
    first, second = media(tmp_path, "a.mp4", b"first take"), media(tmp_path, "b.wav", b"voice")

    result = upload(Agent("同意上传"), [first, second])

    assert result == {"status": "uploaded", "note": chatcut_files.UPLOADED_NOTE,
                      "assets": [{"file": "a.mp4", "asset_id": "asset-1"}, {"file": "b.wav", "asset_id": "asset-2"}]}
    assert [u["path"] for u in scheduler.uploads] == [chatcut_files.UPLOADS_PATH] * 2
    assert [u["query"] for u in scheduler.uploads] == [{"projectId": [PROJECT], "filename": ["a.mp4"]},
                                                       {"projectId": [PROJECT], "filename": ["b.wav"]}]
    assert [u["body"] for u in scheduler.uploads] == [b"first take", b"voice"]
    for sent in scheduler.uploads:
        assert sent["headers"]["Authorization"] == f"Bearer {APEX_KEY}"
        assert sent["headers"]["Content-Length"] == str(len(sent["body"]))


def test_only_media_files_by_absolute_path_under_the_limit(scheduler, tmp_path, monkeypatch):
    monkeypatch.setattr(chatcut_files, "MAX_BYTES", 10)
    keys = tmp_path / "id_rsa"
    keys.write_text("-----BEGIN KEY-----")
    empty = media(tmp_path, "empty.mp4", b"")
    big = media(tmp_path, "big.mp4", b"x" * 11)
    ok = media(tmp_path, "ok.mp4", b"take")

    result = upload(Agent("同意上传"), [str(keys), "relative.mp4", str(tmp_path / "missing.mp4"), empty, big, ok])

    assert result["status"] == "partial"
    assert [a["file"] for a in result["assets"]] == ["ok.mp4"]
    assert [f["file"] for f in result["failed"]] == ["id_rsa", "relative.mp4", "missing.mp4", "empty.mp4", "big.mp4"]
    assert [u["body"] for u in scheduler.uploads] == [b"take"]


def test_a_refusal_from_the_scheduler_is_passed_on_in_its_words(scheduler, tmp_path):
    scheduler.upload_status = 502

    result = upload(Agent("同意上传"), [media(tmp_path)])

    assert result["status"] == "partial"
    assert result["failed"] == [{"file": "口播.mp4", "error": "ChatCut 没收下这个文件。"}]


@pytest.mark.parametrize(("args", "error"), [
    ({"project_id": "219bbfaf", "paths": ["/a.mp4"]}, chatcut_files.NEEDS_PROJECT),
    ({"project_id": PROJECT, "paths": []}, chatcut_files.NO_FILES),
    ({"project_id": PROJECT, "paths": ["/a.mp4"] * 9}, chatcut_files.NO_FILES),
])
def test_arguments_are_checked_before_anything_is_asked(scheduler, args, error):
    agent = Agent("同意上传")

    result = json.loads(chatcut_files.upload_files(agent, args, None))

    assert result["error"] == error
    assert agent.asked == [] and scheduler.uploads == []


# ---------------------------------------------------------------------------
# 3. Saving an export
# ---------------------------------------------------------------------------


def test_a_finished_export_is_saved_into_downloads(scheduler, tmp_path):
    result = save()

    saved = tmp_path / "user" / "Downloads" / "成片.mp4"
    assert result["status"] == "saved" and result["file"] == "成片.mp4" and result["bytes"] == len(EXPORT)
    assert saved.read_bytes() == EXPORT
    assert scheduler.exports == [{"path": f"{chatcut_files.EXPORTS_PATH}/{RENDER}", "query": {"projectId": [PROJECT]},
                                  "headers": scheduler.exports[0]["headers"]}]
    assert scheduler.exports[0]["headers"]["Authorization"] == f"Bearer {APEX_KEY}"


def test_an_existing_file_is_never_overwritten(scheduler, tmp_path):
    downloads = tmp_path / "user" / "Downloads"
    downloads.mkdir(parents=True)
    (downloads / "成片.mp4").write_bytes(b"the user's own file")

    result = save()

    assert result["file"] == "成片 (2).mp4"
    assert (downloads / "成片.mp4").read_bytes() == b"the user's own file"


def test_a_short_transfer_leaves_nothing_behind(scheduler, tmp_path):
    scheduler.export_body = EXPORT[:100]

    result = save()

    assert "error" in result
    downloads = tmp_path / "user" / "Downloads"
    assert list(downloads.iterdir()) == []


def test_an_export_that_is_not_ready_is_reported_in_the_schedulers_words(scheduler, tmp_path):
    scheduler.export_status = 409

    result = save()

    assert "这个导出还没完成" in result["error"]
    assert list((tmp_path / "user" / "Downloads").iterdir()) == []


@pytest.mark.parametrize("render", ["../../etc", "abc", ""])
def test_a_render_id_is_checked_before_anything_is_fetched(scheduler, render):
    assert save(render=render)["error"] == chatcut_files.NEEDS_RENDER
    assert scheduler.exports == []


# ---------------------------------------------------------------------------
# 4. Off or signed out
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("unset", [chatcut.SWITCH_ENV, chatcut.KEY_ENV, chatcut.BASE_ENV])
def test_off_or_signed_out_neither_tool_does_anything(scheduler, tmp_path, monkeypatch, unset):
    monkeypatch.delenv(unset)
    agent = Agent("同意上传")

    assert upload(agent, [media(tmp_path)])["error"] == chatcut_files.SIGNED_OUT
    assert save()["error"] == chatcut_files.SIGNED_OUT
    assert agent.asked == [] and scheduler.uploads == [] and scheduler.exports == []
