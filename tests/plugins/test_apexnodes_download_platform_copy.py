"""hc-938: the Desktop leg's tool copy must not advertise TikTok downloads.

The gateway resolves download links for four platforms only (apex-nodes
``tools_vendor.DOWNLOAD_PLATFORMS``). A tiktok.com link gets HTTP 400
``download_not_supported`` before any vendor call (real call, 2026-10-17, Desktop
0.17.58), yet ``social_download`` said 「抖音/TikTok」 and ``social_batch_submit`` said
「TikTok复用抖音」, so the Agent promised downloads it could not deliver.

This file pins the copy on the fork side so a fork-only PR cannot put TikTok back.
apex-nodes checks the same copy against the server's set on every apex PR
(``tests/test_hc938_tiktok_download_truth.py``; its CI checks out fork main), so when the
gateway gains a platform, ``DOWNLOAD_PLATFORMS`` below and the copy move together.

The schemas are read with ``ast`` (no plugin import), the same way apex-nodes reads them.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PLUGIN = REPO / "plugins" / "apexnodes-douyin-tools" / "__init__.py"
CHEATSHEET = REPO / "optional-skills" / "social-media" / "douyin-operator" / "references" / "social-tools-cheatsheet.md"

# Mirror of apex-nodes tools_vendor.DOWNLOAD_PLATFORMS (the cross-repo check lives there).
DOWNLOAD_PLATFORMS = {"douyin", "xiaohongshu", "kuaishou", "bilibili"}
CAPTION_PLATFORMS = {"youtube"}

_LABELS = {
    "douyin": ("抖音", "douyin"),
    "xiaohongshu": ("小红书", "xiaohongshu"),
    "kuaishou": ("快手", "kuaishou"),
    "bilibili": ("b站", "b 站", "bilibili", "哔哩哔哩"),
    "tiktok": ("tiktok",),
    "youtube": ("youtube",),
    "instagram": ("instagram",),
    "wechat_channels": ("视频号",),
    "wechat_mp": ("公众号",),
    "twitter": ("twitter", "推特"),
}
_SENTENCES = re.compile(r"[。\n]|(?<=[.!?])\s+")
_CLAIM = re.compile(r"下载|转写|逐字稿|download|transcri", re.IGNORECASE)
_NEGATION = re.compile(r"不支持|不能|无法|没有转写|没有下载|别承诺|不要承诺|cannot|not supported", re.IGNORECASE)
_CAPTION_WORD = re.compile(r"字幕|caption", re.IGNORECASE)


def _named(text: str) -> set[str]:
    low = text.lower()
    return {key for key, labels in _LABELS.items() if any(label in low for label in labels)}


def _overclaims(text: str) -> list[tuple[list[str], str]]:
    found = []
    for sentence in _SENTENCES.split(text):
        if not _CLAIM.search(sentence) or _NEGATION.search(sentence):
            continue
        allowed = DOWNLOAD_PLATFORMS | (CAPTION_PLATFORMS if _CAPTION_WORD.search(sentence) else set())
        extra = _named(sentence) - allowed
        if extra:
            found.append((sorted(extra), sentence.strip()))
    return found


def _strings(value):
    if isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)
    elif isinstance(value, str):
        yield value


def _named_group(pattern: str, text: str) -> set[str]:
    match = re.search(pattern, text)
    assert match, f"copy no longer matches {pattern!r}; update this guard together with the copy:\n{text}"
    return _named(match.group(1))


def _tree() -> ast.Module:
    return ast.parse(PLUGIN.read_text(encoding="utf-8"))


def _schemas() -> dict[str, dict]:
    schemas = {}
    for node in _tree().body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            if node.targets[0].id.endswith("_SCHEMA"):
                schemas[node.targets[0].id] = ast.literal_eval(node.value)
    return schemas


@pytest.mark.parametrize(
    ("text", "flagged"),
    [
        ("下载社媒视频（抖音/TikTok、小红书、快手、B站）到当前工作区的媒体空间", ["tiktok"]),
        ("批量下载并转写一批社媒视频（抖音/快手/B站/小红书=下载+转写，YouTube=官方字幕，TikTok复用抖音）", ["tiktok"]),
        ("其他平台（如 TikTok、视频号）的视频不支持下载，不要承诺", []),
        ("抖音/快手/B站/小红书=下载+转写，YouTube=官方字幕", []),
    ],
)
def test_overclaim_scanner_flags_claims_and_passes_honest_copy(text, flagged):
    assert [platforms for platforms, _ in _overclaims(text)] == ([flagged] if flagged else [])


def test_download_tool_copy_names_exactly_the_download_platforms():
    schemas = _schemas()
    download = schemas["SOCIAL_DOWNLOAD_SCHEMA"]
    url_param = download["parameters"]["properties"]["url"]["description"]
    transcribe = schemas["MEDIA_TRANSCRIBE_SCHEMA"]
    batch = schemas["SOCIAL_BATCH_SUBMIT_SCHEMA"]

    assert _named_group(r"下载社媒视频（(.+?)）", download["description"]) == DOWNLOAD_PLATFORMS
    assert _named_group(r"平台会自动识别(.+?)链接", url_param) == DOWNLOAD_PLATFORMS
    assert _named_group(r"社媒视频链接 url（(.+?)，", transcribe["description"]) == DOWNLOAD_PLATFORMS
    assert _named_group(r"（(.+?)=下载\+转写", batch["description"]) == DOWNLOAD_PLATFORMS
    assert _named_group(r"，(.+?)=官方字幕", batch["description"]) == CAPTION_PLATFORMS
    assert "tiktok" not in _named(batch["parameters"]["properties"]["platform"]["description"])


def test_no_tool_description_presents_another_platform_as_downloadable():
    claims = [
        (name, platforms, sentence)
        for name, schema in sorted(_schemas().items())
        for text in _strings(schema)
        for platforms, sentence in _overclaims(text)
    ]
    assert not claims, claims


def test_unrecognized_link_error_lists_the_download_platforms():
    resolve = next(
        node for node in _tree().body if isinstance(node, ast.FunctionDef) and node.name == "_gateway_resolve_download"
    )
    messages = [
        node.args[0].value
        for node in ast.walk(resolve)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "GatewayError"
        and node.args
        and isinstance(node.args[0], ast.Constant)
    ]
    assert len(messages) == 1, messages
    assert _named_group(r"当前可下载：(.+?)）", messages[0]) == DOWNLOAD_PLATFORMS


def test_douyin_operator_cheatsheet_routes_only_download_platforms_to_social_download():
    rows = [line for line in CHEATSHEET.read_text(encoding="utf-8").splitlines() if line.startswith("| `social_download`")]
    assert len(rows) == 1
    usage = [cell.strip() for cell in rows[0].strip("|").split("|")][3]
    assert _named_group(r"^(.+?)分享链接", usage) == DOWNLOAD_PLATFORMS
    assert not _overclaims(rows[0]), rows[0]
