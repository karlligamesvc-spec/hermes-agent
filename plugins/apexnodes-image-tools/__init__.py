"""ApexNodes text-to-image generation tool (hc-565).

平台工具网关(DESKTOP-CLOUD-CAPABILITY-PARITY-PD;审计 hc-561 ①#15 桌面空位补齐):
桌面文生图从无到有。默认走平台工具网关 ``/tools/v1/image/generate``(vendor key
——chinaapi / Nano Banana——永不出云);``TOOLS_GATEWAY_DISABLED=1`` 时回退 Scheduler
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


def _say(key: str, fallback: str, **fields: Any) -> str:
    """hc-984: the gateway's (zh, en) sentence in the user's language; its Chinese twin
    on a bare copy without the gateway module."""
    if _gateway is not None:
        return _gateway.say(key, media=_gateway.MEDIA_IMAGE, **fields)
    return fallback.format(**fields)


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


def _request(method: str, path: str, payload: dict[str, Any] | None = None, timeout: int = _IMAGE_REQUEST_TIMEOUT) -> dict[str, Any]:
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
            _gateway.media_error_message(_gateway.MEDIA_IMAGE, exc.code, code, message) if _gateway else None
        )
        raise RuntimeError(
            honest
            or message
            or _say("media_no_reason_status", "图片生成服务出错了({status}),没有说明原因。", status=f"HTTP {exc.code}")
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(_say("media_unreachable", "无法连接图片生成服务: {reason}", reason=exc.reason)) from exc
    # hc-984: an answer that cannot be read is said as such instead of crashing the tool.
    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise RuntimeError(_say("media_unreadable", "图片生成服务的回答读不出来，这次没有结果。")) from exc
    if not isinstance(body, dict):
        raise RuntimeError(_say("media_unreadable", "图片生成服务的回答读不出来，这次没有结果。"))
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
    # hc-969: ``ok`` also folds in hc-945 leg health. The tool stays offered while a
    # leg is failing (the handler says why it cannot run); only a platform with no
    # key or model hides it.
    try:
        data = _request("GET", "/media/image/check", timeout=5)
        return bool(data.get("api_key_configured") and data.get("model"))
    except Exception:
        return False


def _check() -> bool:
    # 网关模式:可用性=配置齐(base+key);额度/限流/上游故障在调用时显式报错。
    # hc-969:链路关停或连续失败也不隐藏工具,由 _handle_generate_image 当场说明。
    if _use_gateway():
        return bool(_gateway.agent_api_key())
    return _legacy_check()


def _leg_health() -> dict[str, Any] | None:
    """hc-969: the server's health view of the image legs; None when unreadable."""
    if _use_gateway():
        return (_gateway.tools_check() or {}).get("image")
    try:
        return _request("GET", "/media/image/check", timeout=5)
    except (RuntimeError, OSError, ValueError):
        return None


# hc-957 (Kael, 2026-10-19): Agnes Image 2.5 left the Desktop picker and the model
# catalog, and a selection saved before that moves to GPT Image 2.5 Flare. The
# composer rewrites the saved value on its next start; until it does, this mapping
# keeps that config working instead of failing the "not an available model" check.
RETIRED_IMAGE_MODELS = {"agnes-image-2.5-flash": "gpt-image-2.5-flare"}


def _desktop_image_model() -> str | None:
    """Read the Desktop picker preference at call time, including live changes."""
    from hermes_cli.config import (
        get_config_path,
        load_config_readonly,
        require_readable_config_before_write,
    )

    config_path = get_config_path()
    if not config_path.exists():
        return None
    try:
        # The strict preflight prevents the config loader's last-known-good
        # fallback from silently routing a malformed picker to the platform default.
        require_readable_config_before_write(config_path)
        config = load_config_readonly()
        if not isinstance(config, dict) or "apex" not in config:
            return None
        apex = config["apex"]
        if not isinstance(apex, dict):
            raise RuntimeError(_say("media_setting_malformed", "当前图片模型设置格式无效"))
        if "generation_image_model" not in apex:
            return None
        model = apex["generation_image_model"]
        if isinstance(model, str):
            model = RETIRED_IMAGE_MODELS.get(model, model)
        allowed = GENERATE_IMAGE_SCHEMA["parameters"]["properties"]["model"]["enum"]
        if not isinstance(model, str) or model not in allowed:
            raise RuntimeError(_say("media_setting_unknown", "当前图片模型设置不是可用的模型"))
        return model
    except (OSError, ValueError, RuntimeError) as exc:
        raise RuntimeError(f"{_say('media_setting_unreadable', '无法读取当前图片模型设置')}: {exc}") from exc


