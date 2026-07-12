"""Unified harness for orchestrating external coding agents (hc-524).

Lets APEX Desktop's on-device assistant drive the user's *own* coding agents —
Claude Code, Codex, Cursor (first wave; CodeBuddy parked) — as sub-agents, over
one normalized event stream regardless of each family's native wire protocol.

Layering (Step-0 conclusion):
  - This is the runtime/Python engine layer. It reuses the in-repo client-side
    precedent (``agent/copilot_acp_client.py``: raw newline-delimited JSON-RPC
    over stdio, ``hermes_subprocess_env`` for a scrubbed env) rather than the
    ``acp_adapter``/``agent-client-protocol`` server SDK — that library is an
    optional server-direction extra (hermes-as-ACP-agent for editors), the
    wrong direction and an unwanted bundle dependency for driving subprocesses.
  - Desktop UI wiring is a later thin layer over this engine.

Public surface:
  - ``harness_for(family, cwd, ...)`` -> an :class:`AgentHarness` you
    ``open()`` / ``prompt(text)`` / ``cancel()`` / ``close()``.
  - ``probe_all()`` -> per-family :class:`AvailabilityInfo`.
  - ``AGENT_REGISTRY`` / ``get_spec`` / ``list_specs`` -> the family table.
  - ``AgentEvent`` / ``EventKind`` -> the normalized event vocabulary.

Three iron rules run through the whole package: (1) the interface converges on
the session, not the process — the ``session_id`` from the stream round-trips
into the next prompt and cancel; (2) state comes only from explicit protocol
events, never terminal-screen scraping; (3) every spawned child is tracked in a
:class:`SpawnLedger` and reaped by exact handle identity, never by name.
"""

from __future__ import annotations

from .channel import LineChannel, ScriptedLineChannel, SubprocessLineChannel
from .events import AgentEvent, AvailabilityInfo, EventKind
from .factory import harness_for, probe_all
from .harness import (
    ALLOW_ALWAYS,
    ALLOW_ONCE,
    DENY,
    AcpHarness,
    AgentHarness,
    PermissionCallback,
    default_deny_permission,
)
from .direct import ClaudeDirectHarness, CodexDirectHarness
from .ledger import SpawnLedger, SpawnRecord
from .registry import AGENT_REGISTRY, AgentSpec, Transport, get_spec, list_specs

__all__ = [
    "AGENT_REGISTRY",
    "ALLOW_ALWAYS",
    "ALLOW_ONCE",
    "DENY",
    "AcpHarness",
    "AgentEvent",
    "AgentHarness",
    "AgentSpec",
    "AvailabilityInfo",
    "ClaudeDirectHarness",
    "CodexDirectHarness",
    "EventKind",
    "LineChannel",
    "PermissionCallback",
    "ScriptedLineChannel",
    "SpawnLedger",
    "SpawnRecord",
    "SubprocessLineChannel",
    "Transport",
    "default_deny_permission",
    "get_spec",
    "harness_for",
    "list_specs",
    "probe_all",
]
