"""hc-1122 ChatCut: where this assistant's ChatCut credential comes from. Nothing above this file knows.

``chatcut.py`` (the connect tool, the allowlist, disconnecting, the boot rule) and ``chatcut_import.py`` ask the
object ``current_account()`` returns, and nothing else about how the user got signed in:

* ``server_entry()``: how the ``mcp_servers`` entry signs in;
* ``has_credential()``: is there one in this assistant's home;
* ``connect(agent)``: get one, asking whatever must be asked. Returns ``{"status": ...}``;
* ``forget()``: remove it from this assistant's home;
* ``upload_question_key``: the upload card's wording, because it names whose credits are used.

**Today that is one implementation, the user's own ChatCut account over OAuth, and it is for development and
acceptance only: the switch stays off.** A credential issued per APEX user would be a second implementation, with no
change above this file. What must never exist here is one credential shared by every user: it would put different
people's footage in one account.
"""

from __future__ import annotations

import contextvars
import http.server
import logging
import threading
import time
import webbrowser
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlparse

from apex_overlay import chatcut

logger = logging.getLogger(__name__)

# The name a user sees on the authorization page. APEX's own: never another host's value.
CLIENT_NAME = "APEX Desktop"
# The whole browser step, which may include creating a ChatCut account.
AUTHORIZE_SECONDS = 900
# One tool call's wait. After it the flow keeps running and the tool says so.
WAIT_SECONDS = 300

WAITING_NOTE = "浏览器那边还没点完。告诉用户到浏览器里登录并同意授权，点完跟你说一声；到时再调用一次这个工具，不要重新发起。"
EXPIRED_NOTE = "授权页已经过期，用户点了也不会生效。告诉用户要重新连接时跟你说，再调用这个工具就会打开新的授权页。"
OPEN_LINK_NOTE = "浏览器没能自动打开：把 open_this_link 作为链接给用户，请他打开后登录并同意授权。"

_BROWSER_PAGE = (
    "<!doctype html><meta charset=utf-8><title>APEX</title>"
    "<body style='font-family:system-ui;margin:4rem auto;max-width:32rem;text-align:center'>"
    "<h2>授权完成</h2><p>可以关掉这个页面，回到 APEX。</p>"
    "<h2>Authorization received</h2><p>You can close this tab and return to APEX.</p>"
).encode()
_BROWSER_PAGE_REJECTED = (
    "<!doctype html><meta charset=utf-8><title>APEX</title>"
    "<body style='font-family:system-ui;margin:4rem auto;max-width:32rem;text-align:center'>"
    "<h2>这个授权页已经失效</h2><p>回到 APEX，让助手重新连接。</p>"
    "<h2>This authorization page is no longer valid</h2><p>Return to APEX and ask to connect again.</p>"
).encode()

_LOCK = threading.Lock()


class ChatcutAccount(Protocol):
    upload_question_key: str

    def server_entry(self) -> dict: ...

    def has_credential(self) -> bool: ...

    def connect(self, agent: Any) -> dict: ...

    def forget(self) -> None: ...


@dataclass
class _Attempt:
    """One browser authorization in flight. It outlives the tool call that started it."""

    session_id: str
    auth_url: str
    receiver: http.server.HTTPServer
    expires_at: float
    browser_opened: bool


# Hermes home -> the attempt in flight there.
_attempts: dict[str, _Attempt] = {}


def _start_receiver(session: dict) -> http.server.HTTPServer:
    """The loopback page the browser lands on: APEX's words, not the engine's. Hands the redirect to the flow."""
    from tools.mcp_oauth import _parse_redirect_query
    from tui_gateway.mcp_oauth_sessions import deliver_callback_flow

    class _Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path.rstrip("/") != "/callback":
                self.send_response(404)
                self.end_headers()
                return
            result = deliver_callback_flow(
                session.get("id", ""), chatcut.SERVER_NAME, **_parse_redirect_query(parsed.query))
            ok = bool(result.get("ok"))
            self.send_response(200 if ok else 400)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(_BROWSER_PAGE if ok else _BROWSER_PAGE_REJECTED)

        def log_message(self, format, *args):
            return

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    # In a copy of this context: a named profile's home is bound through a contextvar.
    threading.Thread(target=contextvars.copy_context().run, args=(server.serve_forever,),
                     daemon=True, name="apex-chatcut-oauth").start()
    return server


