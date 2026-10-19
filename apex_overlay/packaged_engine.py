"""hc-954: an installed APEX Desktop engine is a verified bundle, never a frontend build tree.

APEX Desktop installs its engine into ``HERMES_HOME/versions/<key>`` and re-hashes it against
``.runtime/files.tsv`` at every launch; an update keeps the previous tree for rollback. The engine
CLI still treated that tree as a source checkout. ``hermes --tui`` (Desktop's "open in terminal")
and ``hermes dashboard`` had PM download its own CPython, uv and Node (346 MB into
``HERMES_HOME/tools``), then ran ``npm ci`` and the frontend compilers inside the installed tree.
Probed on the 0.17.59 engine: a successful run rewrote 8 indexed files (every later launch failed
verification) and added 14,290 files; with the npm registry unreachable, ``npm ci`` deleted
15,577 entries before failing; offline, the TUI never opened.

The bundle ships the built TUI (``hermes_cli/tui_dist``, the layout of upstream's sealed payloads)
and its own Node. From the engine's own bundle manifest this module provides:

- ``bundled_node``: the Node the shipped TUI runs on, so PM never downloads one;
- ``build_refusal``: why a frontend build must not start, before PM acquires npm or anything is written.

``hermes_cli/main_tui_launch.py`` and ``hermes_cli/source_build.py`` call these through one hook
each, tolerating a tree without this package. A plugin ``apply()`` cannot arm them in time:
built-in subcommands skip plugin discovery, and ``hermes dashboard`` builds before it runs.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

BUNDLE_MANIFEST = ".bundle-manifest.json"
BUNDLE_KIND = "apexnodes-runtime-bundle"


def bundle_manifest(root: Path) -> dict | None:
    """The APEX engine bundle manifest at ``root``; ``None`` for any other install kind."""
    try:
        data = json.loads((Path(root) / BUNDLE_MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("kind") == BUNDLE_KIND else None


def bundled_node(root: Path) -> str | None:
    """The engine's own Node executable, resolved like Desktop's ``bundledNodeExe``."""
    manifest = bundle_manifest(root)
    if manifest is None:
        return None
    node_dir = ((manifest.get("components") or {}).get("node") or {}).get("path")
    if not isinstance(node_dir, str) or not node_dir:
        return None
    tail = ("node.exe",) if manifest.get("os") == "win" else ("bin", "node")
    executable = Path(root, *node_dir.split("/"), *tail)
    return str(executable) if executable.is_file() and os.access(executable, os.X_OK) else None


def build_refusal(root: Path) -> str | None:
    """Why no frontend build (PM's npm, ``npm ci``, a compiler) may run for ``root``; ``None`` if it may."""
    if bundle_manifest(root) is None:
        return None
    return (
        f"{root} is an engine installed by APEX Desktop. Hermes does not build frontends inside it: "
        "npm ci and the compilers would rewrite files Desktop verifies at every launch, and they "
        "need the network. `hermes --tui` runs the TUI shipped with the engine; the web dashboard, "
        "`hermes --tui --dev` and `hermes desktop` need a Hermes source checkout."
    )
