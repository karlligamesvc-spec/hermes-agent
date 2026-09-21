"""
Hermes Desktop (Chat GUI) uninstaller.

The desktop GUI ships in two shapes and this module knows how to find and
remove the artifacts of both, on Linux, macOS, and Windows, WITHOUT touching
the Python agent or the user's config/data:

  1. Source-built GUI (``hermes desktop`` / ``hermes gui``)
     Built inside the agent checkout under ``$HERMES_HOME/hermes-agent/``:
       - ``apps/desktop/dist``      (compiled renderer)
       - ``apps/desktop/release``   (electron-builder unpacked app + installers)
       - ``apps/desktop/node_modules`` and the workspace-root ``node_modules``
         (Electron itself, ~200MB) — only removed on a GUI uninstall because
         the agent does not need them.
       - ``$HERMES_HOME/desktop-build-stamp.json`` (the build freshness stamp)

  2. Packaged distributable (DMG / NSIS / AppImage / deb / rpm)
     Installed by the OS to a standard application location and carrying its
     own bundled Electron + a per-user Electron ``userData`` directory:
       - macOS:   ``/Applications/APEX.app`` (plus legacy Hermes.app)
       - Windows: ``%LOCALAPPDATA%\\Programs\\APEX`` (plus legacy Hermes)
       - Linux:   ``~/.local/share/applications`` .desktop entry + AppImage

In both shapes the Electron runtime keeps a ``userData`` directory keyed on
the app name ("Hermes"), separate from ``$HERMES_HOME``:
  - macOS:   ``~/Library/Application Support/Hermes``
  - Windows: ``%APPDATA%\\Hermes``
  - Linux:   ``$XDG_CONFIG_HOME/Hermes`` (default ``~/.config/Hermes``)

This holds the desktop's own ``connection.json`` / ``updates.json`` and
Chromium cache — pure GUI state, safe to remove on a GUI uninstall.

The functions here are deliberately import-light and side-effect-free at
import time so the Electron main process can shell out to
``hermes uninstall --gui`` (and friends) without paying for the full CLI.
"""

import os
import shutil
import sys
from pathlib import Path

from hermes_constants import get_hermes_home

from hermes_cli.colors import Colors, color


def _logger(mark: str, col: str):
    return lambda msg: print(f"{color(mark, col)} {msg}")


log_info, log_success = _logger("→", Colors.CYAN), _logger("✓", Colors.GREEN)
log_warn = _logger("⚠", Colors.YELLOW)


def _env_dir(var: str, fallback: Path) -> Path:
    """``Path($var)`` when the env var is set, else *fallback*."""
    return Path(value) if (value := os.environ.get(var)) else fallback


def desktop_userdata_dir() -> Path:
    """Electron ``app.getPath('userData')`` for an app named "Hermes" on each platform (GUI-only state)."""
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "Hermes"
    if sys.platform == "win32":
        return _env_dir("APPDATA", home / "AppData" / "Roaming") / "Hermes"
    return _env_dir("XDG_CONFIG_HOME", home / ".config") / "Hermes"


def source_built_gui_artifacts(hermes_home: Path) -> "list[Path]":
    """GUI build artifacts produced by ``hermes desktop`` inside the checkout (same ``hermes-agent/`` layout
    install.sh uses). The Python agent runs from source + venv and never needs the Electron build output or
    node_modules (the workspace-root node_modules only carries Electron, ~200MB)."""
    agent_root = hermes_home / "hermes-agent"
    desktop_dir = agent_root / "apps" / "desktop"
    return [desktop_dir / "dist", desktop_dir / "release", desktop_dir / "node_modules",
            agent_root / "node_modules", hermes_home / "desktop-build-stamp.json"]


