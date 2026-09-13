"""hc-735: Desktop social-media downloads survive real HTTP truncation safely."""

from __future__ import annotations

import importlib.util
import socket
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

from plugins import apexnodes_gateway as gateway


PAYLOAD = (b"apex-media-recovery-" * 65536) + b"done"
# httpx/httpcore may buffer a small first read before surfacing the premature EOF.
# Use an incident-shaped few-hundred-KB prefix so bytes have reached disk first.
TRUNCATE_AT = 256 * 1024


class _MediaHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    counts: dict[str, int] = {}
    referers: dict[str, list[str]] = {}

    def log_message(self, _format, *_args):
        return

    def _count(self) -> int:
        self.referers.setdefault(self.path, []).append(self.headers.get("Referer") or "")
        count = self.counts.get(self.path, 0) + 1
        self.counts[self.path] = count
        return count

    def _truncate(self) -> None:
        self.send_response(200)
        self.send_header("Content-Length", str(len(PAYLOAD)))
        self.end_headers()
        self.wfile.write(PAYLOAD[:TRUNCATE_AT])
        self.wfile.flush()
        self.close_connection = True
        self.connection.shutdown(socket.SHUT_RDWR)

    def _complete(
        self, *, status: int = 200, start: int = 0, content_type: str | None = None
    ) -> None:
        body = PAYLOAD[start:]
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        if content_type:
            self.send_header("Content-Type", content_type)
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{len(PAYLOAD) - 1}/{len(PAYLOAD)}")
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass  # protocol-validation tests may reject headers before reading the body
        self.close_connection = True

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        count = self._count()
        range_header = self.headers.get("Range")
        if self.path in {"/primary", "/fallback-broken"}:
            self.send_response(503)
            self.send_header("Content-Length", "0")
            self.end_headers()
            self.close_connection = True
            return
        if self.path == "/complete":
            self._complete()
            return
        if self.path == "/image-without-extension":
            self._complete(content_type="image/png")
            return
        if self.path == "/resume":
            if count == 1:
                self._truncate()
            else:
                assert range_header and range_header.startswith("bytes=")
                requested = int(range_header.removeprefix("bytes=").removesuffix("-"))
                assert 0 < requested <= TRUNCATE_AT
                self._complete(status=206, start=requested)
            return
        if self.path == "/ignore-range":
            if count == 1:
                self._truncate()
            else:
                assert range_header and range_header.startswith("bytes=")
                self._complete()  # Range ignored: downloader must overwrite, not append.
            return
        if self.path == "/bad-range":
            if count == 1:
                self._truncate()
            else:
                assert range_header and range_header.startswith("bytes=")
                requested = int(range_header.removeprefix("bytes=").removesuffix("-"))
                wrong_start = requested + 1
                # Body bytes happen to be correct, but the header claims a shifted
                # object/range. A downloader that trusts bytes alone would accept it.
                body = PAYLOAD[requested:]
                self.send_response(206)
                self.send_header("Content-Length", str(len(body)))
                self.send_header(
                    "Content-Range",
                    f"bytes {wrong_start}-{len(PAYLOAD)}/{len(PAYLOAD) + 1}",
                )
                self.end_headers()
                try:
                    self.wfile.write(body)
                except OSError:
                    pass  # client must reject the bad header before consuming the body
            return
        if self.path == "/unexpected-partial":
            self._complete(status=206, start=TRUNCATE_AT)
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()
        self.close_connection = True


