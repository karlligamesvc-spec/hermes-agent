"""Regression tests for hc-536 — the HERMES_HOME_MODE group-access contract.

Context
-------
The ApexNodes platform runs each agent's runtime in a container that drops
to an unprivileged UID but shares a GID with a host-side maintenance account
(state resync / media-lifecycle / backup jobs bind-mounting the same data
volume). ``_secure_dir`` chmods HERMES_HOME and its ``memories/`` and
``skills/`` subdirs to owner-only ``0700`` by default, which strips the group
traverse bit and breaks those host-side jobs with ``[Errno 13] Permission
denied`` (host resync/media_lifecycle logged ``Skipping unreadable`` in prod).

The durable, runtime-side fix is the upstream ``HERMES_HOME_MODE`` env knob:
the platform sets ``HERMES_HOME_MODE=0770`` in the container env so the shared
GID keeps read+traverse on the home root and its memory/skill dirs, while a
default (single-user) install keeps upstream owner-only ``0700`` semantics.

These tests lock that contract at the exact dirs the prod incident flagged —
the home root plus ``memories/`` and ``skills/`` — so a future upstream sync
that refactors the home-init path cannot silently reintroduce the hard-0700
regression without a red test.
"""
from __future__ import annotations

import stat
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

pytestmark = pytest.mark.skipif(
    sys.platform == "win32",
    reason="POSIX directory mode bits; chmod is a no-op on Windows",
)


def _mode(p: Path) -> int:
    return stat.S_IMODE(p.stat().st_mode)


class TestSecureDirMode:
    """Unit contract on ``_secure_dir`` itself (managed-mode detection and
    UID/GID chown are isolated out so only the mode logic is under test)."""

    def test_default_is_owner_only_0700(self, tmp_path, monkeypatch):
        monkeypatch.delenv("HERMES_HOME_MODE", raising=False)
        from hermes_cli import config as cfg

        d = tmp_path / "home"
        d.mkdir()
        d.chmod(0o755)  # start loose to prove _secure_dir tightens it
        with patch.object(cfg, "is_managed", return_value=False):
            cfg._secure_dir(d)
        assert _mode(d) == 0o700

    def test_knob_grants_group_access_0770(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME_MODE", "0770")
        from hermes_cli import config as cfg

        d = tmp_path / "home"
        d.mkdir()
        with patch.object(cfg, "is_managed", return_value=False):
            cfg._secure_dir(d)
        assert _mode(d) == 0o770

    def test_web_traversal_mode_0701_still_supported(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME_MODE", "0701")
        from hermes_cli import config as cfg

        d = tmp_path / "home"
        d.mkdir()
        with patch.object(cfg, "is_managed", return_value=False):
            cfg._secure_dir(d)
        assert _mode(d) == 0o701

    def test_mode_without_leading_zero_parses_as_octal(self, tmp_path, monkeypatch):
        # int(mode_str, 8) — "770" and "0770" both mean 0o770, not decimal 770.
        monkeypatch.setenv("HERMES_HOME_MODE", "770")
        from hermes_cli import config as cfg

        d = tmp_path / "home"
        d.mkdir()
        with patch.object(cfg, "is_managed", return_value=False):
            cfg._secure_dir(d)
        assert _mode(d) == 0o770

    def test_invalid_mode_falls_back_to_owner_only(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME_MODE", "not-octal")
        from hermes_cli import config as cfg

        d = tmp_path / "home"
        d.mkdir()
        d.chmod(0o755)
        with patch.object(cfg, "is_managed", return_value=False):
            cfg._secure_dir(d)
        assert _mode(d) == 0o700

    def test_managed_mode_leaves_perms_to_activation_script(self, tmp_path, monkeypatch):
        # In managed (NixOS) mode the activation script owns permissions, so
        # _secure_dir must not touch them even when the knob is set.
        monkeypatch.setenv("HERMES_HOME_MODE", "0770")
        from hermes_cli import config as cfg

        d = tmp_path / "home"
        d.mkdir()
        d.chmod(0o750)
        with patch.object(cfg, "is_managed", return_value=True):
            cfg._secure_dir(d)
        assert _mode(d) == 0o750  # untouched


class TestEnsureHermesHomeMode:
    """End-to-end: the knob reaches the exact dirs the prod incident flagged —
    the home root and its ``memories/`` and ``skills/`` subdirs."""

    def _run(self, home: Path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(home))
        monkeypatch.delenv("HERMES_UID", raising=False)
        monkeypatch.delenv("HERMES_GID", raising=False)
        from hermes_cli import config as cfg

        # Isolate from host managed-mode detection (~/.hermes/.managed or a
        # HERMES_MANAGED shell export) so the mode contract is deterministic.
        with patch.object(cfg, "is_managed", return_value=False):
            cfg.ensure_hermes_home()

    def test_knob_opens_group_access_on_home_memories_skills(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME_MODE", "0770")
        home = tmp_path / "hh"
        self._run(home, monkeypatch)
        assert _mode(home) == 0o770
        assert _mode(home / "memories") == 0o770
        assert _mode(home / "skills") == 0o770

    def test_default_keeps_owner_only_on_home_memories_skills(self, tmp_path, monkeypatch):
        monkeypatch.delenv("HERMES_HOME_MODE", raising=False)
        home = tmp_path / "hh"
        self._run(home, monkeypatch)
        assert _mode(home) == 0o700
        assert _mode(home / "memories") == 0o700
        assert _mode(home / "skills") == 0o700
