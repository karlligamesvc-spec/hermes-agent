"""hc-544: user-level bin-dir PATH augmentation for GUI-launched spawns.

A macOS app launched from Finder/Dock/launchd inherits a minimal PATH that omits
``~/.local/bin`` (the ``claude`` / ``codex`` install target), nvm/volta shims, and
Homebrew. A subprocess spawned with that PATH can't find the user's coding-agent
CLI, and ``shutil.which`` reports it missing. These tests pin the deterministic
augmentation contract: existence-filtered, de-duplicated, order-preserving,
appended (never prepended), POSIX-only.

All cases inject ``home`` / ``isdir`` / ``listdir`` so the selection is fully
deterministic and independent of the runner's filesystem.
"""

from __future__ import annotations

import os

import pytest

from tools.environments import local as L


def _fs(existing: set[str], node_versions: dict[str, list[str]] | None = None):
    """Build injectable isdir/listdir over a fake filesystem set."""
    node_versions = node_versions or {}

    def isdir(path: str) -> bool:
        return path in existing

    def listdir(path: str) -> list[str]:
        if path in node_versions:
            return node_versions[path]
        raise OSError(f"no such dir: {path}")

    return isdir, listdir


# --------------------------------------------------------------------------- #
# _node_version_sort_key
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize(
    "name,expected",
    [
        ("v18.17.1", (18, 17, 1)),
        ("v20.3.0", (20, 3, 0)),
        ("v20", (20, 0, 0)),
        ("18.9", (18, 9, 0)),
        ("v0.12.18", (0, 12, 18)),
        ("garbage", (-1, -1, -1)),
        ("", (-1, -1, -1)),
    ],
)
def test_node_version_sort_key(name, expected):
    assert L._node_version_sort_key(name) == expected


def test_node_version_sort_key_orders_correctly():
    # The whole point: max() over the keys picks the newest node.
    names = ["v18.17.1", "v20.3.0", "v16.0.0", "junk"]
    best = max(names, key=L._node_version_sort_key)
    assert best == "v20.3.0"


# --------------------------------------------------------------------------- #
# _nvm_current_bin_dir
# --------------------------------------------------------------------------- #

def test_nvm_prefers_active_nvm_bin_env():
    active = "/home/u/.nvm/versions/node/v18.17.1/bin"
    isdir, listdir = _fs({active})
    got = L._nvm_current_bin_dir(
        "/home/u", {"NVM_BIN": active}, isdir=isdir, listdir=listdir
    )
    assert got == active


def test_nvm_ignores_stale_nvm_bin_that_no_longer_exists():
    # $NVM_BIN points at an uninstalled version → fall through to the glob.
    installed = "/home/u/.nvm/versions/node/v20.3.0/bin"
    isdir, listdir = _fs(
        {installed}, {"/home/u/.nvm/versions/node": ["v20.3.0"]}
    )
    got = L._nvm_current_bin_dir(
        "/home/u",
        {"NVM_BIN": "/home/u/.nvm/versions/node/v99.0.0/bin"},
        isdir=isdir,
        listdir=listdir,
    )
    assert got == installed


def test_nvm_picks_highest_installed_node():
    root = "/home/u/.nvm/versions/node"
    isdir, listdir = _fs(
        {f"{root}/v18.17.1/bin", f"{root}/v20.3.0/bin", f"{root}/v16.0.0/bin"},
        {root: ["v18.17.1", "v20.3.0", "v16.0.0"]},
    )
    got = L._nvm_current_bin_dir("/home/u", {}, isdir=isdir, listdir=listdir)
    assert got == f"{root}/v20.3.0/bin"


def test_nvm_skips_version_dirs_without_a_bin():
    root = "/home/u/.nvm/versions/node"
    # v21 is listed but has no bin subdir on disk (partial/broken install).
    isdir, listdir = _fs(
        {f"{root}/v20.3.0/bin"},
        {root: ["v20.3.0", "v21.0.0"]},
    )
    got = L._nvm_current_bin_dir("/home/u", {}, isdir=isdir, listdir=listdir)
    assert got == f"{root}/v20.3.0/bin"


def test_nvm_absent_returns_none():
    isdir, listdir = _fs(set())
    assert L._nvm_current_bin_dir("/home/u", {}, isdir=isdir, listdir=listdir) is None


# --------------------------------------------------------------------------- #
# _augment_path_with_user_bins
# --------------------------------------------------------------------------- #

