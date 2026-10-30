"""A local stand-in for ChatCut's hosted service: OAuth 2.0 with dynamic registration and PKCE, plus MCP.

Nothing here reaches the real service. It answers the way the hosted endpoint does where the seam depends on
it: a 401 pointing at resource metadata without a token, a public client, a rotating refresh token, more tools
than the allowlist admits, and ``import_media`` reading the loopback URL it is handed, as the editor does.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

# Offered by the service but outside the allowlist: nothing may register them.
PAID_TOOLS = ("submit_video", "submit_image", "submit_voice", "show_preview", "report_user_friction")
OFFERED_TOOLS = ("read_script", "apply_script", "submit_export", "get_editor_url", "import_media", *PAID_TOOLS)
EDITOR_URL = "https://editor.invalid/editor/p-1?editor-boot-token=SECRET&chatcutLaunchClient=unknown&theme=dark"


class FakeService(ThreadingHTTPServer):
    def __init__(self):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.origin = f"http://127.0.0.1:{self.server_port}"
        self.mcp_url = f"{self.origin}/mcp"
        self.clients: dict[str, dict] = {}
        self.codes: dict[str, dict] = {}
        self.tokens: set[str] = set()
        self.refresh_tokens: set[str] = set()
        self.mcp_headers: list[dict] = []
        self.calls: list[tuple[str, dict]] = []
        self.fetched: dict[str, bytes] = {}
        # Set False for "no signed-in browser has the editor open".
        self.browser_connected = True
        self.import_attempts = 0
        self._thread = threading.Thread(target=self.serve_forever, daemon=True)

    def start(self) -> FakeService:
        self._thread.start()
        return self

    def stop(self) -> None:
        self.shutdown()
        self.server_close()
        self._thread.join(5)

    @property
    def tool_calls(self) -> list[str]:
        return [name for name, _ in self.calls]


class _Handler(BaseHTTPRequestHandler):
    server: FakeService

    def log_message(self, format, *args):
        return

    def _reply(self, status, payload=None, headers=None):
        body = json.dumps(payload).encode() if payload is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parts = urlsplit(self.path)
        origin = self.server.origin
        if parts.path.startswith("/.well-known/oauth-protected-resource"):
            return self._reply(200, {"resource": self.server.mcp_url, "authorization_servers": [origin],
                                     "scopes_supported": ["openid", "offline_access"]})
        if parts.path.startswith("/.well-known/oauth-authorization-server"):
            return self._reply(200, {
                "issuer": origin, "authorization_endpoint": f"{origin}/authorize", "token_endpoint": f"{origin}/token",
                "registration_endpoint": f"{origin}/register", "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "token_endpoint_auth_methods_supported": ["none"], "code_challenge_methods_supported": ["S256"],
                "scopes_supported": ["openid", "offline_access"]})
        if parts.path == "/authorize":
            query = {key: value[0] for key, value in parse_qs(parts.query).items()}
            client = self.server.clients.get(query.get("client_id"))
            if not client or query.get("redirect_uri") not in client["redirect_uris"]:
                return self._reply(400, {"error": "invalid_request"})
            code = secrets.token_urlsafe(24)
            self.server.codes[code] = query
            location = f"{query['redirect_uri']}?{urlencode({'code': code, 'state': query['state']})}"
            return self._reply(302, headers={"Location": location})
        return self._reply(405 if parts.path == "/mcp" else 404)

    def do_DELETE(self):
        self._reply(200)

    def _token_response(self):
        access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.server.tokens.add(access)
        self.server.refresh_tokens.add(refresh)
        return self._reply(200, {"access_token": access, "token_type": "Bearer", "expires_in": 3600,
                                 "scope": "openid offline_access", "refresh_token": refresh})

    def do_POST(self):
        parts = urlsplit(self.path)
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if parts.path == "/register":
            client = json.loads(body)
            client["client_id"] = secrets.token_urlsafe(16)
            client["token_endpoint_auth_method"] = "none"
            self.server.clients[client["client_id"]] = client
            return self._reply(201, client)
        if parts.path == "/token":
            form = {key: value[0] for key, value in parse_qs(body.decode()).items()}
            if form.get("grant_type") == "refresh_token":
                if form.get("refresh_token") not in self.server.refresh_tokens:
                    return self._reply(400, {"error": "invalid_grant"})
                self.server.refresh_tokens.discard(form["refresh_token"])
                return self._token_response()
            auth = self.server.codes.pop(form.get("code"), None)
            challenge = base64.urlsafe_b64encode(
                hashlib.sha256(form.get("code_verifier", "").encode()).digest()).rstrip(b"=").decode()
            if not auth or challenge != auth["code_challenge"] or form.get("redirect_uri") != auth["redirect_uri"]:
                return self._reply(400, {"error": "invalid_grant"})
            return self._token_response()
        if parts.path != "/mcp":
            return self._reply(404)
        if self.headers.get("Authorization", "").removeprefix("Bearer ") not in self.server.tokens:
            return self._reply(401, {"error": "unauthorized"}, {
                "WWW-Authenticate": f'Bearer resource_metadata="{self.server.origin}/.well-known/oauth-protected-resource"'})
        self.server.mcp_headers.append({key.lower(): value for key, value in self.headers.items()})
        request = json.loads(body)
        if "id" not in request:
            return self._reply(202)
        return self._reply(200, {"jsonrpc": "2.0", "id": request["id"], **self._rpc(request)})

    def _rpc(self, request: dict) -> dict:
        method, params = request["method"], request.get("params") or {}
        if method == "initialize":
            return {"result": {"protocolVersion": params.get("protocolVersion", "2025-03-26"),
                               "capabilities": {"tools": {}}, "serverInfo": {"name": "fake-chatcut", "version": "1"}}}
        if method == "tools/list":
            schema = {"type": "object", "properties": {}}
            return {"result": {"tools": [{"name": name, "description": name, "inputSchema": schema}
                                         for name in OFFERED_TOOLS]}}
        if method == "ping":
            return {"result": {}}
        if method != "tools/call":
            return {"error": {"code": -32601, "message": "Method not found"}}
        name, arguments = params["name"], params.get("arguments") or {}
        self.server.calls.append((name, arguments))
        if name == "get_editor_url":
            return _text({"editorUrl": EDITOR_URL, "projectId": arguments.get("projectId")})
        if name == "import_media":
            return self._import(arguments)
        return _text({"ok": True})

    def _import(self, arguments: dict) -> dict:
        self.server.import_attempts += 1
        if not self.server.browser_connected:
            return {"result": {"isError": True, "content": [{"type": "text", "text": "No connected browser."}]}}
        results = []
        for entry in arguments.get("files") or []:
            with urllib.request.urlopen(entry["url"], timeout=10) as response:
                self.server.fetched[entry["filename"]] = response.read()
            results.append({"assetId": entry["assetId"], "filename": entry["filename"], "ok": True,
                            "status": "locally_imported"})
        return _text({"results": results, "succeeded": len(results), "failed": 0})


def _text(payload: dict) -> dict:
    return {"result": {"content": [{"type": "text", "text": json.dumps(payload)}], "isError": False}}