def packaged_gui_app_paths() -> "list[Path]":
    """Standard install locations of the packaged desktop distributable.

    Returns every candidate for the current OS; the caller filters to those
    that actually exist. We never glob system-wide — only the well-known
    electron-builder output locations for the current "APEX" product plus
    legacy Hermes/ApexNodes builds that an upgrade may still need to remove.
    """
    home = Path.home()
    paths: list[Path] = []
    if sys.platform == "darwin":
        paths += [
            Path("/Applications/APEX.app"),
            home / "Applications" / "APEX.app",
            Path("/Applications/Hermes.app"),
            home / "Applications" / "Hermes.app",
        ]
    elif sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        local_base = Path(local) if local else (home / "AppData" / "Local")
        paths += [
            # NSIS per-user install (perMachine=false → Programs\<product>).
            local_base / "Programs" / "APEX",
            local_base / "Programs" / "ApexNodes",
            local_base / "Programs" / "Hermes",
            # Older / alternate layout some builds used.
            local_base / "hermes-desktop",
        ]
        program_files = os.environ.get("ProgramFiles")
        if program_files:
            # NSIS per-machine fallback (needs admin to remove).
            paths.append(Path(program_files) / "APEX")
            paths.append(Path(program_files) / "ApexNodes")
            paths.append(Path(program_files) / "Hermes")
    else:
        # Linux: AppImage is a single file the user placed somewhere; we can
        # only reliably clean the desktop entry + icon we know the name of.
        # The AppImage itself lives wherever the user put it, so we surface a
        # hint rather than guessing. deb/rpm installs are owned by the system
        # package manager and must be removed via apt/dnf — see the message in
        # ``uninstall_gui``.
        from hermes_cli.linux_desktop_entry import desktop_entry_path

        data = os.environ.get("XDG_DATA_HOME")
        data_base = Path(data) if data else (home / ".local" / "share")
        paths += [
            data_base / "applications" / "APEX.desktop",
            data_base / "applications" / "apex.desktop",
            # The launcher entry `hermes desktop` installs. Its icon is
            # also copied into the hicolor tree (see
            # linux_desktop_entry._install_icon_to_hicolor) — remove
            # every size dir the installer could have written.
            desktop_entry_path(),
            # Some packaged builds emit this casing.
            data_base / "applications" / "Hermes.desktop",
            data_base / "icons" / "hicolor" / "scalable" / "apps" / "hermes.png",
        ]
        # Fixed-size hicolor dirs: the icon is copied at its native size
        # (read from the PNG header), so sweep the standard ones plus the
        # 1024x1024 dir the shipped asset lands in.
        for size in ("256x256", "512x512", "1024x1024"):
            paths.append(data_base / "icons" / "hicolor" / size / "apps" / "hermes.png")
    return paths


def agent_is_installed(hermes_home: Path) -> bool:
    """True when a usable Python agent install exists under HERMES_HOME (gates the desktop UI's options).
    Package source or a venv alone is enough — a source checkout without a venv is still "the agent is here"."""
    return any((hermes_home / "hermes-agent" / sub).is_dir() for sub in ("hermes_cli", "venv", ".venv"))


def gui_is_installed(hermes_home: Path) -> bool:
    """Return True when any desktop GUI artifact exists (built or packaged)."""
    return any(p.exists() for p in (*source_built_gui_artifacts(hermes_home), *packaged_gui_app_paths(), desktop_userdata_dir()))


def gui_install_summary(hermes_home: "Path | None" = None) -> dict:
    """JSON-serializable snapshot of what's installed, for the desktop UI to render via IPC."""
    home: Path = hermes_home if hermes_home is not None else get_hermes_home()
    userdata = desktop_userdata_dir()
    return {"hermes_home": str(home), "agent_installed": agent_is_installed(home),
            "gui_installed": gui_is_installed(home),
            "source_built_artifacts": [str(p) for p in source_built_gui_artifacts(home) if p.exists()],
            "packaged_app_paths": [str(p) for p in packaged_gui_app_paths() if p.exists()],
            "userdata_dir": str(userdata), "userdata_exists": userdata.exists(), "platform": sys.platform}


def _remove_path(path: Path) -> bool:
    """Remove a file or directory tree. Returns True when something was removed."""
    try:
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
        else:
            return False
        return True
    except Exception as e:
        log_warn(f"Could not remove {path}: {e}")
        return False


def uninstall_gui(hermes_home: "Path | None" = None, *, remove_userdata: bool = True) -> "list[Path]":
    """Remove the desktop GUI's artifacts, leaving the agent + user data intact."""
    home: Path = hermes_home if hermes_home is not None else get_hermes_home()
    removed: list[Path] = []

    def _remove_existing(paths) -> bool:
        """Remove every existing path; True when at least one existed."""
        found = False
        for path in (p for p in paths if p.exists()):
            found = True
            if _remove_path(path):
                log_success(f"Removed {path}")
                removed.append(path)
        return found
    log_info("Removing built GUI artifacts (renderer, release, node_modules)...")
    _remove_existing(source_built_gui_artifacts(home))
    log_info("Removing installed desktop app...")
    if not _remove_existing(packaged_gui_app_paths()):
        log_info("No packaged desktop app found in standard locations")
    if remove_userdata and (userdata := desktop_userdata_dir()).exists():
        log_info("Removing desktop app data (Electron userData)...")
        _remove_existing([userdata])
    if not removed:
        log_info("No desktop GUI artifacts found to remove")
    if sys.platform.startswith("linux"):
        # The desktop entry was removed above but the menu caches still list it; reindex so Hermes
        # disappears from the launcher.
        try:
            from hermes_cli.linux_desktop_entry import desktop_entry_path, refresh_desktop_databases
            entry = desktop_entry_path()
            if entry in removed:
                for tool in refresh_desktop_databases(entry.parent):
                    log_success(f"Refreshed the application menu cache ({tool})")
        except Exception as e:
            log_warn(f"Could not refresh the application menu cache: {e}")
        log_info("If you installed the desktop via a .deb / .rpm package, remove it with your package manager "
                 "(e.g. 'sudo apt remove hermes' or 'sudo dnf remove hermes'). AppImage builds are a single "
                 "file you can delete from wherever you saved it.")
    return removed
