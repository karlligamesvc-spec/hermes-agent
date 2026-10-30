"""hc-1122 ChatCut: edit footage the user already shot, with the user's own ChatCut account.

ChatCut is a third-party conversational video editor with a hosted MCP server (OAuth 2.0, dynamic client
registration, PKCE). APEX's own media tools generate clips; they do not cut a talking-head take, remove
flubs or caption it. This seam makes ChatCut reachable without the user ever seeing MCP:

* ``chatcut_connect`` asks on a choice card, opens the browser for the user's own sign-in and consent, and
  brings the tools up for the turn it runs in. A new session needs nothing: the server is in this assistant's
  config from then on.
* ``chatcut_import_files`` (apex_overlay/chatcut_import.py) is the only way a local file reaches ChatCut. Their
  ``import_media`` tool is left out of the allowlist below on purpose, so "ask before the first upload" is
  enforced here and not left to the model.
* A prompt section says when to reach for it, and that its generation tools are not in use.

The allowlist also keeps ChatCut's paid generation tools (``submit_video`` and friends) away from the model:
the user's credits are not spent from here. A tool ChatCut adds later stays out until it is listed.

**One connection per assistant.** The tokens live in that assistant's Hermes home, and ChatCut rotates the
refresh token on every use, so two assistants could not share a copy anyway. A second assistant connects on
its own, one click once the browser is signed in. Main's ``apexConfigHomes()`` does not come into it: nothing
here is synced to other profiles.

**Off means nothing.** Desktop's main process settles ``desktop_features.chatcut`` into
``APEX_CHATCUT_ACTIVE=1`` before the engine spawns. Without it (the switch off, every cloud container) no tool,
no section and no patch is added; a connection left from before the switch went off is removed at boot, so a
rollback really takes the tools away. With nothing left over that path only reads config.yaml.
"""

from __future__ import annotations

import contextvars
import http.server
import json
import logging
import os
import threading
import time
import uuid
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional
from urllib.parse import urlparse

from apex_overlay import post_import

logger = logging.getLogger(__name__)

SWITCH_ENV = "APEX_CHATCUT_ACTIVE"
SERVER_NAME = "chatcut"
MCP_URL = "https://api.chatcut.io/api/external-mcp/mcp"
# A loopback-only override, so a local test server can stand in for the service and nothing else can.
TEST_URL_ENV = "APEX_CHATCUT_TEST_MCP_URL"

# APEX's own names: never another host's value. ChatCut reads an unknown client as `unknown`.
CLIENT_NAME = "APEX Desktop"
CLIENT_ID = "apex_desktop"

# The whole browser step, which may include creating a ChatCut account.
AUTHORIZE_SECONDS = 900
# One tool call's wait. After it the flow keeps running and the tool says so.
WAIT_SECONDS = 300

SECTION_ID = "apex.chatcut"
MAX_SECTION_CHARS = 1_500
# Same set as apexnodes-next-steps' NON_INTERACTIVE_PLATFORMS.
NON_INTERACTIVE_PLATFORMS = frozenset({"api_server", "cron", "webhook", "subagent"})

CONNECT_TOOL = "chatcut_connect"
IMPORT_TOOL = "chatcut_import_files"
TOOLSET = "apex_chatcut"
CONSENT_RELATIVE_PATH = ("apex", "chatcut-upload-consent.json")

# Editing, captions and export. Left out: import_media (see above), every paid generation tool, show_preview
# (a widget this host cannot draw), and account or web tools an edit does not need.
INCLUDED_TOOLS = (
    "apply_script",
    "browse_assets",
    "clean_script",
    "create_project",
    "detach_audio",
    "duplicate_project",
    "edit_asset",
    "edit_captions",
    "edit_item",
    "edit_project",
    "edit_track",
    "find_transcript",
    "get_editor_url",
    "inspect_asset",
    "inspect_item",
    "list_projects",
    "manage_markers",
    "manage_media_pool",
    "manage_timelines",
    "preview_timeline",
    "read_billing",
    "read_captions",
    "read_project",
    "read_script",
    "request_asset_download",
    "search_fonts",
    "smooth_audio",
    "split_item",
    "submit_export",
    "target_project",
    "track_export",
    "track_progress",
    "trigger_transcript",
)

