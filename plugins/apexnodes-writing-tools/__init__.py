"""write_draft: the writing step of scripts and copy, on the platform's strong model.

The assistant gathers the facts (product material, the user's numbers and prices, test
readings, experiences the person confirmed, the benchmark breakdown, persona and
platform), then hands them here; the server writes the draft with Claude Opus on the
platform's account and answers the text plus what still needs the user's word. The
assistant still checks the draft (honesty_verify / copy-compliance-check) before any
voice, video or publishing step.

When the server did not write it (switched off, today's drafts used up, the model failed)
the answer says ``written: false`` with the reason and the server's writing rules: the
assistant tells the user the reason in one sentence and writes the draft itself by those
rules. When the server cannot be reached at all the error says so the same way.

One file for both sides (byte-identical to the hermes-agent fork copy): APEX Desktop goes
through the tools gateway client (``plugins/apexnodes_gateway.py``), a cloud container
through the Scheduler at its platform base, which already ends in ``/api/v1``.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

from tools.registry import tool_error, tool_result

try:  # the Desktop's tools gateway client; a cloud copy without it takes the Scheduler path
    from plugins import apexnodes_gateway as _gateway
except ImportError:  # pragma: no cover - a bare copy keeps the cloud path
    _gateway = None  # type: ignore[assignment]

DRAFT_PATH = "/tools/v1/writing/draft"
# The server streams one draft for up to 300 s (DRAFT_WRITER_TIMEOUT_SECONDS) plus its own checks.
_TIMEOUT = 330
KINDS = ("video_script", "voiceover", "storyboard", "post_copy")
_TEXT_FIELDS = ("benchmark", "persona", "platform", "draft")
_INT_FIELDS = ("duration_seconds", "length_chars")
_WRITE_YOURSELF = (
    "请你自己接着写：只用已经收集到的事实，不编数字、价格、效果和本人用过的经历，"
    "缺的写进「需人工确认」；写完照常过 honesty_verify。"
)

WRITE_DRAFT_SCHEMA: dict[str, Any] = {
    "name": "write_draft",
    "description": (
        "写稿：把短视频脚本、口播稿、分镜脚本表和各平台文案（小红书笔记、抖音和视频号的标题描述、朋友圈）"
        "交给更强的写稿模型写。先把事实备齐再调：商品资料和参数、用户给的价格和数据、实测读数、"
        "本人确认过的用过经历、对标拆解、人设和平台；不要自己先写一版。"
        "返回 written=true：把 text 给用户，notes 放进「需人工确认」。"
        "返回 written=false：照 message 用一句话告诉用户为什么这次是你写的，再按返回的 rules 自己写。"
        "不管谁写的，配音、出片、发布之前都照常过 honesty_verify。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": list(KINDS),
                "description": (
                    "写什么：video_script 短视频脚本（分段：画面＋口播＋封面字）；voiceover 口播稿（只要说的话）；"
                    "storyboard 分镜脚本表（九列，一镜一行）；post_copy 平台文案（标题、正文、话题）。"
                ),
            },
            "brief": {
                "type": "string",
                "description": "这份稿子写什么、给谁看、要达到什么目的；改稿时写清改哪里、保留什么。",
            },
            "facts": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "事实清单，一条一个事实，只放用户给的、工具查到的、商品图和商品页上写着的；不放推测。"
                    "本人用过的经历要写明「本人确认」，没确认的不放。"
                ),
            },
            "benchmark": {"type": "string", "description": "对标拆解要点：复刻卡、对标结论、钩子做法、结构和节奏。"},
            "persona": {"type": "string", "description": "人设：谁出镜或署名、账号定位、受众、口吻、禁忌。"},
            "platform": {
                "type": "string",
                "description": "发在哪：douyin、xiaohongshu、wechat_channels、kuaishou、bilibili、wechat_moments、tiktok 等。",
            },
            "duration_seconds": {"type": "integer", "description": "视频时长（秒），脚本、口播稿和分镜脚本表按它定字数。"},
            "length_chars": {"type": "integer", "description": "文案大约多少字（不给就按平台常见长度）。"},
            "draft": {"type": "string", "description": "已有草稿：用户或上一轮写的稿子，改稿时传。"},
            "language": {"type": "string", "enum": ["zh", "en"], "description": "en：给 TikTok 等海外平台写英文稿；默认中文。"},
        },
        "required": ["kind", "brief"],
    },
}


def _api_base() -> str:
    base = (
        os.getenv("HERMES_PLATFORM_API_BASE")
        or os.getenv("HERMES_MASTER_API_BASE")
        or os.getenv("HERMES_SCHEDULER_API_BASE")
        or "http://host.docker.internal:8000/api/v1"
    )
    return base.rstrip("/")


def _agent_api_key() -> str:
    """One credential resolution: the gateway client's, else a cloud container's env."""
    if _gateway is not None:
        return _gateway.agent_api_key()
    return (os.getenv("API_SERVER_KEY") or os.getenv("MODEL_API_KEY") or "").strip()


def _missing_credential_message() -> str:
    """No platform credential at all: what to do about it, never "expired, sign in again"."""
    if _gateway is not None:
        return str(_gateway.missing_credential_error())
    return "这个助手没有平台凭据，写稿工具用不了：请给容器注入 TOOLS_GATEWAY_KEY 后重启"


def _use_gateway() -> bool:
    return _gateway is not None and _gateway.use_gateway()


def _error_message(raw: str, status: int) -> str:
    try:
        body = json.loads(raw)
    except ValueError:
        body = None
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, dict) and detail.get("message"):
        return str(detail["message"]).strip()
    if isinstance(detail, str) and detail.strip():
        return detail.strip()
    if status == 422:
        return "写稿工具的参数不对（kind、brief 必填，facts 是字符串数组）"
    return f"平台写稿接口出错（HTTP {status}）"


def _post(payload: dict[str, Any]) -> dict[str, Any]:
    if _use_gateway():
        try:
            return _gateway.unwrap(_gateway.request_json("POST", DRAFT_PATH, payload, timeout=_TIMEOUT))
        except _gateway.GatewayError as exc:
            raise RuntimeError(str(exc)) from exc
    key = _agent_api_key()
    if not key:
        raise RuntimeError(_missing_credential_message())
    request = urllib.request.Request(
        f"{_api_base()}{DRAFT_PATH}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            body = json.loads(response.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(_error_message(exc.read().decode("utf-8", errors="replace"), exc.code)) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"连不上平台写稿接口：{exc.reason}") from exc
    except (ValueError, TimeoutError) as exc:
        raise RuntimeError("平台写稿接口没有给出能读的回答") from exc
    if not isinstance(body, dict):
        raise RuntimeError("平台写稿接口没有给出能读的回答")
    data = body.get("data")
    return data if isinstance(data, dict) else body


def _payload(args: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """The request body, or None and why the arguments cannot be sent."""
    kind = str(args.get("kind") or "").strip()
    if kind not in KINDS:
        return None, f"kind 只能是 {' / '.join(KINDS)}。"
    brief = str(args.get("brief") or "").strip()
    if not brief:
        return None, "请在 brief 里写清这份稿子写什么、给谁看。"
    facts = args.get("facts") or []
    if isinstance(facts, str):
        facts = [line for line in facts.splitlines()]
    if not isinstance(facts, list):
        return None, "facts 要是字符串数组，一条一个事实。"
    payload: dict[str, Any] = {"kind": kind, "brief": brief, "facts": [str(f).strip() for f in facts if str(f).strip()]}
    for name in _TEXT_FIELDS:
        value = str(args.get(name) or "").strip()
        if value:
            payload[name] = value
    for name in _INT_FIELDS:
        value = args.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            payload[name] = int(value)
    if args.get("language") in ("zh", "en"):
        payload["language"] = args["language"]
    return payload, ""


def _handle_write_draft(args: dict, **_kwargs) -> str:
    if not isinstance(args, dict):
        return tool_error("write_draft 的参数必须是 JSON 对象。")
    payload, problem = _payload(args)
    if payload is None:
        return tool_error(problem)
    try:
        result = _post(payload)
    except RuntimeError as exc:
        return tool_error(f"写稿模型这次没用上：{exc}。{_WRITE_YOURSELF}")
    return tool_result(**result)


def _check() -> bool:
    return bool(_agent_api_key())


def register(ctx):
    ctx.register_tool(
        name="write_draft",
        toolset="skills",
        schema=WRITE_DRAFT_SCHEMA,
        handler=_handle_write_draft,
        check_fn=_check,
        requires_env=[],
        description=WRITE_DRAFT_SCHEMA["description"],
        emoji="✍️",
    )
