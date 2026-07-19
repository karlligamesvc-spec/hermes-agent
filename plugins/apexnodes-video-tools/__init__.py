"""ApexNodes text-to-video generation tool.

平台工具网关 P1(DESKTOP-CLOUD-CAPABILITY-PARITY-PD D1/D2):本插件自
hermes-cloud ``app/runtime_plugins/apexnodes-video-tools`` 迁入 fork,
桌面与云端同一份代码。默认走平台工具网关 ``/tools/v1/video/generate``
(vendor key 永不出云);``TOOLS_GATEWAY_DISABLED=1`` 时回退迁移前的
Scheduler 端点路径(云端 P1 回退通道,P2 删)。

Video rendering is async + heavy, so the request can take a few minutes —
the proxy waits while the platform submits, polls, and downloads.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

from tools.registry import tool_error, tool_result

try:  # 网关客户端(fork 内共用);导入失败时插件退回 legacy 路径,绝不拖垮装载。
    from plugins import apexnodes_gateway as _gateway
except Exception:  # pragma: no cover - 仅在裸拷贝部署等异常形态出现
    _gateway = None  # type: ignore[assignment]


def _use_gateway() -> bool:
    return _gateway is not None and _gateway.use_gateway()


# The Scheduler holds the request open while it submits→polls→downloads the
# render, so the proxy must wait longer than the server-side poll budget.
_VIDEO_REQUEST_TIMEOUT = 660


# ── legacy Scheduler 路径(迁移前行为,原样保留) ─────────────────────────────

def _api_base() -> str:
    base = (
        os.getenv("HERMES_PLATFORM_API_BASE")
        or os.getenv("HERMES_MASTER_API_BASE")
        or os.getenv("HERMES_SCHEDULER_API_BASE")
        or "http://host.docker.internal:8000/api/v1"
    )
    return base.rstrip("/")


def _agent_api_key() -> str:
    return (os.getenv("API_SERVER_KEY") or os.getenv("MODEL_API_KEY") or "").strip()


def _request(method: str, path: str, payload: dict[str, Any] | None = None, timeout: int = _VIDEO_REQUEST_TIMEOUT) -> dict[str, Any]:
    api_key = _agent_api_key()
    if not api_key:
        raise RuntimeError("Agent API key is missing")
    data = None
    headers = {"Authorization": f"Bearer {api_key}"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{_api_base()}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw).get("detail", raw)
        except json.JSONDecodeError:
            detail = raw
        if isinstance(detail, dict):
            message = detail.get("message") or detail.get("code") or "视频生成服务繁忙,请稍后重试"
        else:
            message = str(detail or "视频生成服务繁忙,请稍后重试")
        raise RuntimeError(message) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接视频生成服务: {exc.reason}") from exc


def _legacy_check() -> bool:
    try:
        data = _request("GET", "/media/video/check", timeout=5)
        return bool(data.get("ok") and data.get("api_key_configured") and data.get("model"))
    except Exception:
        return False


def _check() -> bool:
    # 网关模式:可用性=配置齐(base+key);额度/限流/上游故障在调用时显式报错。
    if _use_gateway():
        return bool(_gateway.agent_api_key())
    return _legacy_check()


GENERATE_VIDEO_SCHEMA = {
    "name": "generate_video",
    "description": (
        "Generate a short video from a text prompt through the platform video service. "
        "Use only when the user explicitly asks to 生成视频/做个视频/做条短视频/文生视频/把这段文案做成视频. "
        "Rendering takes a while; tell the user it is being generated and wait for the result. "
        "Returns video_url/video_path/media_tag. After success, share the video link; on IM "
        "entries, output `MEDIA:<path>` on its own line for native file delivery. Never claim "
        "success unless the tool returns ok, and never fabricate a video or link."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "Detailed video prompt: subject, action, scene, camera/movement, style, mood.",
            },
            "aspect_ratio": {
                "type": "string",
                "enum": ["landscape", "square", "portrait"],
                "description": "landscape=1280x720, square=1024x1024, portrait=720x1280.",
                "default": "landscape",
            },
            "size": {
                "type": "string",
                "description": "Optional OpenAI-compatible literal size such as 1280x720. Leave empty unless the user requested exact dimensions.",
            },
            "seconds": {
                "type": "integer",
                "description": "Optional clip length in seconds. Leave empty to use the platform default; longer clips take longer to render.",
            },
        },
        "required": ["prompt"],
    },
}


def _localize_gateway_video(result: dict[str, Any], prompt: str) -> str:
    """hc-562 网关腿取件收尾:master 返回的 ``video_path``/``media_tag`` 是 master
    本机路径(云侧靠共享卷才成立),本端不存在该文件——原样下发会让 agent 发出
    指向不存在文件的 MEDIA 标签。改为用 ``video_url`` 直链本地落地(同
    social_download 网关腿的直链自取模式,PD §8),成功后以本机路径重建
    ``video_path``/``media_tag``;失败则只保留 ``video_url`` 并明说链接有时效。
    绝不把 master 本机路径下发到本端结果面。"""
    result.pop("video_path", None)
    result.pop("media_tag", None)
    video_url = str(result.get("video_url") or result.get("video") or "").strip()
    if not video_url:
        return tool_result(**result)
    try:
        local_path = _gateway.download_media(video_url, filename_hint=prompt[:40] or "generated_video")
    except _gateway.GatewayError:
        result["note"] = (
            "视频已生成，但保存到本机失败：请尽快通过 video_url 查看/下载"
            "（该链接有有效期，过期后需重新生成）。"
        )
        return tool_result(**result)
    result["video_path"] = str(local_path)
    result["media_tag"] = f"MEDIA:{local_path}"
    return tool_result(**result)


def _handle_generate_video(args: dict, **_kwargs) -> str:
    if not isinstance(args, dict):
        return tool_error("generate_video expects a JSON object argument")
    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        return tool_error("请提供视频描述")
    payload = {
        "prompt": prompt,
        "aspect_ratio": str(args.get("aspect_ratio") or "landscape").strip() or "landscape",
        "size": str(args.get("size") or "").strip() or None,
        "seconds": args.get("seconds"),
    }
    if _use_gateway():
        try:
            response = _gateway.request_json(
                "POST", "/tools/v1/video/generate", payload, timeout=_VIDEO_REQUEST_TIMEOUT
            )
        except _gateway.GatewayError as exc:
            return tool_error(f"视频生成失败: {exc}")
        return _localize_gateway_video(_gateway.unwrap(response), prompt)
    try:
        return tool_result(**_request("POST", "/media/video-generate", payload))
    except RuntimeError as exc:
        return tool_error(f"视频生成失败: {exc}")


def register(ctx):
    ctx.register_tool(
        name="generate_video",
        toolset="skills",
        schema=GENERATE_VIDEO_SCHEMA,
        handler=_handle_generate_video,
        check_fn=_check,
        requires_env=[],
        description=GENERATE_VIDEO_SCHEMA["description"],
        emoji="🎬",
    )
