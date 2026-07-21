"""ApexNodes text-to-image generation tool (hc-565).

平台工具网关(DESKTOP-CLOUD-CAPABILITY-PARITY-PD;审计 hc-561 ①#15 桌面空位补齐):
桌面文生图从无到有。默认走平台工具网关 ``/tools/v1/image/generate``(vendor key
——agnes / Nano Banana——永不出云);``TOOLS_GATEWAY_DISABLED=1`` 时回退 Scheduler
内网端点 ``/media/image-generate``(云端 P1 回退通道,与 cloud 副本同源)。

图片生成是同步快活(相较文生视频),但仍可能几十秒;代理等待服务端返回。
网关腿收尾同 hc-562 视频腿:master 返回的 ``image_path``/``media_tag`` 是 master
本机路径(云侧靠共享卷才成立),本端不存在——用 ``image_url`` 直链本地落地后再
重建本机 ``MEDIA:`` 标签,绝不把 master 本机路径下发到本端结果面。
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


# 图片渲染是同步调用,但多图/付费档可能耗时数十秒——给足超时余量。
_IMAGE_REQUEST_TIMEOUT = 180


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


def _request(method: str, path: str, payload: dict[str, Any] | None = None, timeout: int = _IMAGE_REQUEST_TIMEOUT) -> dict[str, Any]:
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
            message = detail.get("message") or detail.get("code") or "图片生成服务繁忙,请稍后重试"
        else:
            message = str(detail or "图片生成服务繁忙,请稍后重试")
        raise RuntimeError(message) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接图片生成服务: {exc.reason}") from exc


def _legacy_check() -> bool:
    try:
        data = _request("GET", "/media/image/check", timeout=5)
        return bool(data.get("ok") and data.get("api_key_configured") and data.get("model"))
    except Exception:
        return False


def _check() -> bool:
    # 网关模式:可用性=配置齐(base+key);额度/限流/上游故障在调用时显式报错。
    if _use_gateway():
        return bool(_gateway.agent_api_key())
    return _legacy_check()


GENERATE_IMAGE_SCHEMA = {
    "name": "generate_image",
    "description": (
        "Generate an image from a text prompt through the platform image service. "
        "Use when the user explicitly asks to 配图/做张图/生成海报/画一张/生成图片. "
        "Returns image_url/image_path/media_tag. After success, show the image with "
        "markdown `![description](image_url)`; on IM entries, include `MEDIA:<path>` "
        "when native file delivery is needed. Never claim success unless the tool returns ok."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "Detailed image prompt. Include subject, style, scene, composition, colors, and text to render when needed.",
            },
            "aspect_ratio": {
                "type": "string",
                "enum": ["landscape", "square", "portrait"],
                "description": "landscape=1152x768, square=1024x1024, portrait=768x1152.",
                "default": "square",
            },
            "size": {
                "type": "string",
                "description": "Optional OpenAI-compatible literal size such as 1024x1024. Leave empty unless the user requested exact dimensions.",
            },
            "n": {
                "type": "integer",
                "description": "Number of images to generate, 1-4. Default 1.",
                "default": 1,
            },
            "provider": {
                "type": "string",
                "enum": ["agnes", "agnes-overlay", "nanobanana-flash", "nanobanana-pro"],
                "description": (
                    "Optional image engine. Default agnes (free). agnes-overlay=FREE cover: Agnes "
                    "makes a text-free background and the server prints the title on top with perfect "
                    "Chinese text at ¥0 (pass title/subtitle/template). nanobanana-pro/-flash render "
                    "text INSIDE the image (paid, higher polish) for 图文一体 covers. Empty=normal 配图."
                ),
            },
            "purpose": {
                "type": "string",
                "enum": ["cover", "illustration"],
                "description": (
                    "Optional use-case hint. cover=封面(带大字标题), illustration=普通配图(无关键文字). "
                    "The platform may route cover to the best text-rendering engine. If provider is set, it wins."
                ),
            },
            "title": {
                "type": "string",
                "description": (
                    "Cover title — only used by provider=agnes-overlay. Printed on the image, so it "
                    "renders 100% correctly (this is the free cover engine's whole point)."
                ),
            },
            "subtitle": {
                "type": "string",
                "description": "Optional smaller cover subtitle — only used by provider=agnes-overlay.",
            },
            "template": {
                "type": "string",
                "enum": ["banner", "split", "corner"],
                "description": (
                    "Cover layout for provider=agnes-overlay. banner=大字居中, split=底部标题栏(公众号头图), "
                    "corner=左下角标(小红书笔记). Default banner."
                ),
            },
        },
        "required": ["prompt"],
    },
}


def _localize_gateway_image(result: dict[str, Any], prompt: str) -> str:
    """hc-565 网关腿取件收尾(同 hc-562 视频腿):master 返回的 ``image_path``/
    ``media_tag`` 是 master 本机路径(云侧靠共享卷才成立),本端不存在该文件——原样
    下发会让 agent 发出指向不存在文件的 MEDIA 标签。改为用 ``image_url`` 直链本地
    落地(同 social_download 网关腿的直链自取模式,PD §8),成功后以本机路径重建
    ``image_path``/``media_tag``;多图逐张处理 ``images`` 列表。一张都没落地成功时只
    保留 ``image_url`` 并明说链接有时效。绝不把 master 本机路径下发到本端结果面。"""
    result.pop("image_path", None)
    result.pop("media_tag", None)
    images = result.get("images")
    if not (isinstance(images, list) and images):
        # 没有 images 列表(防御):用顶层 image_url 合成单图处理面。
        top_url = str(result.get("image_url") or result.get("image") or "").strip()
        images = [{"image_url": top_url}] if top_url else []
        if images:
            result["images"] = images

    any_local = False
    for index, image in enumerate(images, start=1):
        if not isinstance(image, dict):
            continue
        image.pop("image_path", None)
        image.pop("media_tag", None)
        url = str(image.get("image_url") or image.get("image") or "").strip()
        if not url:
            continue
        try:
            local_path = _gateway.download_media(url, filename_hint=f"{prompt[:30] or 'image'}_{index}")
        except _gateway.GatewayError:
            continue
        image["image_path"] = str(local_path)
        image["media_tag"] = f"MEDIA:{local_path}"
        any_local = True

    # 顶层 image_path/media_tag = 第一张成功落地的本机图(与 master 侧 first 语义一致)。
    for image in images:
        if isinstance(image, dict) and image.get("image_path"):
            result["image_path"] = image["image_path"]
            result["media_tag"] = image["media_tag"]
            break

    if not any_local and str(result.get("image_url") or "").strip():
        result["note"] = (
            "图片已生成，但保存到本机失败：请尽快通过 image_url 查看/下载"
            "（该链接有有效期，过期后需重新生成）。"
        )
    return tool_result(**result)


def _handle_generate_image(args: dict, **_kwargs) -> str:
    if not isinstance(args, dict):
        return tool_error("generate_image expects a JSON object argument")
    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        return tool_error("请提供图片描述")
    payload = {
        "prompt": prompt,
        "aspect_ratio": str(args.get("aspect_ratio") or "square").strip() or "square",
        "size": str(args.get("size") or "").strip() or None,
        "n": args.get("n") or 1,
        # hc-432: optional engine + use-case hint (vendor key still stays master-side;
        # the plugin only forwards the provider string).
        "provider": str(args.get("provider") or "").strip() or None,
        "purpose": str(args.get("purpose") or "").strip() or None,
        # hc-433: free-cover title/subtitle/layout (only meaningful for agnes-overlay).
        "title": str(args.get("title") or "").strip() or None,
        "subtitle": str(args.get("subtitle") or "").strip() or None,
        "template": str(args.get("template") or "").strip() or None,
    }
    if _use_gateway():
        try:
            response = _gateway.request_json(
                "POST", "/tools/v1/image/generate", payload, timeout=_IMAGE_REQUEST_TIMEOUT
            )
        except _gateway.GatewayError as exc:
            return tool_error(f"图片生成失败: {exc}")
        return _localize_gateway_image(_gateway.unwrap(response), prompt)
    try:
        return tool_result(**_request("POST", "/media/image-generate", payload))
    except RuntimeError as exc:
        return tool_error(f"图片生成失败: {exc}")


def register(ctx):
    ctx.register_tool(
        name="generate_image",
        toolset="skills",
        schema=GENERATE_IMAGE_SCHEMA,
        handler=_handle_generate_image,
        check_fn=_check,
        requires_env=[],
        description=GENERATE_IMAGE_SCHEMA["description"],
        emoji="🖼️",
    )
