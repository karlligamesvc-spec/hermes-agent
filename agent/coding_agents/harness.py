"""Session-oriented harness for driving external coding agents.

``AgentHarness`` is the protocol-agnostic base: it owns the spawn (through the
ledger, with a credential-scrubbed env), the availability probe contract, and
the session bookkeeping. ``AcpHarness`` is the concrete ACP JSON-RPC harness
(the hc-524 namesake) used by Cursor and CodeBuddy. The two Direct providers —
Claude ``stream-json`` and Codex ``app-server`` — are siblings in
``direct.py``; all three share this base's machinery and the three iron rules.

Iron rules, and where they live:
  1. Interface converges on the *session*, not the process — callers hold an
     ``AgentHarness`` and talk ``open()/prompt()/cancel()``; the ``session_id``
     returned by :data:`EventKind.SESSION_STARTED` is the exact id they pass
     back for the next prompt and for cancel. The OS process is an
     implementation detail behind the ledger.
  2. State comes only from explicit protocol messages — every yielded
     ``AgentEvent`` originates from a JSON-RPC notification / reply. There is
     no terminal-screen scraping anywhere in this package.
  3. Process accounting — spawn goes through :class:`SpawnLedger` (record at
     spawn, reap the exact recorded handle, never by name).

Security (§4): launch is white-listed by the registry row; ``prompt`` text is
never shell-interpolated — it travels as a JSON payload over the wire. The
child env is scrubbed of Hermes provider/infra secrets and HOME is repaired to
the real user home so the external agent authenticates from *its own*
credential store on the user's machine — the adapter neither reads nor forwards
those credentials.
"""

from __future__ import annotations

import abc
import os
import shutil
import subprocess
from pathlib import Path
from typing import Callable, Iterator
from uuid import uuid4

from .channel import LineChannel, SubprocessLineChannel
from .events import AgentEvent, AvailabilityInfo
from .ledger import SpawnLedger
from .registry import AgentSpec

# Family-neutral permission decisions a permission_callback may return.
ALLOW_ONCE = "allow_once"
ALLOW_ALWAYS = "allow_always"
DENY = "deny"

# A permission callback is handed a normalized request dict and returns one of
# the decision strings above. The default denies — nothing runs on the user's
# machine without an explicit approving policy.
PermissionCallback = Callable[[dict], str]


def default_deny_permission(_request: dict) -> str:
    return DENY


