"""ApexNodes hc-1203: the skill index clips Chinese descriptions beside a CJK character, not at an ASCII space.

v0.23.0 cuts each index row at the last whitespace in its 60-char budget, so the row never ends in half a
word. Chinese has no spaces between words: a Chinese description falls back to the space before its one
English term, and the row shrinks to whatever precedes it. APEX's skills keep their triggers in the first
57 characters (hc-1165); measured on the 67 APEX skills, the upstream rule cut ten Chinese rows to 24-51
characters. A CJK character is a line-break opportunity (UAX #14), so a cut beside one keeps the whole
budget and still shows no half word. English rows keep upstream's word-boundary cut.
"""

from __future__ import annotations

import pytest

from agent.skill_utils import SKILL_PROMPT_DESC_LIMIT, clip_skill_description, extract_skill_description

# Real APEX descriptions (apex-nodes app/skills), the first characters of each.
SHORT_VIDEO_STUDIO = (
    "短视频下载转逐字稿、逐镜拆解、复刻、剪辑自有素材、口播精剪、加字幕和烧字幕、出成片与 Hypit 工程、账号分析。"
    "触发：给了短视频链接或上传了视频"
)
XIAOHONGSHU_LAUNCH = (
    "规划、诊断、优化合规的小红书起号与账号运营 SOP——账号定位(风口/定位/共鸣)、对标库、选题库、笔记简报、内容"
    "日历和复盘"
)


@pytest.mark.parametrize(("desc", "shown"), [
    # Upstream's rule cut these at the space before "工程" and before "SOP": 51 and 24 characters.
    pytest.param(SHORT_VIDEO_STUDIO, SHORT_VIDEO_STUDIO[:57] + "...", id="space-before-an-english-term"),
    pytest.param(XIAOHONGSHU_LAUNCH, XIAOHONGSHU_LAUNCH[:57] + "...", id="space-before-sop"),
    pytest.param("账号运营" * 20, "账号运营" * 14 + "账...", id="no-space-at-all"),
    # A cut between a CJK character and the English word after it drops the whole word.
    pytest.param("出成片" * 18 + "与HypitStudioProject工程", "出成片" * 18 + "与...", id="cjk-then-a-latin-word"),
])
def test_a_chinese_row_keeps_its_whole_budget(desc, shown):
    assert clip_skill_description(desc) == shown


def test_the_triggers_in_the_first_57_chars_reach_the_index():
    row = extract_skill_description({"description": SHORT_VIDEO_STUDIO})
    for trigger in ("逐字稿", "复刻", "口播精剪", "加字幕", "烧字幕", "Hypit 工程", "账号分析"):
        assert trigger in row


@pytest.mark.parametrize(("desc", "shown"), [
    # Upstream's own word-boundary behaviour for English is unchanged.
    pytest.param("Route any request to read/search/research public social-media content into the right tool",
                 "Route any request to read/search/research public...", id="english"),
    # A later whitespace boundary wins over an earlier CJK one: "and" stays whole, "pr" is dropped.
    pytest.param("Create practical social posts for朋友圈、小红书、社群公告、门店活动 and promotional copy",
                 "Create practical social posts for朋友圈、小红书、社群公告、门店活动 and...", id="mixed"),
    pytest.param("x" * 80, "x" * 57 + "...", id="one-long-word"),
    pytest.param("短描述", "短描述", id="fits"),
])
def test_rows_without_a_late_cjk_boundary_follow_upstream(desc, shown):
    assert clip_skill_description(desc) == shown


@pytest.mark.parametrize("desc", [SHORT_VIDEO_STUDIO, XIAOHONGSHU_LAUNCH, "账号运营" * 20,
                                  "Create practical social posts for朋友圈、小红书、社群公告、门店活动 and promotional copy"])
def test_a_row_never_exceeds_the_budget(desc):
    assert len(clip_skill_description(desc)) <= SKILL_PROMPT_DESC_LIMIT
