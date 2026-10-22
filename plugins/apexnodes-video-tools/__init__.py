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


def _say(key: str, fallback: str, **fields: Any) -> str:
    """hc-984: the gateway's (zh, en) sentence in the user's language; its Chinese twin
    on a bare copy without the gateway module."""
    if _gateway is not None:
        return _gateway.say(key, media=_gateway.MEDIA_VIDEO, **fields)
    return fallback.format(**fields)


# The Scheduler holds the request open while it submits→polls→downloads the
# render, so the proxy must wait longer than the server-side poll budget.
# hc-941: register() reports it as execution_timeout, or the runtime's shared
# 420 s tool deadline cuts the call while the server is still rendering.
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
    """凭据解析只有一份实现:共用网关客户端(env 链 + config.yaml 兜底副本)。

    hc-604:此处原先自持一份 ``API_SERVER_KEY or MODEL_API_KEY`` 的 env 链,于是
    桌面端注入的 ``TOOLS_GATEWAY_KEY`` 对 legacy 路径完全不可见——同一个进程里
    两条路走两把不同的凭据。委托给共用解析器后,「第 N 份持有者」不再存在。
    裸拷贝部署(网关模块缺失)才回落到本地 env 链。
    """
    if _gateway is not None:
        return _gateway.agent_api_key()
    return (os.getenv("API_SERVER_KEY") or os.getenv("MODEL_API_KEY") or "").strip()


def _missing_credential_message() -> str:
    """凭据缺失的人话文案(与网关路径同一句),绝不说「过期/请重新登录」。"""
    if _gateway is not None:
        return str(_gateway.missing_credential_error())
    return "本环境没有平台凭据,平台工具不可用:请注入 TOOLS_GATEWAY_KEY 后重启。"