class AgentHarness(abc.ABC):
    """Base harness: spawn + ledger + availability + session bookkeeping.

    Concrete families implement the protocol hooks (``_handshake``,
    ``_start_session``, ``prompt``, ``cancel``) on top of the shared services
    here. Construct with ``channel_factory`` in tests to inject a
    :class:`ScriptedLineChannel` and exercise the state machine with no real
    process.
    """

    def __init__(
        self,
        spec: AgentSpec,
        cwd: str | os.PathLike[str] | None = None,
        *,
        ledger: SpawnLedger | None = None,
        permission_callback: PermissionCallback | None = None,
        channel_factory: Callable[[], LineChannel] | None = None,
        turn_timeout: float = 900.0,
    ) -> None:
        self.spec = spec
        self.cwd = str(Path(cwd or os.getcwd()).resolve())
        self._ledger = ledger or SpawnLedger()
        self._permission_callback = permission_callback or default_deny_permission
        self._channel_factory = channel_factory
        self._turn_timeout = turn_timeout
        # Ledger key = OS-process identity, distinct from the protocol
        # session_id (rule 1: process is behind the session, not the same thing).
        self._proc_key = f"{spec.session_namespace}:{uuid4().hex}"
        # Every ledger key this harness has spawned under (ACP uses just the
        # primary key; Direct providers add one per turn). close() reaps exactly
        # these, never a shared ledger's other harnesses' children.
        self._proc_keys: set[str] = set()
        self.session_id: str | None = None
        self._channel: LineChannel | None = None
        self._id_counter = 0
        self._closed = False

    # --- capability probing ------------------------------------------------

    @abc.abstractmethod
    def availability(self) -> AvailabilityInfo:
        """Probe whether this agent can be driven here. Never raises."""

    def _which(self) -> str | None:
        return shutil.which(self.spec.command)

    # --- lifecycle ---------------------------------------------------------

    @abc.abstractmethod
    def open(self) -> str:
        """Prepare the session and return its round-trip id.

        Protocol-specific: ACP spawns + handshakes + ``session/new`` here; the
        Direct providers whose id only emerges from the first turn return the
        empty string until then.
        """

    @abc.abstractmethod
    def prompt(self, text: str) -> Iterator[AgentEvent]:
        """Drive one turn for ``text``, yielding normalized events.

        Reuses ``self.session_id`` — calling again continues the same session
        (rule 1: same id round-trips into the next prompt).
        """

    @abc.abstractmethod
    def cancel(self) -> None:
        """Abort the in-flight turn via the protocol's cancel (never kill-by-name)."""

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._channel is not None:
            self._channel.close()
        # Reap exactly the handles this harness spawned, by ledger identity
        # (rule 3) — not a blanket reap_all that could hit a shared ledger's
        # other harnesses.
        for key in list(self._proc_keys):
            self._ledger.reap(key)

    def __enter__(self) -> "AgentHarness":
        self.open()
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # --- shared services ---------------------------------------------------

    @property
    def channel(self) -> LineChannel:
        if self._channel is None:
            raise RuntimeError("harness not opened; call open() first")
        return self._channel

    def _make_channel(
        self,
        *,
        extra_args: list[str] | None = None,
        key: str | None = None,
    ) -> LineChannel:
        if self._channel_factory is not None:
            return self._channel_factory()
        return SubprocessLineChannel(self._spawn(extra_args=extra_args, key=key))

    def _spawn(
        self,
        *,
        extra_args: list[str] | None = None,
        key: str | None = None,
    ) -> subprocess.Popen:
        argv = self.spec.launch_command() + list(extra_args or [])
        ledger_key = key or self._proc_key
        try:
            proc = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=self.cwd,
                env=self._scrubbed_env(),
                bufsize=1,
                text=True,
            )
        except FileNotFoundError as exc:
            hint = f" Install with: {self.spec.install_hint}" if self.spec.install_hint else ""
            raise RuntimeError(
                f"could not launch {self.spec.display_name} ({argv[0]!r} not found).{hint}"
            ) from exc
        self._proc_keys.add(ledger_key)
        self._ledger.record(
            session_id=ledger_key,
            family=self.spec.id,
            proc=proc,
            argv=argv,
        )
        return proc

    def _scrubbed_env(self) -> dict[str, str]:
        """Env for the child: Hermes secrets stripped, real HOME restored.

        ``inherit_credentials=False`` — we do NOT forward Hermes' own provider
        keys into the user's coding agent (§4: the user's Claude/Codex uses its
        own subscription). HOME is repaired to the real account home so the
        external CLI reads its own credential store, mirroring
        ``copilot_acp_client._build_subprocess_env``.
        """
        from tools.environments.local import hermes_subprocess_env
        from hermes_constants import apply_subprocess_home_env, get_real_home

        env = hermes_subprocess_env(inherit_credentials=False)
        # hc-524 audit P2: hermes_subprocess_env's blocklist strips provider/infra
        # keys but NOT the IM-channel app secrets (FEISHU_/WECOM_/DINGTALK_/QQBOT_/
        # WEIXIN_*), which the desktop backend may have injected (hc-417). Those
        # must never reach a spawned third-party CLI (cursor-agent etc.). Scrub any
        # channel secret explicitly.
        _CHANNEL_SECRET_PREFIXES = ("FEISHU_", "WECOM_", "DINGTALK_", "QQBOT_", "WEIXIN_")
        _CHANNEL_SECRET_MARKERS = ("_APP_SECRET", "_SECRET", "_ENCODING_AES_KEY", "_BOT_TOKEN", "_TOKEN")
        for key in list(env):
            up = key.upper()
            if up.startswith(_CHANNEL_SECRET_PREFIXES) and any(m in up for m in _CHANNEL_SECRET_MARKERS):
                del env[key]
        real_home = get_real_home(env)
        if real_home:
            env["HOME"] = real_home
        apply_subprocess_home_env(env)
        return env

    def _next_id(self) -> int:
        self._id_counter += 1
        return self._id_counter


# ---------------------------------------------------------------------------
# ACP JSON-RPC harness (Cursor, CodeBuddy)
# ---------------------------------------------------------------------------


