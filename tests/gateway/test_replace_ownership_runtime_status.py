"""hc-1031: ``--replace`` ownership when ``gateway.pid`` is gone but the gateway still runs.

A gateway writes the same identity (pid, kind, argv, start_time, hermes_home) into this home's
``gateway_state.json``. APEX Desktop restarts left gateways behind whose ``gateway.pid`` had
vanished, and every later ``gateway run --replace`` refused them and exited 1 for weeks. The
runtime-status record now stands in for a missing or mismatched PID file. It is held to the same
checks: this PID, this live start time, this HERMES_HOME, and a gateway-shaped record.
"""

from __future__ import annotations

from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import pytest

TARGET = 424242
START = 111222333


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    return hermes_home


def _record(home, pid=TARGET, start=START, **extra):
    return {
        "pid": pid,
        "kind": "hermes-gateway",
        "argv": ["python", "-m", "hermes_cli.main", "gateway", "run"],
        "start_time": start,
        "hermes_home": str(home),
        **extra,
    }


def _refused(home, *, pid_record, runtime, live_start=START):
    from gateway.run import _replace_target_belongs_to_other_profile

    with ExitStack() as stack:
        stack.enter_context(patch("gateway.status._read_pid_record", return_value=pid_record))
        stack.enter_context(patch("gateway.status._get_pid_path", return_value=home / "gateway.pid"))
        stack.enter_context(patch("gateway.status.read_runtime_status", return_value=runtime))
        stack.enter_context(patch("gateway.status._get_process_start_time", return_value=live_start))
        stack.enter_context(patch("gateway.status._read_process_cmdline", return_value=None))
        stack.enter_context(patch("gateway.status._get_process_hermes_home", return_value=home))
        return _replace_target_belongs_to_other_profile(TARGET)


@pytest.mark.parametrize(
    ("pid_record", "runtime", "live_start", "refused"),
    [
        pytest.param(None, "same", START, False, id="pid file gone, runtime status names the live target"),
        pytest.param("other-pid", "same", START, False, id="pid file names another life, runtime status the target"),
        pytest.param(None, None, START, True, id="pid file gone, no runtime status"),
        pytest.param(None, "other-pid", START, True, id="pid file gone, runtime status names another pid"),
        pytest.param(None, "other-home", START, True, id="pid file gone, runtime status from another home"),
        pytest.param(None, "same", 42, True, id="pid file gone, runtime status start time stale (PID reuse)"),
        pytest.param(None, "not-gateway", START, True, id="pid file gone, runtime status not a gateway record"),
    ],
)
def test_runtime_status_stands_in_for_a_missing_pid_file(home, pid_record, runtime, live_start, refused):
    records = {
        None: None,
        "same": _record(home, gateway_state="running"),
        "other-pid": _record(home, pid=999999),
        "other-home": _record(home.parent / "elsewhere"),
        "not-gateway": {**_record(home), "kind": "something-else"},
    }

    assert _refused(home, pid_record=records[pid_record], runtime=records[runtime], live_start=live_start) is refused


def test_a_matching_pid_file_stays_the_primary_record(home):
    """A PID file that names the target is used even when the runtime status disagrees."""
    assert _refused(home, pid_record=_record(home), runtime=_record(home.parent / "elsewhere")) is False
    assert _refused(home, pid_record=_record(home.parent / "elsewhere"), runtime=_record(home)) is True
