"""hc-1219 Where 剪映专业版 (JianyingPro) lives on this computer, and whether it has taken in a draft.

Read only, nothing here writes: the app and its version (macOS ``Info.plist`` of ``com.lemon.lvpro``; on Windows
the ``Apps`` folder under ``%LOCALAPPDATA%\\JianyingPro``), the draft folder the user chose (``currentCustomDraftPath``
in ``User Data/Config/globalSetting``) and 剪映's own plaintext list of the drafts it knows, ``root_meta_info.json``.

剪映's other files are never read: once a draft has been open in 剪映, ``draft_info.json`` and
``draft_meta_info.json`` are no longer JSON, and APEX does not try to read them back.
"""

from __future__ import annotations

import json
import os
import plistlib
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional

BUNDLE_ID = "com.lemon.lvpro"
MAC_APP_NAME = "VideoFusion-macOS.app"
WINDOWS_EXE = "JianyingPro.exe"
SETTING_KEY = "currentCustomDraftPath"
ROOT_META = "root_meta_info.json"
#: The folder 剪映 uses when the user never chose one, under its User Data.
DEFAULT_DRAFTS = Path("Projects") / "com.lveditor.draft"
_VERSION_DIR = re.compile(r"^\d+(?:\.\d+){1,3}$")
_QT_ESCAPE = re.compile(r"\\(x[0-9a-fA-F]{1,4}|.)")


@dataclass(frozen=True)
class Installation:
    app: Path
    version: str
    user_data: Path
    draft_root: Optional[Path]


def _mac_app(folders: tuple[Path, ...]) -> Optional[tuple[Path, str]]:
    for folder in folders:
        app = folder / MAC_APP_NAME
        try:
            with (app / "Contents" / "Info.plist").open("rb") as handle:
                info = plistlib.load(handle)
        except (OSError, plistlib.InvalidFileException, ValueError):
            continue
        if isinstance(info, dict) and info.get("CFBundleIdentifier") == BUNDLE_ID:
            return app, str(info.get("CFBundleShortVersionString") or info.get("CFBundleVersion") or "")
    return None


def _version_key(name: str) -> tuple[int, ...]:
    return tuple(int(part) for part in name.split("."))


def _windows_app(local_app_data: Path) -> Optional[tuple[Path, str]]:
    apps = local_app_data / "JianyingPro" / "Apps"
    launcher = apps / WINDOWS_EXE
    if not launcher.is_file():
        return None
    try:
        versions = [entry.name for entry in apps.iterdir() if entry.is_dir() and _VERSION_DIR.match(entry.name)]
    except OSError:
        versions = []
    return launcher, max(versions, key=_version_key) if versions else ""


def unescape_setting(value: str) -> str:
    """Qt's INI escapes: ``\\xHHHH`` for a character outside ASCII, a backslash before ``\\`` and ``"``."""

    def one(match: re.Match) -> str:
        token = match.group(1)
        if token[0] == "x" and len(token) > 1:
            return chr(int(token[1:], 16))
        return {"n": "\n", "t": "\t", "r": "\r", "0": "\0"}.get(token, token)

    return _QT_ESCAPE.sub(one, value)


def draft_root_from_setting(text: str) -> Optional[str]:
    """The draft folder named in globalSetting's ``currentCustomDraftPath=`` line, or None."""
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if not sep or key.strip() != SETTING_KEY:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] == '"':
            value = value[1:-1]
        return unescape_setting(value).strip() or None
    return None


def _draft_root(user_data: Path) -> Optional[Path]:
    try:
        text = (user_data / "Config" / "globalSetting").read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    named = draft_root_from_setting(text)
    for candidate in ([Path(named)] if named else []) + [user_data / DEFAULT_DRAFTS]:
        if candidate.is_dir():
            return candidate
    return None


def find(env: Mapping[str, str] = os.environ, platform: str = sys.platform, home: Optional[Path] = None,
         app_folders: Optional[tuple[Path, ...]] = None) -> Optional[Installation]:
    """剪映 on this computer, or None. ``draft_root`` is None until 剪映 has made its draft folder (first start)."""
    home = home or Path.home()
    if platform == "darwin":
        found = _mac_app(app_folders or (Path("/Applications"), home / "Applications"))
        user_data = home / "Movies" / "JianyingPro" / "User Data"
    elif platform == "win32" and env.get("LOCALAPPDATA"):
        local = Path(env["LOCALAPPDATA"])
        found = _windows_app(local)
        user_data = local / "JianyingPro" / "User Data"
    else:
        return None
    if found is None:
        return None
    app, version = found
    return Installation(app=app, version=version, user_data=user_data, draft_root=_draft_root(user_data))


def running(platform: str = sys.platform) -> bool:
    """Is 剪映 open now. Only then does it take in a new draft within seconds; otherwise at its next start."""
    if platform == "darwin":
        command = ["pgrep", "-f", f"/{MAC_APP_NAME}/Contents/MacOS/"]
    elif platform == "win32":
        command = ["tasklist", "/FI", f"IMAGENAME eq {WINDOWS_EXE}", "/NH", "/FO", "CSV"]
    else:
        return False
    flags = 0x08000000 if platform == "win32" else 0  # CREATE_NO_WINDOW
    try:
        done = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                              errors="replace", timeout=5, creationflags=flags, check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    if platform == "win32":
        return WINDOWS_EXE.lower() in done.stdout.lower()
    return done.returncode == 0 and bool(done.stdout.strip())


def _same_path(a: str, b: Path) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(str(b)))


def _entries(root: Path) -> list:
    try:
        listed = json.loads((root / ROOT_META).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    entries = listed.get("all_draft_store") if isinstance(listed, dict) else None
    return [entry for entry in entries if isinstance(entry, dict)] if isinstance(entries, list) else []


def listed_names(root: Path) -> set[str]:
    """Folder names 剪映 lists under ``root``. It keeps the entries of drafts whose folders are gone."""
    return {os.path.basename(os.path.normpath(str(entry.get("draft_fold_path") or ""))) for entry in _entries(root)}


def registration(draft_dir: Path) -> Optional[dict]:
    """剪映's entry for ``draft_dir`` in its plaintext ``root_meta_info.json``, or None when it has none (yet).

    Judge the entry by what it says: ``draft_json_file`` must exist and ``tm_duration`` (microseconds) must be above
    0. A timeline under the old file name, or a draft_meta_info.json without the duration, shows 00:00 on 剪映's
    home page; the old name also opens to nothing, with no message (report 2026-11-05 §4; measured 2026-11-11).
    """
    for entry in _entries(draft_dir.parent):
        if _same_path(str(entry.get("draft_fold_path") or ""), draft_dir):
            timeline = str(entry.get("draft_json_file") or "")
            duration = entry.get("tm_duration")
            return {
                "timeline_exists": bool(timeline) and Path(timeline).is_file(),
                "duration_us": duration if isinstance(duration, int) else 0,
            }
    return None
