"""hc-1042: APEX Desktop swaps an untouched upstream SOUL.md for the APEX identity at boot.

The Desktop half (apps/desktop/electron/apex-default-soul.ts) recognizes upstream seeds by the sha256
of their normalized text. These tests hold the Python half to it: every text the engine, the docker
image or ``hermes doctor --fix`` can seed today must be in that table (an upstream sync that ships a new
default fails here until its hash is added), and the engine must never treat the APEX identity as a
seed of its own to "upgrade" back.
"""

import ast
import hashlib
import json
import re
from pathlib import Path

import pytest

from hermes_cli import default_soul
from hermes_cli.config import _ensure_default_soul_md

_REPO = Path(__file__).resolve().parents[2]
_DESKTOP = _REPO / "apps" / "desktop"
# Prettier drops the quotes from keys that happen to be identifiers (a0709bd1...), so quotes are optional.
_TABLE = set(
    re.findall(
        r"^\s*'?([0-9a-f]{64})'?:",
        (_DESKTOP / "electron" / "apex-default-soul.ts").read_text("utf-8"),
        re.MULTILINE,
    )
)
_FIXTURE = json.loads(
    (_DESKTOP / "electron" / "fixtures" / "upstream-souls.json").read_text("utf-8")
)["souls"]


def _digest(text: str) -> str:
    return hashlib.sha256(
        default_soul._normalize_soul(text).encode("utf-8")
    ).hexdigest()


def _doctor_fix_templates() -> list[str]:
    """Literal SOUL texts ``hermes doctor --fix`` writes (doctor_state.py ``soul_path.write_text("...")``)."""
    source = (_REPO / "hermes_cli" / "doctor_state.py").read_text("utf-8")
    return [
        node.args[0].value
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Call)
        and getattr(node.func, "attr", None) == "write_text"
        and "soul" in ast.unparse(node.func).lower()
        and node.args
        and isinstance(node.args[0], ast.Constant)
        and isinstance(node.args[0].value, str)
    ]


def _apex_identity() -> str:
    source = (_DESKTOP / "shared" / "apex-default-soul.ts").read_text("utf-8")
    return "".join(
        re.findall(r"'([^']*)'", source.split("APEX_DESKTOP_DEFAULT_SOUL =", 1)[1])
    )


_SEEDS = [
    ("DEFAULT_SOUL_MD", default_soul.DEFAULT_SOUL_MD),
    *[
        (f"_LEGACY_TEMPLATE_SOULS[{i}]", text)
        for i, text in enumerate(default_soul._LEGACY_TEMPLATE_SOULS)
    ],
    ("docker/SOUL.md", (_REPO / "docker" / "SOUL.md").read_text("utf-8")),
    *[(f"doctor --fix #{i}", text) for i, text in enumerate(_doctor_fix_templates())],
]


def test_every_seeder_was_found():
    assert len(_doctor_fix_templates()) == 1
    assert len(_SEEDS) == len(default_soul._LEGACY_TEMPLATE_SOULS) + 3


@pytest.mark.parametrize("origin,text", _SEEDS, ids=[origin for origin, _ in _SEEDS])
def test_desktop_recognizes_every_text_upstream_seeds_today(origin, text):
    assert _digest(text) in _TABLE, (
        f"{origin} is an upstream seed APEX Desktop does not know: add '{_digest(text)}' to "
        "UPSTREAM_SEEDED_SOULS in apps/desktop/electron/apex-default-soul.ts and its text to "
        "electron/fixtures/upstream-souls.json"
    )


def test_recorded_texts_match_the_desktop_table():
    assert {row["sha256"] for row in _FIXTURE} == _TABLE
    for row in _FIXTURE:
        assert _digest(row["text"]) == row["sha256"], row["variant"]


def test_engine_keeps_the_apex_identity(tmp_path):
    apex = _apex_identity()
    assert (
        apex.startswith("You are APEX") and "Hermes" not in apex and "Nous" not in apex
    )
    assert _digest(apex) not in _TABLE
    assert not default_soul.is_legacy_template_soul(apex)

    soul = tmp_path / "SOUL.md"
    soul.write_text(apex + "\n", encoding="utf-8")
    _ensure_default_soul_md(tmp_path)

    assert soul.read_text(encoding="utf-8") == apex + "\n"