def _request(method: str, path: str, payload: dict[str, Any] | None = None, timeout: int = _VIDEO_REQUEST_TIMEOUT) -> dict[str, Any]:
    api_key = _agent_api_key()
    if not api_key:
        raise RuntimeError(_missing_credential_message())
    data = None
    headers = {"Authorization": f"Bearer {api_key}"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{_api_base()}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        code, message = _error_detail(exc.read().decode("utf-8", errors="replace"))
        # hc-969: same honest table as the gateway leg; an error the server did not
        # explain is no longer reported as "繁忙,请稍后重试".
        honest = (
            _gateway.media_error_message(_gateway.MEDIA_VIDEO, exc.code, code, message) if _gateway else None
        )
        raise RuntimeError(
            honest
            or message
            or _say("media_no_reason_status", "视频生成服务出错了({status}),没有说明原因。", status=f"HTTP {exc.code}")
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(_say("media_unreachable", "无法连接视频生成服务: {reason}", reason=exc.reason)) from exc
    # hc-984: an answer that cannot be read is said as such instead of crashing the tool.
    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise RuntimeError(_say("media_unreadable", "视频生成服务的回答读不出来，这次没有结果。")) from exc
    if not isinstance(body, dict):
        raise RuntimeError(_say("media_unreadable", "视频生成服务的回答读不出来，这次没有结果。"))
    return body


def _error_detail(raw: str) -> tuple[str | None, str]:
    """``(code, message)`` from an error answer's ``detail`` (hc-984).

    A body that is not JSON (an HTML gateway page, plain text) or a validation list
    used to be relayed raw, and a bare code was passed off as the reason; they now
    read as "no reason given"."""
    try:
        body = json.loads(raw)
    except ValueError:
        return None, ""
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, str):
        return None, detail.strip()
    if isinstance(detail, dict):
        return str(detail.get("code") or "").strip() or None, str(detail.get("message") or "").strip()
    return None, ""


def _legacy_check() -> bool:
    # hc-969: ``ok`` also folds in the hc-948 off switch and hc-945 leg health. The
    # tool stays offered through both (the handler says why it cannot run); only a
    # platform with no key or model hides it.
    try:
        data = _request("GET", "/media/video/check", timeout=5)
        return bool(data.get("api_key_configured") and data.get("model"))
    except Exception:
        return False


def _check() -> bool:
    # 网关模式:可用性=配置齐(base+key);额度/限流/上游故障在调用时显式报错。
    # hc-969:链路关停或连续失败也不隐藏工具,由 _handle_generate_video 当场说明。
    if _use_gateway():
        return bool(_gateway.agent_api_key())
    return _legacy_check()


def _leg_health() -> dict[str, Any] | None:
    """hc-969: the server's health view of the video legs; None when unreadable."""
    if _use_gateway():
        return (_gateway.tools_check() or {}).get("video")
    try:
        return _request("GET", "/media/video/check", timeout=5)
    except (RuntimeError, OSError, ValueError):
        return None


GENERATE_VIDEO_SCHEMA = {
    "name": "generate_video",
    "description": (
        "Generate a short video from a text prompt (and optional input images) through the platform video service. "
        "Use only when the user explicitly asks to 生成视频/做个视频/做条短视频/文生视频/把这段文案做成视频. "
        "Rendering takes a while; tell the user it is being generated and wait for the result. "
        "Returns video_url/video_path/media_tag and last_frame_ref (the clip's last frame, to start the "
        "next shot from). After success, share the video link; on IM "
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
                "description": (
                    "Optional clip length in whole seconds. Leave empty for the platform default (a 5 s "
                    "sample). A finished cut of up to 15 s is ONE call: write all its shots into the prompt "
                    "with time spans and hard cuts, not one call per shot; only a longer cut is split. The "
                    "platform clamps this to the selected engine's range (at most 15 s), so report the "
                    "returned seconds."
                ),
            },
            "model": {
                "type": "string",
                "enum": [
                    "doubao-seedance-2-5-260628",
                    "doubao-seedance-2-0-260128",
                    "doubao-seedance-2-0-fast-260128",
                    "doubao-seedance-2-0-mini-260615",
                    "MiniMax-H3",
                ],
                "description": (
                    "用户在 APEX 中选择的视频模型。名称依次为 Seedance 2.5、Seedance 2.0、"
                    "Seedance 2.0 Fast、Seedance 2.0 Mini、MiniMax H3。"
                    "Desktop 当前选择的视频模型始终优先;未指定时使用平台默认模型(Seedance 2.0 Mini)。"
                ),
            },
            "provider": {
                "type": "string",
                # hc-948: Agnes left every candidate list (Kael, 2026-10-18); the
                # ApexNodes server also refuses an explicit agnes from older copies.
                "enum": ["chinaapi"],
                "description": (
                    "Optional legacy rendering route. Leave empty when model is selected. "
                    "It may be unavailable, in which case the tool says so; do not silently fall back."
                ),
            },
            "images": {
                "type": "array",
                "maxItems": 9,
                "description": (
                    "Optional input images that pin who / what / where the clip shows (镜头连贯). "
                    "source: an image_ref from an earlier result (generate_image's image_ref, "
                    "generate_video's last_frame_ref), a path from [Image attached at: …], or an image "
                    "link. role: first_frame = the clip starts from this picture and takes its shape; "
                    "last_frame = only with one first_frame, the clip ends on it; reference = 1-9 "
                    "pictures of the character / outfit / product / scene, called 图片1, 图片2 … in the "
                    "prompt in this order. Frames and references cannot be mixed. kind: person / product "
                    "/ scene / style / other; mark a real person's photo as person. To chain shots, pass "
                    "the previous clip's last_frame_ref as the next clip's first_frame. An image that "
                    "cannot be used fails the call; it never renders without it."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "source": {"type": "string"},
                        "role": {"type": "string", "enum": ["first_frame", "last_frame", "reference"]},
                        "kind": {"type": "string", "enum": ["person", "product", "scene", "style", "other"]},
                    },
                    "required": ["source", "role"],
                },
            },
            "rights_confirmed": {
                "type": "boolean",
                "description": (
                    "Set true ONLY after the user explicitly confirmed that the real person in an uploaded "
                    "photo (or named in the prompt) is themselves or agreed to it. Never set it on your own."
                ),
            },
        },
        "required": ["prompt"],
    },
}


def _input_images(args: dict, *, with_roles: bool) -> list[dict[str, str]]:
    """The call's input images, on this leg (apexnodes_gateway.input_images); ``[]`` without any."""
    if _gateway is None:
        if args.get("images"):
            raise RuntimeError("这个客户端缺少平台网关模块，不能带图生成，请更新客户端。")
        return []
    if _use_gateway():
        upload = _gateway.upload_input_image
    else:
        def upload(data: bytes, filename: str, index: int) -> str:
            return _gateway.legacy_upload_input_image(_api_base(), data, filename, index)
    return _gateway.input_images(
        args.get("images"),
        with_roles=with_roles,
        takes_images=lambda: _gateway.takes_input_images(_leg_health()),
        upload=upload,
        server_paths=not _use_gateway(),
    )