_COPY = {
    "zh": {
        "connect_question": (
            "要连接 ChatCut 来剪这段视频吗？ChatCut 是第三方剪辑服务，用的是你自己的 ChatCut 账号和额度。"
            "点连接后会打开浏览器，请你在那里登录并同意授权。"
        ),
        "connect_yes": "连接 ChatCut",
        "connect_no": "先不用",
        "upload_question": (
            "要把{files}传到 ChatCut 吗？ChatCut 是第三方服务，服务器在美国：声音马上上传，用来转写成文字；"
            "原视频在云端处理时才上传。用的是你自己的 ChatCut 账号和额度。之后导入不再询问，断开 ChatCut 后会重新询问。"
        ),
        "upload_yes": "同意上传",
        "upload_no": "先不传",
        "file_list": "「{first}」等 {count} 个文件",
    },
    "en": {
        "connect_question": (
            "Connect ChatCut to edit this video? ChatCut is a third-party editing service and uses your own "
            "ChatCut account and credits. Connecting opens your browser so you can sign in and approve."
        ),
        "connect_yes": "Connect ChatCut",
        "connect_no": "Not now",
        "upload_question": (
            "Upload {files} to ChatCut? ChatCut is a third-party service with servers in the United States: the "
            "audio is uploaded right away to transcribe it, and the original video when cloud processing needs it. "
            "This uses your own ChatCut account and credits. You won't be asked again until you disconnect ChatCut."
        ),
        "upload_yes": "Agree and upload",
        "upload_no": "Not now",
        "file_list": "“{first}” and {count} files in all",
    },
}

CONNECT_SCHEMA = {
    "name": CONNECT_TOOL,
    "description": (
        "Connect this assistant to ChatCut, the third-party editor for footage the user already shot. "
        "Takes no arguments. It shows the user a choice card itself and opens their browser if they agree, so do "
        "not ask first. Returns status: connected (with the tools now callable through tool_describe/tool_call), "
        "declined, waiting (the browser step is not finished: tell the user, and call again when they say so), "
        "expired or failed."
    ),
    "parameters": {"type": "object", "properties": {}},
}

SWITCH_OFF = "ChatCut 现在没有开放，告诉用户暂时用不了。"
NEEDS_CARD = "这里没有卡片能让用户确认，连接 ChatCut 要在电脑上的 APEX 对话里做。"
DECLINED_NOTE = "用户这次不连接。别再自己问，继续用别的办法帮他，或者问他想怎么做。用户之后主动要剪辑时可以再调用。"
WAITING_NOTE = "浏览器那边还没点完。告诉用户到浏览器里登录并同意授权，点完跟你说一声；到时再调用一次这个工具，不要重新发起。"
EXPIRED_NOTE = "授权页已经过期，用户点了也不会生效。告诉用户要重新连接时跟你说，再调用这个工具就会打开新的授权页。"
FAILED_NOTE = "连接没有成功，把原因如实告诉用户，不要说已经连上。"
OPEN_LINK_NOTE = "浏览器没能自动打开：把 open_this_link 作为链接给用户，请他打开后登录并同意授权。"
NO_TOOLS_NOTE = "授权成功，但 ChatCut 的工具没有列出来。如实告诉用户，稍后再调用一次这个工具重试，不用重新授权。"
CONNECTED_NOTE = (
    "已连接。这些工具现在就能用 tool_describe / tool_call 调用（名字前缀 mcp__chatcut__）；剪辑流程用 skill_view 读 chatcut 技能。"
    "本机文件只用 chatcut_import_files 导入。"
)

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


def switch_on() -> bool:
    """Desktop settled the ChatCut switch on for this engine."""
    return os.environ.get(SWITCH_ENV, "").strip() == "1"


def mcp_url() -> str:
    """The server to talk to: ChatCut, unless a test points a loopback address here."""
    override = os.environ.get(TEST_URL_ENV, "").strip()
    if override and urlparse(override).hostname in ("127.0.0.1", "localhost"):
        return override
    return MCP_URL


