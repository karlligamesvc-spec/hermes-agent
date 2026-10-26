"""Which persisted record may prove ``--replace`` ownership of a live gateway (hc-1031).

``gateway.pid`` is the primary identity record. A gateway also writes the same identity fields
(pid, kind, argv, start_time, hermes_home) into this home's ``gateway_state.json``. When
``gateway.pid`` is gone, or names another gateway life, while that gateway still runs, the
runtime-status record stands in for it. APEX Desktop restarts left such gateways behind for weeks:
every later ``gateway run --replace`` refused them and exited 1.

The caller holds whichever record is returned to exactly the same checks: it must name this PID,
with this live start time and this HERMES_HOME, and the live argv must not contradict it.
"""

from __future__ import annotations

from typing import Any, Optional


def replace_identity_record(existing_pid: int) -> Optional[dict[str, Any]]:
    """``gateway.pid`` when it names ``existing_pid``, else ``gateway_state.json`` when that does,
    else ``gateway.pid`` as read, so the caller's refusal still describes the PID file."""
    from gateway.status import (
        _get_pid_path, _pid_from_record, _read_pid_record, _record_looks_like_gateway, read_runtime_status)

    pid_record = _read_pid_record(_get_pid_path())
    for record in (pid_record, read_runtime_status()):
        if isinstance(record, dict) and _record_looks_like_gateway(record) and _pid_from_record(record) == existing_pid:
            return record
    return pid_record