def _desktop_video_model() -> str | None:
    """Read the Desktop video picker at call time, including live changes (hc-948).

    The Desktop saves ``apex.generation_video_model`` (seeded to Seedance 2.0 Mini),
    but until hc-948 this plugin never read it: only the hermes-cloud copy did, and
    the Desktop runs this one. So every Desktop video call went out without ``model``
    and landed on the Agnes leg. Same rules as the image plugin's
    ``_desktop_image_model``: the saved choice wins over the LLM's argument, an
    absent preference keeps the platform default, and a malformed or unknown value
    fails before any request instead of silently falling back.
    """
    from hermes_cli.config import (
        get_config_path,
        load_config_readonly,
        require_readable_config_before_write,
    )

    config_path = get_config_path()
    if not config_path.exists():
        return None
    try:
        # The strict preflight keeps the loader's last-known-good fallback from
        # silently routing a malformed picker to the platform default.
        require_readable_config_before_write(config_path)
        config = load_config_readonly()
        if not isinstance(config, dict) or "apex" not in config:
            return None
        apex = config["apex"]
        if not isinstance(apex, dict):
            raise RuntimeError(_say("media_setting_malformed", "当前视频模型设置格式无效"))
        if "generation_video_model" not in apex:
            return None
        model = apex["generation_video_model"]
        allowed = GENERATE_VIDEO_SCHEMA["parameters"]["properties"]["model"]["enum"]
        if not isinstance(model, str) or model not in allowed:
            raise RuntimeError(_say("media_setting_unknown", "当前视频模型设置不是可用的模型"))
        return model
    except (OSError, ValueError, RuntimeError) as exc:
        raise RuntimeError(f"{_say('media_setting_unreadable', '无法读取当前视频模型设置')}: {exc}") from exc


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
        return tool_error(_say("media_not_object", "generate_video 的参数必须是 JSON 对象。"))
    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        return tool_error(_say("media_missing_prompt", "请提供视频描述"))
    try:
        selected_model = _desktop_video_model() or str(args.get("model") or "").strip() or None
    except RuntimeError as exc:
        return tool_error(_say("media_failed", "视频生成失败: {reason}", reason=exc))
    # hc-969: a leg the server reports switched off or failing is said now, instead of
    # a render request that waits minutes to fail.
    unavailable = (
        _gateway.media_unavailable_reason(_gateway.MEDIA_VIDEO, selected_model, _leg_health)
        if _gateway
        else None
    )
    if unavailable:
        return tool_error(unavailable)
    try:
        images = _input_images(args, with_roles=True)
    except RuntimeError as exc:
        return tool_error(_say("media_failed", "视频生成失败: {reason}", reason=exc))
    payload = {
        "prompt": prompt,
        "aspect_ratio": str(args.get("aspect_ratio") or "landscape").strip() or "landscape",
        "size": str(args.get("size") or "").strip() or None,
        "seconds": args.get("seconds"),
        "model": selected_model,
        # hc-659: forwarded verbatim; the master picks/validates the leg (the plugin
        # never learns which engines exist, and never holds a vendor key).
        "provider": str(args.get("provider") or "").strip() or None,
    }
    if images:
        # A text-only call sends exactly what it did before input images existed.
        payload["images"] = images
        payload["rights_confirmed"] = args.get("rights_confirmed") is True
    if _use_gateway():
        try:
            response = _gateway.request_json(
                "POST", "/tools/v1/video/generate", payload, timeout=_VIDEO_REQUEST_TIMEOUT
            )
        except _gateway.GatewayError as exc:
            return tool_error(_say("media_failed", "视频生成失败: {reason}", reason=exc))
        return _localize_gateway_video(_gateway.unwrap(response), prompt)
    try:
        return tool_result(**_request("POST", "/media/video-generate", payload))
    except RuntimeError as exc:
        return tool_error(_say("media_failed", "视频生成失败: {reason}", reason=exc))


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
        execution_timeout=_VIDEO_REQUEST_TIMEOUT,
    )
