"""Another connection's last close removes state.db-wal/-shm while a SessionDB opens.

SQLite checkpoints the WAL, unlinks -wal/-shm and only then closes their descriptors. Besides the
writability preflight (test_hermes_state_readonly_preflight.py), an opener racing that close failed
in two places: the pre-connect retired-generation scan took the closing connection for a holder
(false FATAL), and the sidecar chmod hit the unlink (raw FileNotFoundError). Both made
test_concurrent_quarantine_no_clobber flaky (hc-1019).
"""

import os
from pathlib import Path

import pytest

import hermes_state
import hermes_state_dbfile
from hermes_state import DeletedWalGenerationError


@pytest.fixture
def scans(monkeypatch):
    """Scripted results of successive holder scans, with no real pause between the two looks."""
    script: list[list[tuple[int, str]]] = []
    monkeypatch.setattr(hermes_state_dbfile, "_HOLDER_CONFIRM_SECONDS", 0)
    monkeypatch.setattr(hermes_state_dbfile, "iter_deleted_sqlite_sidecar_holders",
                        lambda _path: script.pop(0) if script else [])
    return script


def test_a_connection_closing_during_the_scan_is_not_a_holder(tmp_path, scans):
    wal = str(tmp_path / "state.db-wal")
    scans += [[(4242, wal)], []]  # first look lands between the unlink and the close; second: fd gone

    hermes_state_dbfile.refuse_deleted_wal_generation(tmp_path / "state.db")

    assert scans == [], "both looks must be taken"


def test_a_holder_still_there_on_the_second_look_is_refused(tmp_path, scans):
    wal = str(tmp_path / "state.db-wal")
    scans += [[(4242, wal)], [(4242, wal)]]

    with pytest.raises(DeletedWalGenerationError):
        hermes_state_dbfile.refuse_deleted_wal_generation(tmp_path / "state.db")


@pytest.mark.platforms("posix")  # the 0600 tightening is POSIX-only
@pytest.mark.parametrize("vanishing", ["state.db-wal", "state.db-shm"])
def test_sidecar_tightening_skips_a_sidecar_removed_after_its_lstat(tmp_path, monkeypatch, vanishing):
    names = ("state.db", "state.db-wal", "state.db-shm")
    db = tmp_path / "state.db"
    for name in names:
        (tmp_path / name).write_bytes(b"")
        os.chmod(tmp_path / name, 0o644)
    gone = tmp_path / vanishing
    real_chmod = os.chmod

    def close_lands_first(path, mode, *args, **kwargs):
        if Path(path) == gone:
            gone.unlink(missing_ok=True)
        return real_chmod(path, mode, *args, **kwargs)

    monkeypatch.setattr(hermes_state.os, "chmod", close_lands_first)
    hermes_state._secure_state_db_files(db)

    survivors = [tmp_path / name for name in names if name != vanishing]
    assert not gone.exists()
    assert {p.name: p.stat().st_mode & 0o777 for p in survivors} == {p.name: 0o600 for p in survivors}