def server_config() -> dict:
    """The ``mcp_servers`` entry, written to this assistant's config.yaml when it connects."""
    return {
        "url": mcp_url(),
        "auth": "oauth",
        "headers": {"x-chatcut-mcp-client": CLIENT_ID, "x-chatcut-mcp-surface": CLIENT_ID},
        "oauth": {"client_name": CLIENT_NAME, "timeout": AUTHORIZE_SECONDS},
        "tools": {"include": list(INCLUDED_TOOLS), "resources": False, "prompts": False},
        "connect_timeout": 60,
    }


def copy(key: str) -> str:
    """User-facing text in the conversation's language."""
    from agent.i18n import get_language

    return _COPY["zh" if str(get_language()).lower().startswith("zh") else "en"][key]


def home() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home()


def _own_block() -> Optional[dict]:
    """This assistant's ``mcp_servers.chatcut``, if it is the one this seam writes (same endpoint)."""
    from hermes_cli.config import read_raw_config_readonly

    servers = read_raw_config_readonly().get("mcp_servers")
    block = servers.get(SERVER_NAME) if isinstance(servers, dict) else None
    return block if isinstance(block, dict) and block.get("url") == mcp_url() else None


def _has_tokens() -> bool:
    from tools.mcp_oauth import HermesTokenStorage

    return HermesTokenStorage(SERVER_NAME).has_cached_tokens()


def is_connected() -> bool:
    """Connected means both halves: the entry in config.yaml and the tokens in this assistant's home."""
    return _own_block() is not None and _has_tokens()


def _consent_path() -> Path:
    return home().joinpath(*CONSENT_RELATIVE_PATH)


def _forget_consent() -> None:
    try:
        _consent_path().unlink(missing_ok=True)
    except OSError:
        logger.warning("apex-overlay: could not remove the ChatCut upload consent", exc_info=True)


def has_upload_consent() -> bool:
    return _consent_path().is_file()


def record_upload_consent() -> None:
    from utils import atomic_json_write

    path = _consent_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_json_write(path, {"agreed_at": time.time()})


def _after_disconnect() -> None:
    """Stop the live connection first, so a token refresh cannot write back what is removed next."""
    from tools.mcp_oauth_manager import get_manager

    try:
        from tools import mcp_tool_lifecycle
        from tools.mcp_tool_common import _core

        mcp_tool_lifecycle.shutdown_mcp_servers(scope=_core._mcp_registry_scope(), names={SERVER_NAME})
    except Exception:
        logger.warning("apex-overlay: could not stop the ChatCut connection", exc_info=True)
    get_manager().remove(SERVER_NAME, hermes_home=str(home()))
    _forget_consent()


def _install_disconnect(module: Any) -> bool:
    """Every way of removing the server (Settings' 断开 through either route, the CLI) goes through this one
    function, which leaves the tokens behind for every other server. ChatCut's must go with it."""
    original = module._remove_mcp_server
    if getattr(original, "_apex_chatcut", False):
        return True

    def _remove_mcp_server(name: str) -> bool:
        removed = original(name)
        if name == SERVER_NAME:
            _after_disconnect()
        return removed

    _remove_mcp_server._apex_chatcut = True  # type: ignore[attr-defined]
    module._remove_mcp_server = _remove_mcp_server
    return True


def _remove_block() -> None:
    from hermes_cli.config import mutate_config

    def edit(config: dict) -> None:
        servers = config.get("mcp_servers")
        if isinstance(servers, dict) and servers.pop(SERVER_NAME, None) is not None and not servers:
            config.pop("mcp_servers", None)

    mutate_config(edit)


def reconcile_at_boot() -> None:
    """Keep the two halves together, before MCP discovery reads the config.

    Switch off: nothing of ours stays, so the tools really go away. Switch on: an entry with no tokens (a new
    assistant cloned its config from another) or tokens with no entry (a refresh that outran 断开) are removed.
    """
    from tools.mcp_oauth import remove_oauth_tokens

    block, tokens = _own_block() is not None, _has_tokens()
    if switch_on() and block == tokens:
        return
    if block:
        _remove_block()
    if tokens:
        remove_oauth_tokens(SERVER_NAME)
    if not switch_on():
        _forget_consent()