def test_augment_appends_existing_user_bins_in_priority_order(monkeypatch):
    monkeypatch.setattr(L, "_IS_WINDOWS", False)
    root = "/home/u/.nvm/versions/node"
    isdir, listdir = _fs(
        {
            "/home/u/.local/bin",
            "/home/u/bin",
            "/opt/homebrew/bin",
            f"{root}/v20.3.0/bin",
        },
        {root: ["v20.3.0"]},
    )
    out = L._augment_path_with_user_bins(
        "/usr/bin:/bin", home="/home/u", env={}, isdir=isdir, listdir=listdir
    )
    assert out.split(":") == [
        "/usr/bin",
        "/bin",
        "/home/u/.local/bin",
        "/home/u/bin",
        "/opt/homebrew/bin",
        f"{root}/v20.3.0/bin",
    ]


def test_augment_filters_nonexistent_dirs(monkeypatch):
    monkeypatch.setattr(L, "_IS_WINDOWS", False)
    isdir, listdir = _fs({"/home/u/.local/bin"})  # only this one exists
    out = L._augment_path_with_user_bins(
        "/usr/bin", home="/home/u", env={}, isdir=isdir, listdir=listdir
    )
    assert out == "/usr/bin:/home/u/.local/bin"


def test_augment_does_not_duplicate_already_present_dir(monkeypatch):
    monkeypatch.setattr(L, "_IS_WINDOWS", False)
    isdir, listdir = _fs({"/opt/homebrew/bin", "/home/u/.local/bin"})
    out = L._augment_path_with_user_bins(
        "/opt/homebrew/bin:/usr/bin",
        home="/home/u",
        env={},
        isdir=isdir,
        listdir=listdir,
    )
    entries = out.split(":")
    assert entries.count("/opt/homebrew/bin") == 1
    # Existing entry keeps its leading position; the new dir is appended.
    assert entries[0] == "/opt/homebrew/bin"
    assert entries[-1] == "/home/u/.local/bin"


def test_augment_from_empty_path(monkeypatch):
    monkeypatch.setattr(L, "_IS_WINDOWS", False)
    isdir, listdir = _fs({"/home/u/.local/bin", "/usr/local/bin"})
    out = L._augment_path_with_user_bins(
        "", home="/home/u", env={}, isdir=isdir, listdir=listdir
    )
    assert out == "/home/u/.local/bin:/usr/local/bin"


def test_augment_is_windows_noop(monkeypatch):
    monkeypatch.setattr(L, "_IS_WINDOWS", True)
    # Even if every candidate "exists", Windows returns the PATH untouched.
    out = L._augment_path_with_user_bins(
        "C:\\Windows;C:\\Windows\\System32",
        home="C:\\Users\\u",
        env={},
        isdir=lambda _p: True,
    )
    assert out == "C:\\Windows;C:\\Windows\\System32"


def test_augment_empty_home_is_noop(monkeypatch):
    monkeypatch.setattr(L, "_IS_WINDOWS", False)
    # /opt/homebrew and /usr/local are home-independent, but with no home the
    # candidate list is empty by contract (no real account → nothing to add).
    isdir, listdir = _fs({"/opt/homebrew/bin"})
    out = L._augment_path_with_user_bins(
        "/usr/bin", home="", env={}, isdir=isdir, listdir=listdir
    )
    assert out == "/usr/bin"


def test_augment_is_idempotent(monkeypatch):
    monkeypatch.setattr(L, "_IS_WINDOWS", False)
    isdir, listdir = _fs({"/home/u/.local/bin", "/opt/homebrew/bin"})
    once = L._augment_path_with_user_bins(
        "/usr/bin", home="/home/u", env={}, isdir=isdir, listdir=listdir
    )
    twice = L._augment_path_with_user_bins(
        once, home="/home/u", env={}, isdir=isdir, listdir=listdir
    )
    assert once == twice


# --------------------------------------------------------------------------- #
# augmented_user_path — reads current PATH + real home
# --------------------------------------------------------------------------- #

def test_augmented_user_path_uses_current_env(monkeypatch):
    monkeypatch.setattr(L, "_IS_WINDOWS", False)
    # Only ~/.local/bin under the resolved real home "exists"; nvm glob raises
    # OSError (no such dir) and is skipped, so the result is deterministic.
    monkeypatch.setattr(L.os.path, "isdir", lambda p: p == "/home/real/.local/bin")
    # get_real_home is imported lazily inside augmented_user_path — patch it at
    # its source module so the lazy import resolves to the stub.
    import hermes_constants

    monkeypatch.setattr(hermes_constants, "get_real_home", lambda env=None: "/home/real")
    out = L.augmented_user_path(env={"PATH": "/usr/bin:/bin", "HOME": "/home/real"})
    assert out == "/usr/bin:/bin:/home/real/.local/bin"