def _start_attempt(key: str) -> _Attempt:
    from tui_gateway.mcp_oauth_sessions import start_flow

    session: dict = {}
    receiver = _start_receiver(session)
    try:
        started = start_flow(key, chatcut.SERVER_NAME, chatcut.server_config(),
                             client_redirect_uri=f"http://127.0.0.1:{receiver.server_address[1]}/callback")
    except Exception:
        receiver.shutdown()
        receiver.server_close()
        raise
    session["id"] = started["session_id"]
    try:
        opened = bool(webbrowser.open(started["auth_url"]))
    except Exception:
        logger.warning("apex-overlay: could not open the browser for ChatCut", exc_info=True)
        opened = False
    return _Attempt(started["session_id"], started["auth_url"], receiver,
                    time.monotonic() + AUTHORIZE_SECONDS, opened)


def _end_attempt(key: str, *, cancel: bool = False) -> None:
    from tui_gateway.mcp_oauth_sessions import cancel_flow

    with _LOCK:
        attempt = _attempts.pop(key, None)
    if attempt is None:
        return
    if cancel:
        cancel_flow(attempt.session_id, chatcut.SERVER_NAME, key)
    attempt.receiver.shutdown()
    attempt.receiver.server_close()


def _wait_for_browser(key: str, attempt: _Attempt) -> dict:
    from tools.interrupt import is_interrupted
    from tui_gateway.mcp_oauth_sessions import poll_flow

    until = min(time.monotonic() + WAIT_SECONDS, attempt.expires_at)
    extra = {} if attempt.browser_opened else {"open_this_link": attempt.auth_url, "open_link_note": OPEN_LINK_NOTE}
    while True:
        state = poll_flow(attempt.session_id, chatcut.SERVER_NAME)
        if state["status"] == "approved":
            _end_attempt(key)
            return {"status": "connected"}
        if state["status"] == "error":
            _end_attempt(key)
            return {"status": "failed", "note": chatcut.FAILED_NOTE, "detail": str(state.get("error_message") or "")}
        # The SDK retries after its wait runs out and mints a new state: the page the user holds is dead by then.
        if state.get("auth_url") != attempt.auth_url or time.monotonic() >= attempt.expires_at:
            _end_attempt(key, cancel=True)
            return {"status": "expired", "note": EXPIRED_NOTE}
        if time.monotonic() >= until or is_interrupted():
            return {"status": "waiting", "note": WAITING_NOTE, **extra}
        time.sleep(0.5)


class UserOAuthAccount:
    """The user's own ChatCut account: dynamic registration, PKCE, and the user signing in in their browser."""

    upload_question_key = "upload_question"

    def server_entry(self) -> dict:
        return {"auth": "oauth", "oauth": {"client_name": CLIENT_NAME, "timeout": AUTHORIZE_SECONDS}}

    def has_credential(self) -> bool:
        from tools.mcp_oauth import HermesTokenStorage

        return HermesTokenStorage(chatcut.SERVER_NAME).has_cached_tokens()

    def connect(self, agent: Any) -> dict:
        key = str(chatcut.home())
        with _LOCK:
            attempt = _attempts.get(key)
        if attempt is None:
            yes = chatcut.copy("connect_yes")
            answer = chatcut.ask_on_card(agent, chatcut.copy("connect_question"), yes, chatcut.copy("connect_no"))
            if getattr(agent, "clarify_callback", None) is None:
                return {"error": chatcut.NEEDS_CARD}
            if answer != yes:
                return {"status": "declined", "note": chatcut.DECLINED_NOTE, "user_said": answer}
            try:
                attempt = _start_attempt(key)
            except Exception as exc:
                logger.warning("apex-overlay: could not start the ChatCut authorization", exc_info=True)
                return {"status": "failed", "note": chatcut.FAILED_NOTE, "detail": str(exc) or type(exc).__name__}
            with _LOCK:
                _attempts[key] = attempt
        return _wait_for_browser(key, attempt)

    def forget(self) -> None:
        from tools.mcp_oauth_manager import get_manager

        _end_attempt(str(chatcut.home()), cancel=True)
        get_manager().remove(chatcut.SERVER_NAME, hermes_home=str(chatcut.home()))


_current: ChatcutAccount = UserOAuthAccount()


def current_account() -> ChatcutAccount:
    return _current


def use_account(account: ChatcutAccount) -> ChatcutAccount:
    """Swap the source (a test today, an issued credential later); returns the previous one."""
    global _current
    previous, _current = _current, account
    return previous
