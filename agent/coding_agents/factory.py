"""Resolve a coding-agent family into a ready-to-drive harness.

The registry row's ``transport`` selects the harness class; the caller never
picks a protocol by hand. This is the one place that maps
``Transport -> harness class``.
"""

from __future__ import annotations

import os
from typing import Callable

from .channel import LineChannel
from .direct import ClaudeDirectHarness, CodexDirectHarness
from .events import AvailabilityInfo
from .harness import AgentHarness, AcpHarness, PermissionCallback
from .ledger import SpawnLedger
from .registry import Transport, get_spec, list_specs

_HARNESS_BY_TRANSPORT: dict[Transport, type[AgentHarness]] = {
    Transport.ACP: AcpHarness,
    Transport.CLAUDE_STREAM_JSON: ClaudeDirectHarness,
    Transport.CODEX_APP_SERVER: CodexDirectHarness,
}


def harness_for(
    family: str,
    cwd: str | os.PathLike[str] | None = None,
    *,
    ledger: SpawnLedger | None = None,
    permission_callback: PermissionCallback | None = None,
    channel_factory: Callable[[], LineChannel] | None = None,
    turn_timeout: float = 900.0,
) -> AgentHarness:
    """Build the harness for ``family`` (e.g. ``"claude"``, ``"codex"``, ``"cursor"``)."""
    spec = get_spec(family)
    cls = _HARNESS_BY_TRANSPORT[spec.transport]
    return cls(
        spec,
        cwd,
        ledger=ledger,
        permission_callback=permission_callback,
        channel_factory=channel_factory,
        turn_timeout=turn_timeout,
    )


def probe_all(*, launchable_only: bool = True) -> dict[str, AvailabilityInfo]:
    """Probe availability of every (launchable) family. Never raises."""
    out: dict[str, AvailabilityInfo] = {}
    for spec in list_specs(launchable_only=launchable_only):
        cls = _HARNESS_BY_TRANSPORT[spec.transport]
        try:
            out[spec.id] = cls(spec).availability()
        except Exception as exc:  # availability must degrade, never explode
            out[spec.id] = AvailabilityInfo(
                family=spec.id, installed=False, command=spec.command, detail=f"probe error: {exc}"
            )
    return out
