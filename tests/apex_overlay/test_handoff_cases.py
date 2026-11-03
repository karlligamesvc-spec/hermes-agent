"""hc-1088 × hc-1086: the engine reads the relay formats exactly as Desktop writes and reads them.

Desktop composes the hand-over message and reads the 交回摘要 block (hc-1086); the engine knows a
hand-over turn by the message's first line, hands the block back, and lists the user's assistants from
the same profiles the sidebar shows. Every case is in ``apps/desktop/shared/apex-handoff-cases.json``,
which Desktop's tests read too, so neither side can change a format alone.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import hermes_yaml as yaml
from apex_overlay import handoff

SHARED = Path(__file__).resolve().parents[2] / "apps/desktop/shared"
CASES = json.loads((SHARED / "apex-handoff-cases.json").read_text(encoding="utf-8"))
SOUL_CASES = json.loads((SHARED / "apex-bot-soul-cases.json").read_text(encoding="utf-8"))


# ── the hand-over message ────────────────────────────────────────────────────


@pytest.mark.parametrize("case", CASES["request"]["cases"], ids=[c["input"]["id"] for c in CASES["request"]["cases"]])
def test_every_message_desktop_composes_is_a_hand_over_from_its_sender(case):
    assert handoff.parse_request(case["text"]) == {"id": case["input"]["id"], "from": case["input"]["from"]}


@pytest.mark.parametrize("case", CASES["request_header"]["cases"], ids=lambda case: repr(case["text"][:48]))
def test_only_a_header_on_the_first_line_makes_a_hand_over(case):
    assert handoff.parse_request(case["text"]) == case["request"]


@pytest.mark.parametrize("images", [False, True], ids=["text", "multimodal"])
def test_a_hand_over_is_known_behind_the_gateways_own_turn_notes(images):
    """The Desktop gateway puts a reaction, HUD or interrupted-speech note in front of the model input
    (tui_gateway ``_prepend_note``); the engine reads that input, so the header still counts behind it."""
    from tui_gateway.session_notifications import _prepend_note

    text = CASES["request"]["cases"][0]["text"]
    message = [{"type": "image_url", "image_url": {"url": "data:,"}}, {"type": "text", "text": text}] if images else text

    noted = _prepend_note(_prepend_note(message, "（用户刚给你上一条回复点了 ❤️）"), "（HUD）")

    assert handoff.parse_request(noted) == {"id": "h-20261028-0001", "from": "default"}
    assert handoff.parse_request(None) is None


def test_the_case_file_and_the_engine_agree_on_the_limits():
    assert CASES["handback"]["summary_max_chars"] == handoff.SUMMARY_MAX_CHARS
    assert CASES["handback"]["items_max"] == handoff.MAX_ITEMS
    assert CASES["return_box"]["head_max_chars"] == handoff.HEAD_MAX_CHARS
    assert CASES["return_box"]["path"].format(**{"from": "default", "id": "h1"}) == "apex/handoff/returns/default/h1.json"


# ── the 交回摘要 block ───────────────────────────────────────────────────────


@pytest.mark.parametrize("case", CASES["handback"]["cases"], ids=[c["about"][:40] for c in CASES["handback"]["cases"]])
def test_the_handback_block_reads_like_desktop(case):
    assert handoff.parse_return(case["reply"]) == (case["visible"], case["block"])


def test_the_block_the_taking_note_asks_for_is_one_the_reader_takes():
    note = handoff.TAKING.format(sender="APEX")
    block = note[note.index("<!-- apex:handback") : note.index("-->") + 3]

    _, parsed = handoff.parse_return(f"做好了。\n\n{block}")

    assert parsed is not None and parsed["summary"].startswith("一到三句")
    assert len(parsed["files"]) == 1 and len(parsed["links"]) == 1


# ── 「分工」 and the roster ──────────────────────────────────────────────────


def test_the_division_strings_are_the_ones_listed_per_locale():
    division = CASES["division"]
    assert tuple(division["headings"]) == handoff.DIVISION_HEADINGS
    assert tuple(division["role_prefixes"]) == handoff.ROLE_PREFIXES
    assert tuple(division["platform_prefixes"]) == handoff.PLATFORM_PREFIXES
    assert tuple(division["same_as_apex"]) == handoff.SAME_AS_APEX_LINES
    for copy in division["copy"].values():
        assert copy["heading"] in handoff.DIVISION_HEADINGS
        assert copy["role_prefix"] in handoff.ROLE_PREFIXES
        assert copy["platform_prefix"] in handoff.PLATFORM_PREFIXES
        assert copy["same_as_apex"] in handoff.SAME_AS_APEX_LINES


@pytest.mark.parametrize("case", CASES["division"]["cases"], ids=[c["about"] for c in CASES["division"]["cases"]])
def test_the_division_reads_like_the_cases(case):
    assert handoff.parse_division(case["soul"]) == case["division"]


@pytest.mark.parametrize(
    "case", SOUL_CASES["division"]["cases"], ids=[f"{c['locale']}-{c['next']}" for c in SOUL_CASES["division"]["cases"]]
)
def test_every_soul_desktop_writes_gives_its_role_back(case):
    """hc-1079's own cases: the role the user picked comes back out of the SOUL Desktop wrote, renamed or not."""
    role_line = next(line for line in case["division"].split("\n") if line.startswith(handoff.ROLE_PREFIXES))
    role = next(role_line[len(p) :] for p in handoff.ROLE_PREFIXES if role_line.startswith(p))

    assert handoff.parse_division(case["soul"])["role"] == role
    assert handoff.parse_division(case["expected"])["role"] == role
    assert handoff.parse_division(case["undone"]) == {"role": None, "platforms": None}


def _write_profiles(root: Path, profiles: list[dict]) -> None:
    for entry in profiles:
        home = root if entry["profile"] == "default" else root / "profiles" / entry["profile"]
        home.mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text("{}\n", encoding="utf-8")
        (home / "profile.yaml").write_text(yaml.safe_dump({"ui_meta": entry["ui_meta"]}), encoding="utf-8")
        if entry["soul"] is not None:
            (home / "SOUL.md").write_text(entry["soul"], encoding="utf-8")


def test_the_roster_is_the_sidebars(tmp_path, monkeypatch):
    root = tmp_path / "apexnodes"
    _write_profiles(root, CASES["roster"]["profiles"])
    monkeypatch.setenv("HERMES_HOME", str(root / "profiles" / "apex-bot-3"))

    assert handoff.roster() == CASES["roster"]["expected"]
