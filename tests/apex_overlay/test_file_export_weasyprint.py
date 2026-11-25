"""hc-1280: the WeasyPrint that [file-export] locks writes PDFs, obeys a refusing URL fetcher, and keeps EPS from Ghostscript.

The cloud image installs [file-export] through [all]. apex-nodes' cloud plugin
``apexnodes-pdf-file-write`` renders markdown with this WeasyPrint and passes a
``URLFetcher`` subclass that refuses every URL. WeasyPrint 62.3 had two high
advisories: an HTTP redirect slipped past a fetcher's checks (GHSA-983w-rhvv-gwmv),
and EPS images reached Ghostscript (GHSA-r543-q48m-4c9j). 70.0 fixes both. It
needs pydyf >= 0.11, and 62.3 broke on pydyf 0.12+, which is why pydyf used to
be pinned. It also parses with tinyhtml5 instead of html5lib.

The tests need Pango and Cairo. Linux CI has them through the runner's browser
packages. Where they are missing, the tests skip.
"""

from __future__ import annotations

import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

import pytest

PAGE_OBJECT = re.compile(rb"/Type /Page\b")
IMAGE_OBJECT = re.compile(rb"/Subtype /Image\b")


def _weasyprint():
    try:
        import weasyprint
    except (ImportError, OSError) as exc:  # no Pango/Cairo on this machine
        pytest.skip(f"WeasyPrint cannot load its system libraries here: {exc}")
    return weasyprint


def test_the_locked_pydyf_writes_what_weasyprint_renders():
    weasyprint = _weasyprint()
    page = (
        "<h1>报价单 hc-1280</h1>"
        "<table><tr><th>条款</th><th>金额</th></tr><tr><td>付款</td><td>370 万元</td></tr></table>"
        + "<p>第一节 正文段落 body paragraph</p>" * 80
    )

    pdf = weasyprint.HTML(string=page).write_pdf(uncompressed_pdf=True)

    assert pdf.startswith(b"%PDF-")
    assert pdf.rstrip().endswith(b"%%EOF")
    assert len(PAGE_OBJECT.findall(pdf)) >= 2


class _ProbeServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, png: bytes):
        self.hits: list[str] = []
        self.png = png
        super().__init__(("127.0.0.1", 0), _ProbeHandler)


class _ProbeHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.hits.append(self.path)
        if self.path.endswith(".css"):
            body, kind = b"p { color: #c00; }", "text/css"
        else:
            body, kind = self.server.png, "image/png"
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def test_a_refusing_url_fetcher_keeps_every_resource_out_and_the_render_alive(tmp_path, monkeypatch):
    weasyprint = _weasyprint()
    from PIL import Image
    from weasyprint.urls import URLFetcher

    for name in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    buffer = BytesIO()
    Image.new("RGB", (8, 8), (200, 30, 30)).save(buffer, format="PNG")
    local_png = tmp_path / "local.png"
    local_png.write_bytes(buffer.getvalue())
    server = _ProbeServer(buffer.getvalue())
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    css, png, local = f"{base}/probe.css", f"{base}/probe.png", local_png.as_uri()
    page = (
        f"<link rel='stylesheet' href='{css}'><p>hc-1280 probe paragraph</p>"
        f"<img src='{png}'><img src='{local}'>"
    )
    asked: list[str] = []

    class RefuseEveryUrl(URLFetcher):
        def fetch(self, url, headers=None):
            asked.append(url)
            raise ValueError(f"refused: {url}")

    try:
        # Control: the default fetcher reaches the server and reads the local file.
        control = weasyprint.HTML(string=page, url_fetcher=URLFetcher()).write_pdf(uncompressed_pdf=True)
        assert {"hits": sorted(server.hits), "images": len(IMAGE_OBJECT.findall(control))} == {
            "hits": ["/probe.css", "/probe.png"],
            "images": 2,
        }

        server.hits.clear()
        pdf = weasyprint.HTML(string=page, url_fetcher=RefuseEveryUrl()).write_pdf(uncompressed_pdf=True)
    finally:
        server.shutdown()
        server.server_close()

    outcome = {
        "asked": sorted(set(asked)),
        "hits": server.hits,
        "images": len(IMAGE_OBJECT.findall(pdf)),
        "pages": len(PAGE_OBJECT.findall(pdf)),
    }
    assert outcome == {"asked": sorted({css, png, local}), "hits": [], "images": 0, "pages": 1}


def test_importing_weasyprint_turns_ghostscript_off_for_eps_images():
    _weasyprint()
    from PIL import EpsImagePlugin

    assert EpsImagePlugin.gs_binary is False