GENERATE_IMAGE_SCHEMA = {
    "name": "generate_image",
    "description": (
        "Generate an image from a text prompt through the platform image service. "
        "Use when the user explicitly asks to 配图/做张图/生成海报/画一张/生成图片. "
        "Returns image_url/image_path/media_tag and the actual model. After success, "
        "show one image: use markdown `![description](image_url)` in Desktop, or "
        "`MEDIA:<path>` for native IM delivery. Never output both for the same image. "
        "When asked which model was used, report the returned model. "
        "Never claim success unless the tool returns ok."
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
                "enum": ["landscape", "square", "portrait", "2:3", "3:4", "4:3", "9:16", "16:9"],
                "description": (
                    "landscape/square/portrait = 横/方/竖，用引擎自己的原生尺寸(比例随引擎而定). "
                    "比例优先级:用户明确写了 2:3/3:4/4:3/9:16/16:9 时，必须把该字面值原样传入，"
                    "即使它和场景默认冲突；只有用户没写比例时才按场景默认:小红书封面 3:4、"
                    "抖音竖版封面 9:16、公众号头图 16:9、通用竖版海报 2:3、横版文章配图 4:3，"
                    "无明确场景用 square。不支持的比例先说明并询问，禁止静默换比例。"
                    "Exact pixels depend on the engine; the response reports the delivered "
                    "aspect_ratio/size_delivered and says so when it had to approximate."
                ),
                "default": "square",
            },
            "size": {
                "type": "string",
                "description": "Optional OpenAI-compatible literal size such as 1024x1024. Leave empty unless the user requested exact dimensions.",
            },
            "n": {
                "type": "integer",
                "description": "Number of images to generate. Default 1; selected catalog models accept one image per call.",
                "default": 1,
            },
            "model": {
                "type": "string",
                "enum": [
                    "qwen-image-3.0-pro",
                    "gemini-2.5-flash-image",
                    "gpt-image-2.5-flare",
                    "gpt-image-2.5-sunburst",
                ],
                "description": (
                    "用户在 APEX 中选择的图片模型。名称依次为 Qwen Image 3.0 Pro、"
                    "Gemini Image 2.5、GPT Image 2.5 Flare、"
                    "GPT Image 2.5 Sunburst。Desktop 当前选择的图片模型始终优先。"
                ),
            },
            "provider": {
                "type": "string",
                # hc-990 (Kael, 2026-10-20): Agnes left every image candidate list and
                # agnes-overlay became cover-overlay. Installed builds still send the old
                # names; the ApexNodes server resolves them with a notice.
                "enum": ["cover-overlay", "cover-template", "nanobanana-flash", "nanobanana-pro"],
                "description": (
                    "Optional image engine; leave empty almost always, and always when model is selected. "
                    "cover-overlay: the platform default model draws a text-free background and the server "
                    "prints the title on top (title 100% correct). cover-template: a plain gradient card "
                    "with the title, no image model, free. nanobanana-pro/-flash render text inside the "
                    "image. Empty means normal 配图."
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
                    "Cover title for the cover engines (cover-overlay / cover-template). Printed on the "
                    "image by the server, so it renders 100% correctly."
                ),
            },
            "subtitle": {
                "type": "string",
                "description": "Optional smaller cover subtitle, printed under the title (cover engines only).",
            },
            "template": {
                "type": "string",
                "enum": ["banner", "split", "corner"],
                "description": (
                    "Cover layout for the printed title. banner=大字居中, split=底部标题栏(公众号头图), "
                    "corner=左下角标(小红书笔记). Default banner."
                ),
            },
            "images": {
                "type": "array",
                "maxItems": 4,
                "description": (
                    "Optional reference images for the new image (定妆图, a product shot, a video's first frame). "
                    "source: an image_ref from an earlier result, a path from [Image attached at: …], or an "
                    "image link; call them 图片1, 图片2 … in the prompt in this order (\"图片1 里的人物穿图片2 "
                    "的外套\"). kind: person / product / scene / style / other; mark a real person's photo as "
                    "person. Leave provider empty: the cover engines and seedream take no images. An image "
                    "that cannot be used fails the call; it never draws without it."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "source": {"type": "string"},
                        "kind": {"type": "string", "enum": ["person", "product", "scene", "style", "other"]},
                    },
                    "required": ["source"],
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
        return tool_error(_say("media_not_object", "generate_image 的参数必须是 JSON 对象。"))
    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        return tool_error(_say("media_missing_prompt", "请提供图片描述"))
    try:
        selected_model = _desktop_image_model() or str(args.get("model") or "").strip() or None
    except RuntimeError as exc:
        return tool_error(_say("media_failed", "图片生成失败: {reason}", reason=exc))
    payload = {
        "prompt": prompt,
        "aspect_ratio": str(args.get("aspect_ratio") or "square").strip() or "square",
        "size": str(args.get("size") or "").strip() or None,
        "n": args.get("n") or 1,
        "model": selected_model,
        # hc-432: optional engine + use-case hint (vendor key still stays master-side;
        # the plugin only forwards the provider string).
        "provider": str(args.get("provider") or "").strip() or None,
        "purpose": str(args.get("purpose") or "").strip() or None,
        # hc-433: cover title/subtitle/layout (only the cover engines print them).
        "title": str(args.get("title") or "").strip() or None,
        "subtitle": str(args.get("subtitle") or "").strip() or None,
        "template": str(args.get("template") or "").strip() or None,
    }
    # hc-969: a leg the server reports switched off or failing is said now, instead of
    # a request that waits to fail. hc-984: with or without a model.
    unavailable = (
        _gateway.media_unavailable_reason(
            _gateway.MEDIA_IMAGE,
            selected_model,
            _leg_health,
            provider=payload["provider"],
            purpose=payload["purpose"],
            title=payload["title"],
        )
        if _gateway
        else None
    )
    if unavailable:
        return tool_error(unavailable)
    try:
        images = _input_images(args, with_roles=False)
    except RuntimeError as exc:
        return tool_error(_say("media_failed", "图片生成失败: {reason}", reason=exc))
    if images:
        # A text-only call sends exactly what it did before input images existed.
        payload["images"] = images
        payload["rights_confirmed"] = args.get("rights_confirmed") is True
    if _use_gateway():
        try:
            response = _gateway.request_json(
                "POST", "/tools/v1/image/generate", payload, timeout=_IMAGE_REQUEST_TIMEOUT
            )
        except _gateway.GatewayError as exc:
            return tool_error(_say("media_failed", "图片生成失败: {reason}", reason=exc))
        return _localize_gateway_image(_gateway.unwrap(response), prompt)
    try:
        return tool_result(**_request("POST", "/media/image-generate", payload))
    except RuntimeError as exc:
        return tool_error(_say("media_failed", "图片生成失败: {reason}", reason=exc))


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