class AcpHarness(AgentHarness):
    """Drives an ACP agent over newline-delimited JSON-RPC 2.0 (stdio).

    Session lifecycle: ``initialize`` -> ``session/new`` -> ``session/prompt``
    (streaming ``session/update`` notifications, answering server-initiated
    ``session/request_permission``) -> ``session/cancel``. No third-party ACP
    library: like ``copilot_acp_client``, we speak the wire directly so the
    harness carries no optional ``agent-client-protocol`` dependency into the
    Desktop bundle.
    """

    #: We advertise no client-side filesystem capability: the external agent
    #: runs on the user's machine with the user's own permissions and does its
    #: own file IO (§4 — the adapter does not read/write user files on its
    #: behalf). Any fs/* request is therefore rejected.
    CLIENT_CAPABILITIES = {"fs": {"readTextFile": False, "writeTextFile": False}}

    def availability(self) -> AvailabilityInfo:
        resolved = self._which()
        if resolved is None:
            # npx-launched families (codebuddy) can't be cheaply verified: npx
            # would fetch the package on first run. Report the launcher status.
            return AvailabilityInfo(
                family=self.spec.id,
                installed=False,
                command=self.spec.command,
                detail=f"{self.spec.command!r} not found on PATH. {self.spec.install_hint}".strip(),
            )
        return AvailabilityInfo(
            family=self.spec.id,
            installed=True,
            command=resolved,
            detail=f"{self.spec.display_name} launcher resolved at {resolved}",
        )

    def open(self) -> str:
        """Spawn, ``initialize`` handshake, then ``session/new``."""
        if self._channel is None:
            self._channel = self._make_channel()
            self._handshake()
            self.session_id = self._start_session()
        assert self.session_id is not None
        return self.session_id

    def _handshake(self) -> None:
        self._rpc_call(
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": self.CLIENT_CAPABILITIES,
                "clientInfo": {
                    "name": "apexnodes-harness",
                    "title": "ApexNodes Agent Harness",
                    "version": "0.1.0",
                },
            },
        )

    def _start_session(self) -> str:
        result = self._rpc_call("session/new", {"cwd": self.cwd, "mcpServers": []})
        session_id = str((result or {}).get("sessionId") or "").strip()
        if not session_id:
            raise RuntimeError(f"{self.spec.display_name} did not return a sessionId")
        return session_id

    def prompt(self, text: str) -> Iterator[AgentEvent]:
        if self.session_id is None:
            self.open()
        assert self.session_id is not None
        request_id = self._send_request(
            "session/prompt",
            {"sessionId": self.session_id, "prompt": [{"type": "text", "text": text}]},
        )
        yield AgentEvent.session_started(self.session_id)  # surface the round-trip id first
        yield from self._drain_turn(request_id)

    def cancel(self) -> None:
        if self._channel is None or self.session_id is None:
            return
        # ACP cancel is a notification targeting the SAME session id (rule 1).
        self._send_notification("session/cancel", {"sessionId": self.session_id})

    # --- JSON-RPC plumbing -------------------------------------------------

    def _send_request(self, method: str, params: dict) -> int:
        request_id = self._next_id()
        self.channel.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        return request_id

    def _send_notification(self, method: str, params: dict) -> None:
        self.channel.send({"jsonrpc": "2.0", "method": method, "params": params})

    def _rpc_call(self, method: str, params: dict) -> dict:
        """Send a request and block until its reply, answering server requests.

        Used for handshake/session-setup where no events are yielded. Streaming
        notifications that arrive early are answered/ignored (not scraped)."""
        request_id = self._send_request(method, params)
        for event in self._drain_turn(request_id, collect_reply=True):
            if isinstance(event, _Reply):
                if event.error is not None:
                    raise RuntimeError(f"{method} failed: {event.error}")
                return event.result or {}
        raise RuntimeError(f"{method}: channel closed before reply")

    def _drain_turn(self, request_id: int, *, collect_reply: bool = False):
        """Drain inbound messages until the reply to ``request_id``.

        Yields normalized ``AgentEvent`` for notifications. When
        ``collect_reply`` is set (handshake path) it yields the terminal
        ``_Reply`` sentinel instead of a ``TURN_COMPLETED`` event.
        """
        import time

        deadline = time.monotonic() + self._turn_timeout
        while time.monotonic() < deadline:
            if self.channel.poll() is not None:
                tail = "\n".join(self.channel.stderr_tail())
                yield AgentEvent.error(f"{self.spec.display_name} exited early. {tail}".strip())
                return
            msg = self.channel.recv(timeout=0.1)
            if msg is None:
                continue

            mid = msg.get("id")
            method = msg.get("method")

            # Reply to our request.
            if mid == request_id and method is None:
                if collect_reply:
                    yield _Reply(result=msg.get("result"), error=msg.get("error"))
                    return
                if "error" in msg:
                    yield AgentEvent.error(f"{self.spec.display_name}: {msg['error']}")
                else:
                    stop = ((msg.get("result") or {}).get("stopReason"))
                    yield AgentEvent.turn_completed(stop)
                return

            # Server-initiated request (has id AND method).
            if mid is not None and method is not None:
                for event in self._answer_server_request(msg):
                    yield event
                continue

            # Notification (method, no id).
            if method is not None:
                yield from self._normalize_notification(msg)
                continue
        raise TimeoutError(f"timed out waiting for {self.spec.display_name} reply")

    def _answer_server_request(self, msg: dict):
        method = msg.get("method")
        message_id = msg.get("id")
        params = msg.get("params") or {}
        if method == "session/request_permission":
            request = {
                "family": self.spec.id,
                "kind": "permission",
                "options": params.get("options") or [],
                "tool_call": params.get("toolCall") or params.get("tool_call"),
                "raw": params,
            }
            yield AgentEvent.permission_request(request)
            decision = self._permission_callback(request)
            self.channel.send({"jsonrpc": "2.0", "id": message_id, "result": self._acp_permission_result(decision, params)})
            return
        # We advertised no fs capability; reject anything else explicitly rather
        # than guessing (rule 2: no implicit behavior). This branch yields
        # nothing — the method is a generator by virtue of the permission branch.
        self.channel.send(
            {
                "jsonrpc": "2.0",
                "id": message_id,
                "error": {"code": -32601, "message": f"method {method!r} not supported by harness"},
            }
        )

    @staticmethod
    def _acp_permission_result(decision: str, params: dict) -> dict:
        """Map a family-neutral decision to an ACP RequestPermission result."""
        if decision == DENY:
            return {"outcome": {"outcome": "cancelled"}}
        # Pick the option id matching the decision, else the first allow option.
        options = params.get("options") or []
        want_kind = "allow_always" if decision == ALLOW_ALWAYS else "allow_once"
        chosen = None
        for opt in options:
            if opt.get("kind") == want_kind or opt.get("optionId") == want_kind:
                chosen = opt.get("optionId")
                break
        if chosen is None:
            for opt in options:
                if str(opt.get("kind", "")).startswith("allow"):
                    chosen = opt.get("optionId")
                    break
        if chosen is None:
            return {"outcome": {"outcome": "cancelled"}}
        return {"outcome": {"outcome": "selected", "optionId": chosen}}

    def _normalize_notification(self, msg: dict) -> Iterator[AgentEvent]:
        """Map an ACP ``session/update`` notification to normalized events."""
        if msg.get("method") != "session/update":
            return
        update = (msg.get("params") or {}).get("update") or {}
        kind = str(update.get("sessionUpdate") or "").strip()
        content = update.get("content") or {}
        text = content.get("text") if isinstance(content, dict) else None

        if kind == "agent_message_chunk" and text:
            yield AgentEvent.message(text)
        elif kind == "agent_thought_chunk" and text:
            yield AgentEvent.thought(text)
        elif kind == "tool_call":
            tc_id = str(update.get("toolCallId") or update.get("toolCall", {}).get("toolCallId") or "")
            yield AgentEvent.tool_call(
                tool_call_id=tc_id,
                tool_name=str(update.get("title") or update.get("kind") or "tool"),
                input=update.get("rawInput"),
                kind=update.get("kind"),
            )
            yield from self._extract_diffs(update)
        elif kind == "tool_call_update":
            status = str(update.get("status") or "")
            if status in {"completed", "failed"}:
                yield AgentEvent.tool_result(
                    tool_call_id=str(update.get("toolCallId") or ""),
                    status=status,
                    output=update.get("content"),
                )
            yield from self._extract_diffs(update)
        elif kind == "plan":
            yield AgentEvent.plan(update.get("entries") or [])

    @staticmethod
    def _extract_diffs(update: dict) -> Iterator[AgentEvent]:
        """Surface diff content blocks as FILE_CHANGE events."""
        blocks = update.get("content")
        if not isinstance(blocks, list):
            return
        for block in blocks:
            if isinstance(block, dict) and block.get("type") == "diff":
                yield AgentEvent.file_change(
                    path=str(block.get("path") or ""),
                    kind="update",
                    diff=block.get("newText"),
                )


class _Reply:
    """Internal sentinel: a JSON-RPC reply surfaced through the drain loop."""

    __slots__ = ("result", "error")

    def __init__(self, result: dict | None, error: dict | None) -> None:
        self.result = result
        self.error = error
