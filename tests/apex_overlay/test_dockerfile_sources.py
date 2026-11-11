"""ApexNodes hc-1203: every file the cloud image build reads from this checkout exists here.

apex-nodes builds the cloud image with a plain ``docker build`` of this Dockerfile
(``scripts/build_native_agent_image.sh``), and the fork runs no image build in CI. Upstream's
Dockerfile can name files only upstream's tree carries: v0.23.0's Webapp stage copied and ran
``apps/desktop/scripts/build-webapp.mjs``, which the APEX Desktop baseline does not have, so the
first image build after the merge would have failed at that step while every check stayed green.

This reads the Dockerfile the way the build does: each COPY/ADD source taken from the build context
(not ``--from`` another stage) and each repo script a RUN step starts must exist in the checkout.
"""
from __future__ import annotations

import json
import re
import shlex
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DOCKERFILE = REPO / "Dockerfile"
# A RUN step that starts a script from the repo copy: `node scripts/build/tui.mjs`, `python3 docker/x.py`.
_RUN_SCRIPT = re.compile(r"\b(?:node|python3?|bash|sh)\s+((?:apps|docker|plugins|scripts|tools|hermes_cli)/[\w./-]+)")


def _instructions(text: str) -> list[tuple[int, str, str]]:
    """``(line, keyword, arguments)`` per instruction: comments dropped, continuations joined."""
    out: list[tuple[int, str, str]] = []
    pending, start = "", 0
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not pending and (not line or line.startswith("#")):
            continue
        if pending and line.startswith("#"):
            continue  # a comment inside a continued instruction
        if not pending:
            start = number
        if line.endswith("\\"):
            pending += line[:-1] + " "
            continue
        keyword, _, args = (pending + line).strip().partition(" ")
        out.append((start, keyword.upper(), args.strip()))
        pending = ""
    return out


def _context_sources(args: str) -> list[str]:
    """The build-context paths a COPY/ADD reads; empty when it copies from a stage or image."""
    if args.startswith("["):
        words = json.loads(args)
    else:
        words = shlex.split(args)
    flags = [w for w in words if w.startswith("--")]
    if any(f.startswith("--from=") for f in flags):
        return []
    operands = [w for w in words if not w.startswith("--")]
    return [s for s in operands[:-1] if not s.startswith("<<")]


def _exists(source: str) -> bool:
    source = source.rstrip("/") or "."
    if any(ch in source for ch in "*?["):
        return any(REPO.glob(source))
    return (REPO / source).exists()


def _missing() -> tuple[list[str], int, int]:
    missing: list[str] = []
    copies = runs = 0
    for line, keyword, args in _instructions(DOCKERFILE.read_text(encoding="utf-8")):
        if keyword in {"COPY", "ADD"}:
            for source in _context_sources(args):
                copies += 1
                if not _exists(source):
                    missing.append(f"Dockerfile:{line} {keyword} {source}")
        elif keyword == "RUN":
            for script in _RUN_SCRIPT.findall(args):
                runs += 1
                if not (REPO / script).is_file():
                    missing.append(f"Dockerfile:{line} RUN {script}")
    return missing, copies, runs


def test_every_build_context_file_the_image_reads_exists_in_this_fork():
    missing, copies, runs = _missing()
    # The parse reached the real build: the payload, frontend and s6 stages copy dozens of paths and
    # run the repo's own build scripts.
    assert copies >= 25 and runs >= 3, (copies, runs)
    assert missing == [], "the cloud image build would fail at:\n" + "\n".join(missing)


def test_the_image_ships_no_webapp_stage():
    """The Webapp builds from upstream's apps/desktop. Once APEX ports a Webapp recipe, this test and
    the Dockerfile note both go: the stage can come back with the recipe it needs."""
    text = DOCKERFILE.read_text(encoding="utf-8")
    assert not (REPO / "apps/desktop/scripts/build-webapp.mjs").exists()
    assert not re.search(r"(?m)^\s*FROM\s+\S+\s+AS\s+webapp_build\b", text)
    assert "--from=webapp_build" not in text