# ---------------------------------------------------------------------------
# Connecting
# ---------------------------------------------------------------------------


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
                session.get("id", ""), SERVER_NAME, **_parse_redirect_query(parsed.query))
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
        started = start_flow(key, SERVER_NAME, server_config(),
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
        cancel_flow(attempt.session_id, SERVER_NAME, key)
    attempt.receiver.shutdown()
    attempt.receiver.server_close()


def _connected_result(agent: Any) -> str:
    """Bring the server up in this process and into this agent's toolset selection, then name its tools."""
    from tools.connectors.mcp import _registered_tool_names
    from tools.mcp_tool_config import _load_mcp_config
    from tools.mcp_tool_discovery import register_mcp_servers
    from tools.registry import tool_result

    config = _load_mcp_config().get(SERVER_NAME)
    if not isinstance(config, dict):
        return tool_result(status="failed", note=FAILED_NOTE, detail="ChatCut 的配置没有写进去。")
    register_mcp_servers({SERVER_NAME: config})
    names = _registered_tool_names(SERVER_NAME)
    enabled = getattr(agent, "enabled_toolsets", None)
    if enabled is not None and "no_mcp" not in enabled and SERVER_NAME not in enabled:
        agent.enabled_toolsets = [*enabled, SERVER_NAME]
    if not names:
        return tool_result(status="connected", tools=[], note=NO_TOOLS_NOTE)
    return tool_result(status="connected", tools=sorted(names), note=CONNECTED_NOTE)


def ask_on_card(agent: Any, question: str, yes: str, no: str) -> Optional[str]:
    """The existing choice card. The answer the user gave; None when nothing can ask or nobody answered."""
    from tools.clarify_tool import clarify_tool

    callback = getattr(agent, "clarify_callback", None)
    if callback is None:
        return None
    # recommended: false: no option is the right one here, so none is marked.
    questions = [{"question": question, "choices": [yes, no], "recommended": False}]
    # The transcript draws a card on a `clarify` row and closes it on that row's completion. Called from inside
    # this tool nothing else opens or closes one: a second card would land on the first card's row, already answered.
    row_id, row_args = f"apex-chatcut-card-{uuid.uuid4().hex}", {"questions": questions}
    started, finished = getattr(agent, "tool_start_callback", None), getattr(agent, "tool_complete_callback", None)
    if started is not None:
        started(row_id, "clarify", row_args)
    raw = clarify_tool(questions, callback=callback)
    if finished is not None:
        finished(row_id, "clarify", row_args, raw)
    try:
        response = json.loads(raw)["responses"][0]
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    return response.get("user_response") if response.get("status") == "answered" else None


def _wait_for_browser(agent: Any, key: str, attempt: _Attempt) -> str:
    from tools.interrupt import is_interrupted
    from tools.registry import tool_result
    from tui_gateway.mcp_oauth_sessions import poll_flow

    until = min(time.monotonic() + WAIT_SECONDS, attempt.expires_at)
    extra = {} if attempt.browser_opened else {"open_this_link": attempt.auth_url, "open_link_note": OPEN_LINK_NOTE}
    while True:
        state = poll_flow(attempt.session_id, SERVER_NAME)
        if state["status"] == "approved":
            _end_attempt(key)
            return _connected_result(agent)
        if state["status"] == "error":
            _end_attempt(key)
            return tool_result(status="failed", note=FAILED_NOTE, detail=str(state.get("error_message") or ""))
        # The SDK retries after its wait runs out and mints a new state: the page the user holds is dead by then.
        if state.get("auth_url") != attempt.auth_url or time.monotonic() >= attempt.expires_at:
            _end_attempt(key, cancel=True)
            return tool_result(status="expired", note=EXPIRED_NOTE)
        if time.monotonic() >= until or is_interrupted():
            return tool_result(status="waiting", note=WAITING_NOTE, **extra)
        time.sleep(0.5)


def connect(agent: Any, args: Mapping[str, Any] | None, ctx: Any) -> str:
    """``chatcut_connect``, inline: it needs the agent's card callback and its toolset selection."""
    from tools.registry import tool_error, tool_result

    if not switch_on():
        return tool_error(SWITCH_OFF)
    key = str(home())
    if is_connected():
        _end_attempt(key)
        return _connected_result(agent)
    with _LOCK:
        attempt = _attempts.get(key)
    if attempt is None:
        yes = copy("connect_yes")
        answer = ask_on_card(agent, copy("connect_question"), yes, copy("connect_no"))
        if getattr(agent, "clarify_callback", None) is None:
            return tool_error(NEEDS_CARD)
        if answer != yes:
            return tool_result(status="declined", note=DECLINED_NOTE, user_said=answer)
        try:
            attempt = _start_attempt(key)
        except Exception as exc:
            logger.warning("apex-overlay: could not start the ChatCut authorization", exc_info=True)
            return tool_result(status="failed", note=FAILED_NOTE, detail=str(exc) or type(exc).__name__)
        with _LOCK:
            _attempts[key] = attempt
    return _wait_for_browser(agent, key, attempt)


# ---------------------------------------------------------------------------
# Prompt and registration
# ---------------------------------------------------------------------------


def render_section(session_info: Mapping[str, Any] | None = None) -> str:
    """When to reach for ChatCut, and how, for a session a person is in."""
    info = session_info or {}
    if not switch_on() or info.get("platform") in NON_INTERACTIVE_PLATFORMS:
        return ""
    try:
        connected = is_connected()
    except Exception:
        logger.warning("apex-overlay: could not read the ChatCut connection", exc_info=True)
        connected = False
    state = (
        "现在已连接，工具名前缀 mcp__chatcut__，用 tool_describe / tool_call 调用。"
        if connected
        else (
            "现在还没连接。要用时调用 chatcut_connect（tool_call: "
            '{"calls":[{"name":"chatcut_connect","arguments":{}}]}），它自己会弹卡片问用户，你不用先问，'
            "也不要让用户去配置什么。"
        )
    )
    return "\n".join((
        "## 剪辑用户拍好的素材（ChatCut）",
        "用户要剪自己拍好的视频（去口误、删废话、加字幕、粗剪、调时间轴、导出）时，用第三方剪辑服务 ChatCut；"
        "动手前用 skill_view 读 chatcut 技能（name 填 chatcut），它不在上面的技能目录里。用户没提剪辑就不提 ChatCut。",
        state,
        "本机文件只用 chatcut_import_files 导入（它会在第一次上传前问用户）。ChatCut 的账号和额度都是用户自己的；"
        "生成视频、图片、配音仍用 APEX 自己的工具。",
    ))


def _install_inline(module: Any) -> bool:
    """The two tools run inline: they need the agent's card callback, which registry dispatch does not forward."""
    from apex_overlay.chatcut_import import import_files

    module.INLINE_TOOL_EXECUTORS[CONNECT_TOOL] = connect
    module.INLINE_TOOL_EXECUTORS[IMPORT_TOOL] = import_files
    return True


def apply(ctx: Any) -> bool:
    """Settle what a previous launch left, then, only with the switch on, register everything."""
    register_tool = getattr(ctx, "register_tool", None)
    register_section = getattr(ctx, "register_system_prompt_section", None)
    if register_tool is None or register_section is None:
        logger.warning("apex-overlay: this plugin host cannot register the ChatCut seam")
        return False
    try:
        reconcile_at_boot()
    except Exception:
        logger.warning("apex-overlay: could not settle the ChatCut connection at boot", exc_info=True)
    if not switch_on():
        return True
    from apex_overlay.chatcut_import import IMPORT_SCHEMA
    from tools.registry import no_cache_check_fn

    try:
        register_section(SECTION_ID, render_section, max_chars=MAX_SECTION_CHARS)
    except ValueError as exc:
        logger.warning("apex-overlay: ChatCut prompt section not registered: %s", exc)
        return False
    for schema in (CONNECT_SCHEMA, IMPORT_SCHEMA):
        register_tool(
            name=schema["name"],
            toolset=TOOLSET,
            schema=schema,
            # Registry dispatch has no card callback; the inline table runs them in a conversation.
            handler=lambda _args, **_kw: json.dumps({"error": NEEDS_CARD}, ensure_ascii=False),
            check_fn=no_cache_check_fn(switch_on),
            description=schema["description"],
            emoji="🎬",
        )
    return (post_import.when_imported("agent.inline_tool_executors", _install_inline)
            and post_import.when_imported("hermes_cli.mcp_config", _install_disconnect))
