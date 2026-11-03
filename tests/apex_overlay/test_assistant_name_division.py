"""hc-1079 × hc-1082: renaming an assistant keeps the 「分工」 its first open wrote, byte for byte.

A new assistant's SOUL.md has two writers. Desktop (hc-1079, ``bot-intake-soul.ts``) puts the answers
it got on first open at the end of the file as a 「分工」 section; ``apex_rename`` (hc-1082) rewrites the
file's first line when the assistant is renamed. The cases are the files Desktop really writes, kept in
``apps/desktop/shared/apex-bot-soul-cases.json`` (``division``): Desktop's tests check them against its
writer and against 撤销 on the renamed file, these check the rename, so neither side can drop the
section alone.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from apex_overlay import assistant_name, single_thread_prompt

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "apps/desktop/shared/apex-bot-soul-cases.json").read_text(encoding="utf-8")
)["division"]["cases"]
IDS = [f"{case['locale']}-{case['next']}" for case in CASES]


def _after_first_line(soul: str) -> str:
    return soul[soul.index("\n") :]


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_a_rename_rewrites_the_first_line_and_keeps_the_division(case):
    renamed = assistant_name.rename_in_soul(case["soul"], case["next"])

    assert renamed == case["expected"]
    assert renamed.split("\n", 1)[0] == assistant_name.SOUL_NAME_LINE.format(name=case["next"])
    assert _after_first_line(renamed) == _after_first_line(case["soul"])
    assert renamed.endswith("\n\n" + case["division"])


@pytest.mark.parametrize("case", CASES, ids=IDS)
def test_the_rename_tool_leaves_the_division_on_disk(tmp_path, monkeypatch, case):
    home = tmp_path / "apexnodes" / "profiles" / "apex-bot-2"
    home.mkdir(parents=True)
    (home / "SOUL.md").write_bytes(case["soul"].encode("utf-8"))
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")
    monkeypatch.setenv(assistant_name.SWITCH_ENV, "1")
    monkeypatch.setattr(assistant_name, "_told", {})

    assert json.loads(assistant_name.handle({"name": case["next"]}))["name"] == case["next"]
    assert (home / "SOUL.md").read_bytes() == case["expected"].encode("utf-8")
