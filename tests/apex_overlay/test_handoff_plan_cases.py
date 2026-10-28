"""hc-1091 多助手二期 R6: the relay plan (一条龙接力) rule APEX's section carries, against the block Desktop reads.

``apps/desktop/shared/apex-handoff-plan-cases.json`` is the one place the template lives: this side asserts the
rule prints it word for word (and the cap it states), Desktop's ``lib/handoff-plan.test.ts`` reads the same file
and parses the template and every case. Change the two sides only together.
"""

from __future__ import annotations

import json
from pathlib import Path

from apex_overlay import handoff

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "apps" / "desktop" / "shared" / "apex-handoff-plan-cases.json").read_text(
        encoding="utf-8"
    )
)


def test_the_rule_prints_the_shared_template_word_for_word():
    assert handoff.PLAN_TEMPLATE == CASES["prompt_template"]
    assert f"\n{CASES['prompt_template']}\n" in handoff.PLAN_RULE


def test_the_rule_states_the_cap_desktop_enforces():
    assert handoff.PLAN_MAX_LEGS == CASES["max_legs"] == 3
    assert f"连「已有」最多 {CASES['max_legs']} 棒" in handoff.PLAN_RULE


def test_a_relay_baton_is_written_as_the_handoff_item():
    """A baton line is hc-1089's 「交给」 item, so Desktop reads both with one parser (lib/next-steps.ts)."""
    item = handoff.HANDOFF_ITEM.strip("`")
    relay_lines = [line for line in CASES["prompt_template"].split("\n") if line.startswith("@")]

    assert relay_lines and all(line == item.replace("按钮字", "这一棒做什么") for line in relay_lines)


def test_the_template_opens_with_desktop_s_marker_and_says_what_is_not_offered_with_it():
    assert CASES["prompt_template"].startswith("<!-- apex:plan\n") and CASES["prompt_template"].endswith("\n-->")
    assert CASES["protocol"] == "apex-plan/1"
    # 「已有」 first; the user starts it; no 「下一步」 block beside a plan.
    assert "「已有」只写在第一行" in handoff.PLAN_RULE
    assert "用户在卡上点「开始」才按顺序跑" in handoff.PLAN_RULE
    assert "排了接力计划的回复不写「下一步」块" in handoff.PLAN_RULE