@pytest.fixture
def media_server(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    _MediaHandler.counts = {}
    _MediaHandler.referers = {}
    server = ThreadingHTTPServer(("127.0.0.1", 0), _MediaHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        yield base, _MediaHandler.counts, _MediaHandler.referers
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _load_douyin_plugin():
    module_name = "hc735_plugins.apexnodes_douyin_tools"
    namespace = types.ModuleType("hc735_plugins")
    namespace.__path__ = []  # type: ignore[attr-defined]
    sys.modules["hc735_plugins"] = namespace
    plugin_dir = Path(__file__).resolve().parents[2] / "plugins" / "apexnodes-douyin-tools"
    spec = importlib.util.spec_from_file_location(
        module_name,
        plugin_dir / "__init__.py",
        submodule_search_locations=[str(plugin_dir)],
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def test_download_media_resumes_a_truncated_response(media_server, tmp_path):
    base, counts, _referers = media_server
    try:
        path = gateway.download_media(f"{base}/resume", dest_dir=tmp_path)
    except gateway.GatewayError as exc:
        pytest.fail(f"unexpected recovery failure: {exc.code}; requests={counts}")
    assert path.read_bytes() == PAYLOAD
    assert counts["/resume"] == 2
    assert not list(tmp_path.glob("*.part"))


def test_download_media_restarts_when_server_ignores_range(media_server, tmp_path):
    base, counts, _referers = media_server
    path = gateway.download_media(f"{base}/ignore-range", dest_dir=tmp_path)
    assert path.read_bytes() == PAYLOAD
    assert path.stat().st_size == len(PAYLOAD)  # no duplicated prefix
    assert counts["/ignore-range"] == 2


def test_shared_downloader_keeps_content_type_extension_for_other_consumers(
    media_server, tmp_path
):
    base, _counts, _referers = media_server
    path = gateway.download_media(f"{base}/image-without-extension", dest_dir=tmp_path)
    assert path.suffix == ".png"
    assert path.read_bytes() == PAYLOAD


def test_invalid_content_range_never_becomes_a_final_file(media_server, tmp_path):
    base, _counts, _referers = media_server
    with pytest.raises(gateway.GatewayError) as caught:
        gateway.download_media(f"{base}/bad-range", dest_dir=tmp_path)
    assert caught.value.code == "media_download_incomplete"


def test_unrequested_partial_response_never_becomes_a_final_file(media_server, tmp_path):
    base, counts, _referers = media_server
    with pytest.raises(gateway.GatewayError) as caught:
        gateway.download_media(f"{base}/unexpected-partial", dest_dir=tmp_path)
    assert caught.value.code == "media_download_incomplete"
    assert counts["/unexpected-partial"] == 3
    assert not list(tmp_path.glob("media*"))
    assert not list(tmp_path.glob("*.part"))


def test_main_then_fallback_then_one_refresh_uses_real_downloads(
    media_server, tmp_path, monkeypatch
):
    base, counts, referers = media_server
    module = _load_douyin_plugin()
    monkeypatch.setattr(gateway, "media_cache_dir", lambda: tmp_path)
    refreshes = []

    def refresh(source_url):
        refreshes.append(source_url)
        return {"download_url": f"{base}/complete", "title": "fresh"}, f"{base}/complete"

    monkeypatch.setattr(module, "_gateway_resolve_download", refresh)
    result, path = module._gateway_download_resolved_media(
        "https://share.invalid/item",
        {
            "download_url": f"{base}/primary",
            "fallback_urls": [f"{base}/fallback-broken"],
            "download_headers": {"Referer": "https://referer.invalid/"},
        },
        f"{base}/primary",
    )
    assert path.read_bytes() == PAYLOAD
    assert result["title"] == "fresh"
    assert refreshes == ["https://share.invalid/item"]
    assert counts["/primary"] == gateway._MEDIA_DOWNLOAD_ATTEMPTS
    assert counts["/fallback-broken"] == gateway._MEDIA_DOWNLOAD_ATTEMPTS
    assert counts["/complete"] == 1
    assert set(referers["/primary"]) == {"https://referer.invalid/"}
    assert set(referers["/fallback-broken"]) == {"https://referer.invalid/"}


def test_all_candidates_fail_after_exactly_one_refresh(media_server, tmp_path, monkeypatch):
    base, _counts, _referers = media_server
    module = _load_douyin_plugin()
    monkeypatch.setattr(gateway, "media_cache_dir", lambda: tmp_path)
    refreshes = []

    def refresh(source_url):
        refreshes.append(source_url)
        return {"download_url": f"{base}/fallback-broken"}, f"{base}/fallback-broken"

    monkeypatch.setattr(module, "_gateway_resolve_download", refresh)
    with pytest.raises(gateway.GatewayError) as caught:
        module._gateway_download_resolved_media(
            "https://share.invalid/item",
            {"download_url": f"{base}/primary"},
            f"{base}/primary",
        )
    assert caught.value.code == "media_download_exhausted"
    assert refreshes == ["https://share.invalid/item"]
    assert not list(tmp_path.glob("*.part"))


def test_both_social_tool_paths_use_the_recovery_orchestrator(monkeypatch):
    module = _load_douyin_plugin()
    source = "https://share.invalid/item"
    monkeypatch.setattr(
        module,
        "_gateway_resolve_download",
        lambda _source: ({"download_url": "https://cdn.invalid/item"}, "https://cdn.invalid/item"),
    )
    calls = []

    def fail_from_orchestrator(source_url, _result, _media_url):
        calls.append(source_url)
        raise gateway.GatewayError("recovery-orchestrator-marker")

    monkeypatch.setattr(module, "_gateway_download_resolved_media", fail_from_orchestrator)
    social = module._gateway_social_download(source)
    transcribe = module._gateway_media_transcribe(None, source)
    assert "recovery-orchestrator-marker" in social
    assert "recovery-orchestrator-marker" in transcribe
    assert calls == [source, source]


def test_transcribe_remote_fetch_fallback_uses_only_refreshed_url(monkeypatch):
    module = _load_douyin_plugin()
    source = "https://share.invalid/item"
    initial = "https://cdn.invalid/expired"
    refreshed = "https://cdn.invalid/refreshed"
    monkeypatch.setattr(
        module,
        "_gateway_resolve_download",
        lambda _source: ({"download_url": initial}, initial),
    )
    monkeypatch.setattr(
        module,
        "_gateway_download_resolved_media",
        lambda *_args: (_ for _ in ()).throw(
            module._ResolvedMediaDownloadError({"download_url": refreshed}, refreshed)
        ),
    )
    requests = []

    def request_json(method, path, payload, **_kwargs):
        requests.append((method, path, payload))
        return {"text": "fallback transcript"}

    monkeypatch.setattr(gateway, "request_json", request_json)
    result = module._gateway_media_transcribe(None, source)
    assert "fallback transcript" in result
    assert requests == [
        ("POST", "/tools/v1/asr/transcribe", {"media_url": refreshed})
    ]


def test_503_copy_distinguishes_download_resolution_from_asr():
    request = httpx.Request("POST", "https://gateway.invalid/test")
    response = httpx.Response(503, json={"detail": "temporary"}, request=request)
    download = gateway._error_from_response(
        response, path="/tools/v1/social/douyin/download"
    )
    asr = gateway._error_from_response(response, path="/tools/v1/asr/transcribe")
    assert "链接解析/下载服务" in str(download)
    assert "转写服务" not in str(download)
    assert "temporary" not in str(download)
    assert "转写服务" in str(asr)
    assert "链接解析" not in str(asr)
    assert "temporary" not in str(asr)
