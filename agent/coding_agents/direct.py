"""Direct-provider harnesses: Claude Code (stream-json) and Codex (app-server).

These two families predate/sidestep ACP with native streaming protocols, so
they are not ACP subclasses — they are siblings of :class:`AcpHarness` sharing
:class:`AgentHarness`'s spawn/ledger/env services and the three iron rules.
Both normalize their native wire events into the same :class:`AgentEvent`
vocabulary as the ACP path, so a caller cannot tell which transport is driving.
"""

from __future__ import annotations

import json
import subprocess
from typing import Iterator
from uuid import uuid4

from .events import AgentEvent, AvailabilityInfo
from .harness import ALLOW_ALWAYS, ALLOW_ONCE, DENY, AgentHarness


def _probe_version(argv: list[str]) -> str | None:
    """Run ``<bin> --version`` and return the raw output, or None if unavailable."""
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=10,
            stdin=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    return (proc.stdout or proc.stderr or "").strip() or None


# ---------------------------------------------------------------------------
# Claude Code — stream-json print mode
# ---------------------------------------------------------------------------


class ClaudeDirectHarness(AgentHarness):
    """Drives Claude Code via ``claude -p ... --output-format stream-json``.

    Print mode is one process per turn: the prompt is a launch arg, stdout is a
    newline-delimited event stream, and the process exits when the turn ends.
    Continuation reuses the ``session_id`` discovered from the first turn via
    ``--resume`` (rule 1: the id from the stream round-trips into the next
    prompt). Cancel terminates the current turn's *exact* spawned handle through
    the ledger (rule 3), never by name.
    """

    def availability(self) -> AvailabilityInfo:
        resolved = self._which()
        if resolved is None:
            return AvailabilityInfo(
                family=self.spec.id,
                installed=False,
                command=self.spec.command,
                detail=f"claude not found on PATH. {self.spec.install_hint}".strip(),
            )
        version = _probe_version([resolved, "--version"])
        # Login is not cheaply probed without a network round-trip; left None
        # (unknown) rather than spending one. `claude auth status` is the deeper
        # check a caller can run explicitly.
        return AvailabilityInfo(
            family=self.spec.id,
            installed=True,
            command=resolved,
            version=version,
            logged_in=None,
            detail=f"Claude Code {version or '(version unknown)'}",
        )

    def open(self) -> str:
        # No persistent process / handshake — the session id emerges from the
        # first turn's system:init event. Returns "" until then.
        return self.session_id or ""

    def _build_prompt_args(self, text: str) -> list[str]:
        """The per-turn args appended to the launch command.

        With a known ``session_id`` this adds ``--resume <id>`` — the id the
        first turn reported round-tripping into continuation (rule 1).
        """
        extra = [self.spec.quirks.get("prompt_flag", "-p"), text]
        if self.session_id:
            extra += [self.spec.quirks.get("resume_flag", "--resume"), self.session_id]
        return extra

    def prompt(self, text: str) -> Iterator[AgentEvent]:
        extra = self._build_prompt_args(text)
        turn_key = f"{self.spec.session_namespace}:turn:{uuid4().hex}"
        self._current_turn_key = turn_key
        channel = self._make_channel(extra_args=extra, key=turn_key)
        try:
            yield from self._drain_stream(channel)
        finally:
            channel.close()
            # hc-524 audit P2: print mode usually exits on its own, but if the
            # caller breaks the generator early (before the result line) the child
            # is still alive — forget() alone would drop it from the ledger while
            # leaving an orphan that close() can no longer reap. Reap if still
            # running; only forget a genuinely-dead child.
            if channel.poll() is None:
                self._ledger.reap(turn_key)
            else:
                self._ledger.forget(turn_key)
            self._proc_keys.discard(turn_key)
            self._current_turn_key = None

    _current_turn_key: str | None = None

    def cancel(self) -> None:
        key = self._current_turn_key
        if key is not None:
            self._ledger.reap(key)  # terminate this turn's exact handle (rule 3)

    def _drain_stream(self, channel) -> Iterator[AgentEvent]:
        import time

        deadline = time.monotonic() + self._turn_timeout
        seen_result = False
        while time.monotonic() < deadline:
            msg = channel.recv(timeout=0.1)
            if msg is None:
                if channel.poll() is not None:
                    break  # process exited; stream drained
                continue
            yield from self._normalize_stream_json(msg)
            if msg.get("type") == "result":
                seen_result = True
                break
        if not seen_result and channel.poll() not in (0, None):
            tail = "\n".join(channel.stderr_tail())
            yield AgentEvent.error(f"Claude Code exited abnormally. {tail}".strip())

    def _normalize_stream_json(self, msg: dict) -> Iterator[AgentEvent]:
        mtype = msg.get("type")
        if mtype == "system" and msg.get("subtype") == "init":
            sid = msg.get("session_id")
            if sid:
                sid_str = str(sid)
                self.session_id = sid_str
                yield AgentEvent.session_started(sid_str)
            return
        if mtype == "assistant":
            for block in (msg.get("message") or {}).get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and block.get("text"):
                    yield AgentEvent.message(block["text"])
                elif block.get("type") == "tool_use":
                    yield AgentEvent.tool_call(
                        tool_call_id=str(block.get("id") or ""),
                        tool_name=str(block.get("name") or "tool"),
                        input=block.get("input"),
                    )
            return
        if mtype == "user":
            for block in (msg.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    yield AgentEvent.tool_result(
                        tool_call_id=str(block.get("tool_use_id") or ""),
                        status="failed" if block.get("is_error") else "completed",
                        output=block.get("content"),
                    )
            return
        if mtype == "result":
            sid = msg.get("session_id")
            if sid:
                self.session_id = str(sid)  # authoritative id for --resume
            if msg.get("usage") or msg.get("total_cost_usd") is not None:
                yield AgentEvent.usage(
                    {"usage": msg.get("usage"), "total_cost_usd": msg.get("total_cost_usd")}
                )
            if msg.get("is_error"):
                yield AgentEvent.error(str(msg.get("result") or msg.get("subtype") or "error"))
            yield AgentEvent.turn_completed(str(msg.get("subtype") or ""))


# ---------------------------------------------------------------------------
# Codex — app-server JSON-RPC
# ---------------------------------------------------------------------------


class CodexDirectHarness(AgentHarness):
    """Drives ``codex app-server`` over JSON-RPC 2.0 (stdio).

    Persistent process: ``initialize`` + ``initialized`` handshake, then
    ``thread/start`` yields the thread id (our ``session_id``). Each turn is a
    ``turn/start`` whose ``item/*`` notifications stream until ``turn/completed``.
    Cancel is ``turn/interrupt`` targeting the same ``threadId`` + current
    ``turnId`` (rule 1). Spawned through the base's ledger/env so the child is
    accounted for (rule 3) and gets a Hermes-secret-scrubbed env (§4) — codex
    authenticates from the user's own ``~/.codex``.
    """

    def availability(self) -> AvailabilityInfo:
        from agent.transports.codex_app_server import check_codex_binary

        resolved = self._which()
        ok, message = check_codex_binary(self.spec.command)
        return AvailabilityInfo(
            family=self.spec.id,
            installed=ok,
            command=resolved or self.spec.command,
            version=message if ok else None,
            detail=message if not ok else f"Codex {message}",
        )

    def open(self) -> str:
        if self._channel is None:
            self._channel = self._make_channel()
            self._initialize()
            self.session_id = self._start_thread()
        assert self.session_id is not None
        return self.session_id

    def _initialize(self) -> None:
        self._request(
            "initialize",
            {
                "clientInfo": {"name": "apexnodes-harness", "title": "ApexNodes Agent Harness", "version": "0.1.0"},
                "capabilities": {},
            },
        )
        self._notify("initialized")

    def _start_thread(self) -> str:
        result = self._request("thread/start", {"cwd": self.cwd})
        thread = result.get("thread") or {}
        thread_id = (
            thread.get("id")
            or thread.get("sessionId")
            or result.get("sessionId")
            or result.get("threadId")
        )
        if not thread_id:
            raise RuntimeError(f"codex thread/start returned no thread id (keys: {sorted(result)})")
        return str(thread_id)

    def prompt(self, text: str) -> Iterator[AgentEvent]:
        if self.session_id is None:
            self.open()
        assert self.session_id is not None
        turn_req_id = self._send(
            "turn/start",
            {"threadId": self.session_id, "input": [{"type": "text", "text": text}]},
        )
        yield AgentEvent.session_started(self.session_id)
        yield from self._drain_turn(turn_req_id)

    def cancel(self) -> None:
        if self._channel is None or self.session_id is None or self._turn_id is None:
            return
        # turn/interrupt targets the same thread + current turn (rule 1); never
        # a process-name kill.
        self._send("turn/interrupt", {"threadId": self.session_id, "turnId": self._turn_id})

    _turn_id: str | None = None

    # --- JSON-RPC plumbing (mirrors codex_app_server wire shapes) ----------

    def _send(self, method: str, params: dict) -> int:
        request_id = self._next_id()
        self.channel.send({"id": request_id, "method": method, "params": params})
        return request_id

    def _notify(self, method: str, params: dict | None = None) -> None:
        self.channel.send({"method": method, "params": params or {}})

    def _request(self, method: str, params: dict, *, timeout: float = 15.0) -> dict:
        import time

        request_id = self._send(method, params)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.channel.poll() is not None:
                raise RuntimeError(f"codex exited during {method}: {chr(10).join(self.channel.stderr_tail())}")
            msg = self.channel.recv(timeout=0.1)
            if msg is None:
                continue
            if msg.get("id") == request_id and "method" not in msg:
                if msg.get("error"):
                    raise RuntimeError(f"codex {method} failed: {msg['error']}")
                return msg.get("result") or {}
            # Ignore notifications arriving during handshake (rule 2: nothing
            # derived from them here).
        raise TimeoutError(f"codex {method} timed out")

    def _drain_turn(self, turn_req_id: int) -> Iterator[AgentEvent]:
        import time

        deadline = time.monotonic() + self._turn_timeout
        while time.monotonic() < deadline:
            if self.channel.poll() is not None:
                yield AgentEvent.error(f"codex exited mid-turn. {chr(10).join(self.channel.stderr_tail())}".strip())
                return
            msg = self.channel.recv(timeout=0.1)
            if msg is None:
                continue
            mid = msg.get("id")
            method = msg.get("method")

            # Server-initiated approval request.
            if mid is not None and method is not None:
                yield from self._answer_approval(msg)
                continue
            # Reply to turn/start — only interesting if it's an error.
            if mid == turn_req_id and method is None:
                if msg.get("error"):
                    yield AgentEvent.error(f"codex turn/start: {msg['error']}")
                    return
                continue
            # Notifications.
            if method == "turn/started":
                # hc-524 audit P1: real codex (0.130.0, see codex_app_server_
                # session.py) nests the turn under params.turn — {"turn":{"id":…}}.
                # Reading a flat params.turnId returned None → _turn_id never set →
                # cancel() silently no-op'd. Prefer nested, fall back to flat for
                # forward-compat with any wire variant.
                params = msg.get("params") or {}
                turn_obj = params.get("turn") or {}
                self._turn_id = turn_obj.get("id") or params.get("turnId") or self._turn_id
            elif method == "turn/completed":
                params = msg.get("params") or {}
                turn_obj = params.get("turn") or {}
                if turn_obj.get("id"):
                    self._turn_id = turn_obj["id"]
                status = turn_obj.get("status") or params.get("status")
                yield AgentEvent.turn_completed(status)
                return
            elif method == "thread/tokenUsage/updated":
                yield AgentEvent.usage((msg.get("params") or {}))
            elif method == "item/completed":
                yield from self._normalize_item((msg.get("params") or {}).get("item") or {})
        raise TimeoutError("codex turn timed out")

    def _answer_approval(self, msg: dict) -> Iterator[AgentEvent]:
        method = str(msg.get("method") or "")
        rid = msg.get("id")
        params = msg.get("params") or {}
        if method.endswith("/requestApproval"):
            request = {"family": self.spec.id, "kind": "approval", "method": method, "raw": params}
            yield AgentEvent.permission_request(request)
            decision = self._permission_callback(request)
            codex_decision = "decline" if decision == DENY else "accept"
            self.channel.send({"id": rid, "result": {"decision": codex_decision}})
            return
        # Unknown server request — reject cleanly so codex doesn't hang.
        self.channel.send({"id": rid, "error": {"code": -32601, "message": f"unsupported: {method}"}})

    def _normalize_item(self, item: dict) -> Iterator[AgentEvent]:
        itype = item.get("type") or ""
        item_id = str(item.get("id") or "")
        if itype == "agentMessage":
            if item.get("text"):
                yield AgentEvent.message(item["text"])
        elif itype == "reasoning":
            parts = list(item.get("summary") or []) + list(item.get("content") or [])
            if parts:
                yield AgentEvent.thought("\n".join(str(p) for p in parts))
        elif itype == "commandExecution":
            yield AgentEvent.tool_call(
                tool_call_id=f"codex_exec_{item_id}",
                tool_name="exec_command",
                input={"command": item.get("command"), "cwd": item.get("cwd")},
                kind="execute",
            )
            exit_code = item.get("exitCode")
            yield AgentEvent.tool_result(
                tool_call_id=f"codex_exec_{item_id}",
                status="completed" if exit_code in (0, None) else "failed",
                output=item.get("aggregatedOutput"),
            )
        elif itype == "fileChange":
            call_id = f"codex_patch_{item_id}"
            yield AgentEvent.tool_call(tool_call_id=call_id, tool_name="apply_patch", kind="edit")
            for change in item.get("changes") or []:
                kind = (change.get("kind") or {}).get("type") or "update"
                yield AgentEvent.file_change(path=str(change.get("path") or ""), kind=kind)
            yield AgentEvent.tool_result(
                tool_call_id=call_id,
                status=str(item.get("status") or "completed"),
                output=None,
            )
        elif itype in {"mcpToolCall", "dynamicToolCall"}:
            server = item.get("server")
            tool = item.get("tool") or "unknown"
            name = f"mcp.{server}.{tool}" if itype == "mcpToolCall" else str(tool)
            call_id = f"codex_{itype}_{item_id}"
            yield AgentEvent.tool_call(tool_call_id=call_id, tool_name=name, input=item.get("arguments"))
            output = item.get("result") if item.get("error") is None else item.get("error")
            yield AgentEvent.tool_result(
                tool_call_id=call_id,
                status="failed" if item.get("error") else "completed",
                output=json.dumps(output, ensure_ascii=False)[:4000] if output is not None else None,
            )
        # userMessage and unknown item types are intentionally not projected
        # (rule 2: no fabricated structure from ambiguous events).
