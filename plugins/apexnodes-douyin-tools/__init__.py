"""ApexNodes social-media media tools.

平台工具网关 P1(DESKTOP-CLOUD-CAPABILITY-PARITY-PD D1/D2):本插件自
hermes-cloud ``app/runtime_plugins/apexnodes-douyin-tools`` 迁入 fork,
桌面与云端同一份代码。默认走平台工具网关(``plugins/apexnodes_gateway.py``,
vendor key 永不出云);``TOOLS_GATEWAY_DISABLED=1`` 时回退迁移前的 master
内网端点路径(云端 P1 回退通道,P2 删)。

hc-254: tool names are platform-neutral (``social_download`` /
``media_transcribe``); the package directory keeps its
``apexnodes-douyin-tools`` name for plugin-registry stability.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from tools.registry import tool_error, tool_result

try:  # 网关客户端(fork 内共用);导入失败时插件退回 legacy 路径,绝不拖垮装载。
    from plugins import apexnodes_gateway as _gateway
except Exception:  # pragma: no cover - 仅在裸拷贝部署等异常形态出现
    _gateway = None  # type: ignore[assignment]


def _use_gateway() -> bool:
    return _gateway is not None and _gateway.use_gateway()


# ── legacy master 直连路径(迁移前行为,原样保留;TOOLS_GATEWAY_DISABLED=1 或无网关配置时走) ──

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


# hc-340: media_transcribe holds the master connection for the whole ASR poll,
# whose budget scales with audio length and is capped at 2h (hc-323). The old
# shared 600s (10min) cap was far below that, so any long video timed out at the
# plugin layer and forced a wasteful re-download + re-transcribe retry (and
# scared the user with a failure mid-way). Align the transcribe timeout with the
# master budget + download/ffmpeg headroom; light calls keep the short default.
_MEDIA_TRANSCRIBE_TIMEOUT_SECONDS = 2 * 60 * 60 + 10 * 60  # 2h10m
# hc-941:其余单请求出口(social_download 的链接解析、image_ocr、legacy _post 默认)的等待上限。
# 运行时外层执行器默认把一次工具调用掐在 420s(agent/tool_executor.py),短于插件自己愿意等
# 的时间:0.17.58 实测 103 秒的抖音视频首次转写跑满 420s 被掐断,重试才成功。所以 register()
# 把这两个预算作为 execution_timeout 报给运行时。social_batch_submit / social_batch_status
# 只等 120s / 60s,低于默认值,不需要登记。
_PLATFORM_REQUEST_TIMEOUT_SECONDS = 600

# hc-926:平台 ASR 对纯环境声/音乐/静音素材的结论(云端 422 detail.code)。它描述的是
# 素材,不是故障:报成 tool_error 会让逐段检查素材的剪辑任务连撞 same_tool_failure
# 循环告警。两条腿(网关 / legacy)都把它和「200 但转写为空」统一成成功 + speech=false。
_ASR_NO_SPEECH_CODE = "asr_no_speech"
_NO_SPEECH_NOTE = (
    "未检测到人声：这段音频只有环境声、音乐或静音，转写为空是素材本身的正常结果，不是工具故障。"
    "不要对同一文件重试；剪辑时按无人声素材处理（保留现场声即可）。"
)


# hc-929:豆包分句/字词级时间轴(segments)不进结果面正文。字词级时间轴每分钟人声约 2 万
# 字符,整段内联会让长视频的结果越过运行时单条 100K 字符的落盘阈值(tools/budget_config.py),
# 连 transcript 一起被换成 1.5K 预览;字幕/锚点本来就由脚本读时间轴。所以两条腿统一:全量写
# <转写文件名>.segments.json,结果面只带 segments_path + segments_summary。
_SEGMENTS_WRITE_FAILED_NOTE = (
    "豆包时间轴文件没能写进本机缓存目录，本次结果没有 segments_path；"
    "需要字幕时间轴时先排查磁盘空间或目录权限，再重新转写。"
)


# hc-918:有人声、却没有时间轴的结果,要明说再调一次能不能拿到。2026-10-18 直播内测里,
# Agent 为了时间轴把同一段录音转了三次。只有服务端旧缓存(cache_hit)缺时间轴时,
# force_refresh 重转一次才有用;新鲜结果没有时间轴,重问多少次都一样。
_NO_TIMING_NOTE = (
    "这次转写没有返回时间轴(不是缓存造成的)。再次调用 media_transcribe,包括 force_refresh,"
    "也拿不到时间轴,只会重复计费;请按没有时间轴继续,需要时按分句或段落顺序估算并注明是估算。"
)
_NO_TIMING_CACHED_NOTE = (
    "这份结果来自服务端缓存,缓存里没有时间轴。确实需要字幕时间轴时,用 force_refresh=true "
    "重新转写一次(会重新计费);重转后仍没有,就按没有时间轴继续,不要再试。"
)


class _PlatformError(RuntimeError):
    """legacy master 端点的 HTTP 错误;``code`` 是服务端 detail.code(可能为 None)。"""

    def __init__(self, message: str, *, code: str | None = None):
        super().__init__(message)
        self.code = code


def _speech_fields(transcript: str) -> dict[str, Any]:
    """转写结果面的人声标记:有字为 speech=true;为空则 speech=false 并附说明。"""
    if transcript:
        return {"speech": True}
    return {"speech": False, "speech_note": _NO_SPEECH_NOTE}


def _no_timing_fields(result: dict[str, Any], transcript: str, cache_hit: Any) -> dict[str, Any]:
    """有人声但这次没有时间轴文件时,告诉模型再调一次能不能拿到(两条腿共用)。

    没有人声(speech_note 已经说了不要重试)、已经有 segments_path、或时间轴其实有只是
    没写成文件(_SEGMENTS_WRITE_FAILED_NOTE)时都不加。
    """
    if not transcript or result.get("segments_path") or result.get("segments_note"):
        return {}
    return {"segments_note": _NO_TIMING_CACHED_NOTE if cache_hit else _NO_TIMING_NOTE}


def _transcript_file_stem(title: str) -> str:
    """转写旁路文件(全文 .txt、时间轴 .segments.json)共用的文件名前缀。"""
    return f"{_safe_filename(title or '视频转写')}_转写_{uuid.uuid4().hex[:8]}"


def _segments_result_fields(segments: Any, stem: str) -> dict[str, Any]:
    """时间轴结果面(两条腿共用):全量写 ``<stem>.segments.json``,结果只带路径和摘要。

    文件是 JSON 数组、一行一个分句:json.load 整体读,read_file 按分句翻页;每行保持服务端
    原样(毫秒 start_time/end_time,字词级 words)。没有时间轴时 count=0 且没有路径,模型
    据此分清「服务端没给」和「旧客户端丢了」(后者连 segments_summary 都没有)。
    """
    rows = [row for row in segments if isinstance(row, dict)] if isinstance(segments, list) else []
    if not rows:
        return {"segments_summary": {"count": 0}}
    summary: dict[str, Any] = {
        "count": len(rows),
        "word_count": sum(len(row["words"]) for row in rows if isinstance(row.get("words"), list)),
    }
    starts = [row["start_time"] for row in rows if type(row.get("start_time")) in (int, float)]
    ends = [row["end_time"] for row in rows if type(row.get("end_time")) in (int, float)]
    if starts:
        summary["first_start_ms"] = min(starts)
    if ends:
        summary["last_end_ms"] = max(ends)
    fields: dict[str, Any] = {"segments_summary": summary}
    try:
        dest = _document_cache_dir() / f"{stem}.segments.json"
        lines = ",\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
        dest.write_text(f"[\n{lines}\n]\n", encoding="utf-8")
        fields["segments_path"] = str(dest)
    except OSError:  # 缓存目录不可建/不可写;转写本身照常成功
        fields["segments_note"] = _SEGMENTS_WRITE_FAILED_NOTE
    return fields


def _post(
    path: str, payload: dict[str, Any], *, timeout: int = _PLATFORM_REQUEST_TIMEOUT_SECONDS
) -> dict[str, Any]:
    api_key = _agent_api_key()
    if not api_key:
        raise RuntimeError(_missing_credential_message())
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{_api_base()}{path}",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw).get("detail", raw)
        except json.JSONDecodeError:
            detail = raw
        code = None
        if isinstance(detail, dict):
            code = str(detail.get("code") or "").strip() or None
            message = detail.get("message") or detail.get("code") or raw
            # hc-254: surface the machine-readable honesty signal so the model
            # offers the honest options instead of self-installing whisper.
            if detail.get("terminal_fallback_allowed") is False:
                message = (
                    f"{message}\n[terminal_fallback_allowed=false] 平台转写不可用，"
                    "请按失败选项处理（稍后重试 / 发视频文件 / 贴文字稿），"
                    "不要尝试自行安装或运行本地转写工具（如 whisper）。"
                )
        else:
            message = str(detail or raw)
        raise _PlatformError(message, code=code) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接媒体服务: {exc.reason}") from exc


def _get(path: str, *, timeout: int = 60) -> dict[str, Any]:
    api_key = _agent_api_key()
    if not api_key:
        raise RuntimeError(_missing_credential_message())
    request = urllib.request.Request(
        f"{_api_base()}{path}",
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw).get("detail", raw)
        except json.JSONDecodeError:
            detail = raw
        message = detail.get("message") if isinstance(detail, dict) else str(detail or raw)
        raise RuntimeError(message or raw) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接媒体服务: {exc.reason}") from exc


def _legacy_check() -> bool:
    api_key = _agent_api_key()
    if not api_key:
        return False
    request = urllib.request.Request(
        f"{_api_base()}/media/douyin/check",
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            data = json.loads(response.read().decode("utf-8"))
            return bool(data.get("tikhub_configured") and data.get("doubao_asr_configured") and data.get("ffmpeg_available"))
    except Exception:
        return False


def _check() -> bool:
    # 网关模式:可用性=配置齐(base+key);额度/上游故障在调用时以显式文案暴露,
    # 不在注册期做网络探测(桌面离线启动不应拖慢/误杀工具注册)。
    if _use_gateway():
        return bool(_gateway.agent_api_key())
    return _legacy_check()


SOCIAL_DOWNLOAD_SCHEMA = {
    "name": "social_download",
    "description": (
        "下载社媒视频（抖音、小红书、快手、B站）到当前工作区的媒体空间。用户发来抖音/小红书/快手/B站分享链接/分享口令时，"
        "第一步必须优先使用本工具；不要用浏览器打开这些链接（反爬环境又慢又不可靠）。返回 video_path 和元数据。"
        "其他平台（如 TikTok、视频号）的视频不支持下载，不要承诺；需要时请用户直接发送视频文件。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": (
                    "直接传用户发来的原始分享文本即可（整段口令，含前后噪音文字也可以）；"
                    "平台会自动识别抖音（v.douyin.com）、小红书（xhslink.com / xiaohongshu.com）、"
                    "快手（v.kuaishou.com）、B站（bilibili.com / b23.tv）链接。"
                ),
            }
        },
        "required": ["url"],
    },
}

MEDIA_TRANSCRIBE_SCHEMA = {
    "name": "media_transcribe",
    "description": (
        "转写已下载的 video_path 或社媒视频链接 url（抖音/小红书/快手/B站，可直接传用户的原始分享文本，一步下载并转写）。"
        "用户要视频文案/逐字稿/拆解脚本时用本工具，禁止用浏览器或其他平台替代，也不要自行安装或运行本地转写工具（如 whisper）。"
        "返回完整转写、transcript_path，以及豆包分句/字词级时间轴文件 segments_path"
        "（JSON 分句数组，start_time/end_time 为毫秒，含字/词级 words；结果里只附 segments_summary 摘要，"
        "做字幕时用脚本读这个文件）。"
        "素材没有人声（纯环境声/音乐/静音）时返回 ok=true、speech=false 和空 transcript，"
        "这是正常结果，不要对同一文件重试。"
        "有人声但没有时间轴时，结果里的 segments_note 会说明再调用能不能拿到时间轴，照它做，不要盲目重转。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "video_path": {"type": "string", "description": "Video path returned by social_download."},
            "url": {"type": "string", "description": "Optional social video share text/URL; downloads and transcribes in one call."},
            "force_refresh": {
                "type": "boolean",
                "description": (
                    "Skip the server's transcript cache and run ASR again; this bills again. Use it at "
                    "most once, and only when a result carried cache_hit=true with segments_summary.count "
                    "0 (an old cached result without timing). A fresh result without timing gains none "
                    "on a retry: follow its segments_note."
                ),
                "default": False,
            },
        },
    },
}


IMAGE_OCR_SCHEMA = {
    "name": "image_ocr",
    "description": (
        "识别社媒图文/图片里的文字（抖音/TikTok 图文、小红书图文、快手图片）。"
        "用户发来图文笔记/图片链接、或想「提取图片文字/读菜单价格/读截图文字」时用本工具：传社媒分享链接 url，"
        "或直接传图片地址 image_urls 列表。不要用浏览器打开这些链接。本工具只读字，不理解非文字画面/场景/构图。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "社媒图文分享链接/分享口令（抖音图文、小红书图文、快手图片、TikTok photo），平台自动识别并提取图片。",
            },
            "image_urls": {
                "type": "array",
                "items": {"type": "string"},
                "description": "可选：直接给出的图片地址列表（已有图片 URL 时用，无需再传 url）。",
            },
            "prompt": {
                "type": "string",
                "description": "可选：用户对这些图片文字的具体需求（如「提取菜单价格」「读出截图里的文案」）。",
            },
        },
    },
}


def _legacy_check_image() -> bool:
    # hc-320: image OCR needs local RapidOCR; surfaced by /media/douyin/check.
    api_key = _agent_api_key()
    if not api_key:
        return False
    request = urllib.request.Request(
        f"{_api_base()}/media/douyin/check",
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            data = json.loads(response.read().decode("utf-8"))
            return bool(data.get("image_ocr_available"))
    except Exception:
        return False


def _check_image() -> bool:
    if _use_gateway():
        return bool(_gateway.agent_api_key())
    return _legacy_check_image()


# ── 网关模式的媒体编排(PD §8:网关只出直链/元数据,媒体本端自取;ASR 上传仅音轨) ──

def _gateway_resolve_download(
    url: str, *, timeout: float = _PLATFORM_REQUEST_TIMEOUT_SECONDS
) -> tuple[dict[str, Any], str]:
    """经网关解析分享链接:返回 (含元数据的结果 dict, 直链 media_url——可为空)。"""
    platform = _gateway.detect_platform(url)
    if not platform:
        raise _gateway.GatewayError(
            "无法从链接识别社媒平台（当前可下载：抖音/小红书/快手/B站），"
            "请发送原始分享链接或分享口令；其他平台的视频请直接发送视频文件。"
        )
    response = _gateway.request_json(
        "POST", f"/tools/v1/social/{platform}/download", {"url": url}, timeout=timeout
    )
    result = _gateway.unwrap(response)
    media_url = str(
        result.get("download_url") or result.get("media_url") or result.get("video_url") or ""
    ).strip()
    result.setdefault("platform", platform)
    return result, media_url


def _download_candidates(result: dict[str, Any], media_url: str) -> list[str]:
    """主 URL 在前、fallback 按服务端顺序；去空去重但不改优先级。"""
    raw = [media_url]
    fallbacks = result.get("fallback_urls")
    if isinstance(fallbacks, list):
        raw.extend(str(item or "").strip() for item in fallbacks)
    return list(dict.fromkeys(item for item in raw if item))


class _ResolvedMediaDownloadError(_gateway.GatewayError if _gateway is not None else RuntimeError):
    """本地候选均失败；保留最新签名供既有网关自取 ASR 兜底。"""

    def __init__(self, result: dict[str, Any], media_url: str):
        super().__init__(
            "视频直链下载中断,主线路、备用线路和链接刷新均未完成;"
            "请稍后重试或直接上传视频文件。",
            code="media_download_exhausted",
        )
        self.result = result
        self.media_url = media_url


def _gateway_download_resolved_media(
    source_url: str,
    result: dict[str, Any],
    media_url: str,
) -> tuple[dict[str, Any], Path]:
    """按网关契约下载：main → fallbacks → 最多一次重新解析新签名。"""
    current_result = result
    current_media_url = media_url
    for resolution_round in range(2):
        headers = current_result.get("download_headers")
        for candidate in _download_candidates(current_result, current_media_url):
            try:
                path = _gateway.download_media(
                    candidate,
                    headers=headers if isinstance(headers, dict) else None,
                    filename_hint=str(current_result.get("title") or ""),
                )
                current_result.pop("download_headers", None)
                return current_result, path
            except _gateway.GatewayError:
                continue
        if resolution_round == 0:
            current_result, current_media_url = _gateway_resolve_download(source_url)
    raise _ResolvedMediaDownloadError(current_result, current_media_url)


def _gateway_social_download(url: str) -> str:
    try:
        result, media_url = _gateway_resolve_download(url)
        if media_url:
            result, video_path = _gateway_download_resolved_media(url, result, media_url)
            result["video_path"] = str(video_path)
        else:
            result.pop("download_headers", None)
    except _gateway.GatewayError as exc:
        return tool_error(f"视频下载失败: {exc}")
    result.setdefault("ok", True)
    return tool_result(**result)


def _gateway_media_transcribe(
    video_path: str | None,
    url: str | None,
    force_refresh: bool | None = None,
) -> str:
    meta: dict[str, Any] = {}
    local_path: Path | None = None
    media_url = ""
    try:
        if video_path:
            local_path = Path(video_path)
            if not local_path.exists():
                return tool_error(f"视频转写失败: 找不到视频文件 {video_path}，请先用 social_download 下载。")
        elif url:
            meta, media_url = _gateway_resolve_download(url)
            if media_url:
                try:
                    meta, local_path = _gateway_download_resolved_media(url, meta, media_url)
                except _ResolvedMediaDownloadError as exc:
                    # 保留迁移前的最后兜底：本机所有候选均失败后，让网关从最新签名
                    # 自取媒体做 ASR。这里不上传任何 .part/残缺本地文件。
                    meta = exc.result
                    media_url = exc.media_url

        if local_path is not None:
            # hc-560: 压缩链(ffmpeg → macOS afconvert → 原文件)后交统一提交口——
            # ≤阈值 multipart / >阈值 COS 直传三跳,直传通道故障自动回退 multipart。
            upload_path = _gateway.extract_audio_for_asr(local_path) or local_path
            response = _gateway.transcribe_upload(
                upload_path,
                timeout=_MEDIA_TRANSCRIBE_TIMEOUT_SECONDS,
                force_refresh=force_refresh,
            )
        elif media_url:
            response = _gateway.transcribe_media_url(
                media_url,
                timeout=_MEDIA_TRANSCRIBE_TIMEOUT_SECONDS,
                force_refresh=force_refresh,
            )
        else:
            return tool_error(
                "视频转写失败: 平台未能给出该内容的可下载媒体（可能是图文/直播链接），"
                "请确认是视频分享链接，或先用 social_download 检查。"
            )
    except _gateway.GatewayError as exc:
        if exc.code != _ASR_NO_SPEECH_CODE:
            return tool_error(f"视频转写失败: {exc}")
        # 三个 ASR 出口(multipart / 直传三跳 / media_url)都经 request_json 落到这里:
        # 没有人声是结论,走下面同一个结果面(speech=false),不计费也不报错。
        response = {}

    transcript = str(response.get("text") or "").strip()
    title = str(meta.get("title") or "").strip()
    result: dict[str, Any] = {
        "ok": True,
        "transcript": transcript,
        **_speech_fields(transcript),
        "video_path": str(local_path) if local_path is not None else None,
        "title": title or None,
        "author": meta.get("author"),
        "audio_duration_seconds": response.get("duration_seconds"),
    }
    if response.get("cost_cents") is not None:
        result["cost_cents"] = response.get("cost_cents")
    if response.get("cache_hit") is not None:
        result["cache_hit"] = bool(response.get("cache_hit"))
    stem = _transcript_file_stem(title)
    transcript_path = _write_transcript_file(transcript, stem)
    if transcript_path:
        result["transcript_path"] = transcript_path
    result.update(_segments_result_fields(response.get("segments"), stem))
    result.update(_no_timing_fields(result, transcript, response.get("cache_hit")))
    # hc-341: pre-render the verbatim transcript so "完整文案/逐字稿/下载文案" is delivered
    # as the original speech, copied verbatim — the agent only emits the MEDIA line.
    if transcript and _doc_file_delivery_available():
        doc_path = render_verbatim_transcript_docx(transcript, title)
        if doc_path:
            result["transcript_doc_path"] = doc_path
            result["transcript_doc_media_tag"] = f"MEDIA:{doc_path}"
            result["transcript_doc_instruction"] = _TRANSCRIPT_DOC_INSTRUCTION
    return tool_result(**result)


def _write_transcript_file(transcript: str, stem: str) -> str | None:
    """把转写全文落成本地 txt(保持迁移前 transcript_path 的结果面)。"""
    if not transcript:
        return None
    try:
        dest = _document_cache_dir() / f"{stem}.txt"
        dest.write_text(transcript, encoding="utf-8")
        return str(dest)
    except Exception:
        return None


def _gateway_image_ocr(payload: dict[str, Any]) -> str:
    # image-ocr 的 OCR 在云侧执行;platform 路径段只作路由/白名单——裸图片 URL
    # 识别不出平台时回退 "douyin"(见 plugins/apexnodes_gateway.py 契约表)。
    probe_text = " ".join(
        [str(payload.get("url") or "")] + [str(u) for u in (payload.get("image_urls") or [])]
    )
    platform = _gateway.detect_platform(probe_text) or "douyin"
    try:
        response = _gateway.request_json(
            "POST", f"/tools/v1/social/{platform}/image-ocr", payload,
            timeout=_PLATFORM_REQUEST_TIMEOUT_SECONDS,
        )
    except _gateway.GatewayError as exc:
        return tool_error(f"图片 OCR 失败: {exc}")
    return tool_result(**_gateway.unwrap(response))


def _routed_intent(args: dict) -> str | None:
    """hc-450: log-only marker the intent-router hook stamps onto a routed call;
    forwarded so the master can emit its structured intent_router_hit line."""
    value = str(args.get("routed_intent") or "").strip()
    return value[:64] or None


def _handle_social_download(args: dict, **_kwargs) -> str:
    if not isinstance(args, dict):
        return tool_error("social_download 的参数必须是 JSON 对象。")
    url = str(args.get("url") or args.get("share_url") or "").strip()
    if not url:
        return tool_error("请提供视频分享链接")
    if _use_gateway():
        return _gateway_social_download(url)
    payload: dict[str, Any] = {"url": url}
    if _routed_intent(args):
        payload["routed_intent"] = _routed_intent(args)
    try:
        return tool_result(**_post("/media/social-download", payload))
    except RuntimeError as exc:
        return tool_error(f"视频下载失败: {exc}")


# ── hc-341: verbatim transcript → .docx (programmatic, container-side) ────────
# A "完整文案 / 逐字稿 / 下载文案" request must deliver the ASR text copied verbatim.
# Prompt-only carve-outs didn't hold — the model kept restructuring the body when it
# round-tripped through doc_file_write. So we render the .docx here, straight from the
# transcribe result, and hand the agent a ready MEDIA tag: it only triggers the export,
# it never regenerates the text. Gated to the non-Feishu IM entries where a .docx is the
# delivery (Feishu keeps feishu_doc_write); mirrors apexnodes-doc-file-write's renderer.
_NON_FEISHU_IM_ENV_MARKERS = ("WEIXIN_TOKEN", "WECOM_BOT_ID", "DINGTALK_CLIENT_ID", "QQ_APP_ID")
# Group a one-blob ASR transcript into readable paragraphs at sentence boundaries —
# inserts paragraph breaks only, never alters a character (keeps 原话原序照搬).
_SENTENCE_BOUNDARY_RE = re.compile(r"(?<=[。！？!?…])")
_VERBATIM_PARAGRAPH_MAX_CHARS = 180
_VERBATIM_PARAGRAPH_MAX_SENTENCES = 4
_TRANSCRIPT_DOC_INSTRUCTION = (
    "用户要完整文案/逐字稿/转写全文/下载文案/原话时：直接在回复里单独一行输出 "
    "transcript_doc_media_tag 的值，把这份逐字稿文件发给用户——正文已是转写原文逐字照搬。"
    "不要再调用 doc_file_write，不要把逐字稿重排成结构化文档（加标题/小节、表格、要点都不行）。"
)


def _doc_file_delivery_available() -> bool:
    """True only when python-docx is importable AND this is a non-Feishu IM entry —
    the same gate apexnodes-doc-file-write uses, so the verbatim .docx export only
    surfaces where a Feishu doc link can't be opened."""
    import importlib.util

    try:
        if importlib.util.find_spec("docx") is None:
            return False
    except (ImportError, ValueError):
        return False
    return any((os.getenv(marker) or "").strip() for marker in _NON_FEISHU_IM_ENV_MARKERS)


def _document_cache_dir() -> Path:
    """Runtime document cache dir (a media-delivery safe root), matching doc_file_write."""
    home: str | None = None
    try:  # match the runtime's canonical HERMES_HOME resolution when available
        from hermes_constants import get_hermes_home

        home = str(get_hermes_home())
    except Exception:
        home = os.getenv("HERMES_HOME") or str(Path.home() / ".hermes")
    cache_dir = Path(home) / "cache" / "documents"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _safe_filename(title: str) -> str:
    base = re.sub(r"[\\/\x00-\x1f]", " ", title or "").strip()
    base = re.sub(r"\s+", " ", base) or "视频逐字稿"
    return base[:60]


def _set_cjk_font(doc, font_name: str = "Microsoft YaHei") -> None:
    """Request a CJK font on the Normal style so viewers render Chinese (best-effort)."""
    try:
        from docx.oxml.ns import qn

        style = doc.styles["Normal"]
        style.font.name = font_name
        rpr = style.element.get_or_add_rPr()
        rfonts = rpr.get_or_add_rFonts()
        rfonts.set(qn("w:eastAsia"), font_name)
    except Exception:
        pass


def _verbatim_paragraphs(transcript: str) -> list[str]:
    """Split the transcript into readable paragraphs without changing any words.

    Respects segmentation the transcript already carries (newlines); otherwise groups
    sentences from a single ASR blob. Only paragraph breaks are added — the speaker's
    words and their order are preserved verbatim (the only processing the逐字稿 allows)."""
    text = (transcript or "").strip()
    if not text:
        return []
    explicit = [seg.strip() for seg in re.split(r"\n+", text) if seg.strip()]
    if len(explicit) > 1:
        return explicit
    paragraphs: list[str] = []
    buf: list[str] = []
    for sentence in (s for s in _SENTENCE_BOUNDARY_RE.split(text) if s.strip()):
        buf.append(sentence)
        if len(buf) >= _VERBATIM_PARAGRAPH_MAX_SENTENCES or sum(len(s) for s in buf) >= _VERBATIM_PARAGRAPH_MAX_CHARS:
            paragraphs.append("".join(buf))
            buf = []
    if buf:
        paragraphs.append("".join(buf))
    return paragraphs or [text]


def render_verbatim_transcript_docx(transcript: str, title: str) -> str | None:
    """Render the verbatim transcript to a .docx (heading + raw paragraphs) and return
    its path, or None on any failure. No markdown parsing and no headings/tables/bullets
    inside the body — the document is the speaker's original words, copied verbatim."""
    try:
        from docx import Document
    except ImportError:
        return None
    paragraphs = _verbatim_paragraphs(transcript)
    if not paragraphs:
        return None
    try:
        heading = (str(title or "").strip() or "视频逐字稿")[:120]
        doc = Document()
        _set_cjk_font(doc)
        doc.add_heading(heading, level=0)
        for para in paragraphs:
            doc.add_paragraph(para)
        dest = _document_cache_dir() / f"{_safe_filename(heading)}_逐字稿_{uuid.uuid4().hex[:8]}.docx"
        doc.save(str(dest))
        return str(dest)
    except Exception:
        return None


def _handle_media_transcribe(args: dict, **_kwargs) -> str:
    if not isinstance(args, dict):
        return tool_error("media_transcribe 的参数必须是 JSON 对象。")
    video_path = str(args.get("video_path") or "").strip() or None
    url = str(args.get("url") or args.get("share_url") or "").strip() or None
    force_refresh = bool(args.get("force_refresh")) if "force_refresh" in args else None
    if not video_path and not url:
        return tool_error("请提供 video_path 或视频分享链接")
    if _use_gateway():
        return _gateway_media_transcribe(video_path, url, force_refresh)
    payload: dict[str, Any] = {"video_path": video_path, "url": url}
    if force_refresh is not None:
        payload["force_refresh"] = force_refresh
    if _routed_intent(args):
        payload["routed_intent"] = _routed_intent(args)
    try:
        result = _post("/media/transcribe", payload, timeout=_MEDIA_TRANSCRIBE_TIMEOUT_SECONDS)
    except RuntimeError as exc:
        if getattr(exc, "code", None) != _ASR_NO_SPEECH_CODE:
            return tool_error(f"视频转写失败: {exc}")
        result = {"ok": True, "transcript": ""}
        if video_path:
            result["video_path"] = video_path
    # hc-341: pre-render the verbatim transcript so "完整文案/逐字稿/下载文案" is delivered
    # as the original speech, copied verbatim — the agent only emits the MEDIA line.
    transcript = str(result.get("transcript") or "").strip()
    result.update(_speech_fields(transcript))
    # master 把时间轴整段内联在响应里,与网关腿同样改交本机文件(transcript_path 仍是 master 的)。
    stem = _transcript_file_stem(str(result.get("title") or ""))
    result.update(_segments_result_fields(result.pop("segments", None), stem))
    result.update(_no_timing_fields(result, transcript, result.get("cache_hit")))
    if transcript and _doc_file_delivery_available():
        doc_path = render_verbatim_transcript_docx(transcript, str(result.get("title") or ""))
        if doc_path:
            result["transcript_doc_path"] = doc_path
            result["transcript_doc_media_tag"] = f"MEDIA:{doc_path}"
            result["transcript_doc_instruction"] = _TRANSCRIPT_DOC_INSTRUCTION
    return tool_result(**result)


def _handle_image_ocr(args: dict, **_kwargs) -> str:
    if not isinstance(args, dict):
        return tool_error("image_ocr 的参数必须是 JSON 对象。")
    raw_images = args.get("image_urls")
    image_urls = [str(item).strip() for item in raw_images if str(item).strip()] if isinstance(raw_images, list) else None
    payload = {
        "url": str(args.get("url") or args.get("share_url") or "").strip() or None,
        "image_urls": image_urls or None,
        "prompt": str(args.get("prompt") or args.get("question") or "").strip() or None,
    }
    if not payload["url"] and not payload["image_urls"]:
        return tool_error("请提供社媒图文链接 url 或图片地址 image_urls")
    if _use_gateway():
        return _gateway_image_ocr(payload)
    try:
        return tool_result(**_post("/media/image-understand", payload))
    except RuntimeError as exc:
        return tool_error(f"图片 OCR 失败: {exc}")


SOCIAL_BATCH_SUBMIT_SCHEMA = {
    "name": "social_batch_submit",
    "description": (
        "批量下载并转写一批社媒视频（抖音/快手/B站/小红书=下载+转写，YouTube=官方字幕）。"
        "其他平台（如 TikTok、视频号）没有转写通道，会如实标为未处理，不要承诺。"
        "适用于「把某作者点赞超10万的作品批量转写」「把这个抖音合集的视频都转成文字/表格」这类需求。"
        "传 urls（链接清单）或 creator_url（作者主页链接=枚举其全部作品，或某个抖音合集的分享链接=只枚举该合集；配 min_likes/top 自动筛选）。"
        "★这是异步任务：本工具只负责提交，返回 job_id；之后用 social_batch_status 轮询进度。"
        "平台会在 master 侧完成全部下载/转写/出表，你只需提交、轮询、把最终产物发给用户——"
        "绝不要自己写脚本下载、起进程、删文件。单条出 Word、多条出 Excel、飞书多条且给了 bitable_url 则写入多维表格。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "urls": {
                "type": "array",
                "items": {"type": "string"},
                "description": "视频链接清单（每个元素一条分享链接/口令）。与 creator_url 二选一。",
            },
            "creator_url": {
                "type": "string",
                "description": (
                    "作者主页链接（枚举其全部作品），或某个抖音合集的分享链接（douyin.com/collection/… 或 mix/…，"
                    "只枚举该合集内的作品）；平台会枚举并按 min_likes/top 筛选。与 urls 二选一。"
                    "注意：合集请发该【合集】自己的分享链接，仅凭作者主页+合集名无法定位某个合集。"
                ),
            },
            "platform": {"type": "string", "description": "可选，creator_url 的平台（douyin/kuaishou/bilibili/xiaohongshu/youtube）。"},
            "min_likes": {"type": "integer", "description": "可选，creator_url 时只保留点赞≥该值的作品（如 100000）。"},
            "top": {"type": "integer", "description": "可选，最多取前 N 条（按点赞排序）。"},
            "bitable_url": {"type": "string", "description": "可选，飞书多条交付时写入的目标多维表格 /base/ 链接。"},
            "delivery_format": {
                "type": "string",
                "description": "可选，产物格式覆盖：xlsx=强制出 Excel 表格（用户明确要「表格/Excel」时，即使只有一条链接也出表）。缺省按条数自动（单条 Word、多条 Excel）。",
            },
        },
    },
}

SOCIAL_BATCH_STATUS_SCHEMA = {
    "name": "social_batch_status",
    "description": (
        "查询批量转写任务的进度与产物（配合 social_batch_submit 使用）。传 job_id。"
        "状态为 completed/partial 时，结果里 product 含产物：file 类（Word/Excel）给 download_url，"
        "飞书多维表格给 bitable_url——把它发给用户即可。仍在 running 时稍后再轮询，不要重复提交。"
    ),
    "parameters": {
        "type": "object",
        "properties": {"job_id": {"type": "string", "description": "social_batch_submit 返回的任务 id。"}},
        "required": ["job_id"],
    },
}


def _session_target() -> dict | None:
    """hc-371: capture the originating IM session so the master can push the batch
    result back here instead of the agent polling. The v0.17 gateway mirrors the
    turn's session onto ``HERMES_SESSION_*`` (ContextVar → os.environ → tool thread);
    ``get_session_env`` reads it, with a plain ``os.getenv`` fallback if the gateway
    helper isn't importable. ``None`` (no chat_id) ⇒ master can't route ⇒ poll."""
    try:
        from gateway.session_context import get_session_env  # type: ignore
    except Exception:  # pragma: no cover - exercised inside the v0.17 agent only
        def get_session_env(name: str, default: str = "") -> str:
            return os.getenv(name, default)

    chat_id = (get_session_env("HERMES_SESSION_CHAT_ID", "") or "").strip()
    if not chat_id:
        return None
    target = {"chat_id": chat_id}
    for key, env in (("platform", "HERMES_SESSION_PLATFORM"), ("user_id", "HERMES_SESSION_USER_ID")):
        value = (get_session_env(env, "") or "").strip()
        if value:
            target[key] = value
    return target


def _decorate_batch_submit(result: dict[str, Any]) -> dict[str, Any]:
    if result.get("async_delivery"):
        # The master will push the finished result straight to this chat — no poll.
        result["_instruction"] = (
            "已提交批量任务。任务在 master 侧异步执行，完成后平台会【自动把结果推送到当前会话】，"
            "你无需轮询、可以直接结束本轮；完成时用户会收到总结与产物链接。"
            "请勿重复提交、勿自己下载或起脚本。"
        )
    else:
        result["_instruction"] = (
            "已提交批量任务。请记住 job_id，稍后用 social_batch_status 轮询；任务在 master 侧异步执行，"
            "完成前不要重复提交、不要自己下载或起脚本。完成后把产物链接发给用户。"
        )
    return result


def _decorate_batch_status(result: dict[str, Any]) -> dict[str, Any]:
    status = result.get("status")
    if status in ("completed", "partial"):
        result["_instruction"] = (
            "任务已完成。result.note 是给用户的总结；product 是产物："
            "若有 download_url(Word/Excel) 就把文件发给用户，若有 bitable_url 就把多维表格链接发给用户。"
        )
    elif status == "failed":
        result["_instruction"] = "任务失败，把 result.note / error 里的原因如实告诉用户。"
    else:
        result["_instruction"] = "任务仍在进行中（still running）。稍等片刻再用 social_batch_status 轮询，不要重复提交。"
    return result


def _read_batch_response(body: dict[str, Any]) -> dict[str, Any]:
    """批量端点响应直读(hc-567):云端 ``/tools/v1/social/batch/*`` 返回**平铺形**
    ``{ok, job_id, status, ...}``(cloud app/routers/tools_gateway.py 直接
    ``return {"ok": True, **status}``,没有 ``{data: {...}}`` 信封)——此前误走
    ``_gateway.unwrap``,平铺响应被解成空 dict、job_id 丢失,桌面批量流程断链。
    宽容读法:若某版本服务端把结果包进 data 信封(dict),兼容取内层;否则平铺
    直读。两形并存兼容,勿再换个方向锁死单一形状。
    """
    data = body.get("data")
    if isinstance(data, dict):
        return dict(data)
    return dict(body)


def _handle_social_batch_submit(args: dict, **_kwargs) -> str:
    if not isinstance(args, dict):
        return tool_error("social_batch_submit 的参数必须是 JSON 对象。")
    urls = args.get("urls")
    if isinstance(urls, str):
        urls = [urls]
    payload = {
        "urls": [str(u).strip() for u in urls if str(u).strip()] if isinstance(urls, list) else None,
        "creator_url": str(args.get("creator_url") or "").strip() or None,
        "platform": str(args.get("platform") or "").strip() or None,
        "min_likes": int(args.get("min_likes") or 0),
        "top": args.get("top"),
        "bitable_url": str(args.get("bitable_url") or "").strip() or None,
        # hc-450 PR2: explicit product-format override(今日仅 "xlsx")——legacy
        # /media/batch/submit 与网关 /tools/v1/social/batch/submit 两端点同形接收。
        "delivery_format": str(args.get("delivery_format") or "").strip().lower() or None,
        # hc-371: routing snapshot; the master stores it and pushes the result on
        # completion. Always captured (harmless when the feature is off — nothing
        # reads it until the master's async-delivery flag is armed for this agent;
        # 桌面形态没有 IM 会话 env ⇒ None ⇒ 轮询模式).
        "delivery_target": _session_target(),
    }
    # hc-450 PR1 观测透传:legacy 端点打 intent_router_hit 结构化行;网关端点当前
    # 忽略该字段(服务端模型未收,pydantic 默认丢弃)——共用同一 payload,服务端补字段后即生效。
    if _routed_intent(args):
        payload["routed_intent"] = _routed_intent(args)
    if not payload["urls"] and not payload["creator_url"]:
        return tool_error("请提供 urls(链接清单) 或 creator_url(作者主页链接，或某个抖音合集的分享链接)。")
    if _use_gateway():
        try:
            result = _read_batch_response(
                _gateway.request_json("POST", "/tools/v1/social/batch/submit", payload, timeout=120)
            )
        except _gateway.GatewayError as exc:
            return tool_error(f"批量任务提交失败: {exc}")
        return tool_result(**_decorate_batch_submit(result))
    try:
        result = _post("/media/batch/submit", payload, timeout=120)
    except RuntimeError as exc:
        return tool_error(f"批量任务提交失败: {exc}")
    return tool_result(**_decorate_batch_submit(result))


def _handle_social_batch_status(args: dict, **_kwargs) -> str:
    if not isinstance(args, dict):
        return tool_error("social_batch_status 的参数必须是 JSON 对象。")
    job_id = str(args.get("job_id") or "").strip()
    if not job_id:
        return tool_error("请提供 job_id。")
    if _use_gateway():
        try:
            result = _read_batch_response(
                _gateway.request_json("GET", f"/tools/v1/social/batch/status/{job_id}", timeout=60)
            )
        except _gateway.GatewayError as exc:
            return tool_error(f"查询批量任务失败: {exc}")
        return tool_result(**_decorate_batch_status(result))
    try:
        result = _get(f"/media/batch/status/{job_id}")
    except RuntimeError as exc:
        return tool_error(f"查询批量任务失败: {exc}")
    return tool_result(**_decorate_batch_status(result))


def register(ctx):
    ctx.register_tool(
        name="social_download",
        toolset="skills",
        schema=SOCIAL_DOWNLOAD_SCHEMA,
        handler=_handle_social_download,
        check_fn=_check,
        requires_env=[],
        description=SOCIAL_DOWNLOAD_SCHEMA["description"],
        emoji="⬇️",
        execution_timeout=_PLATFORM_REQUEST_TIMEOUT_SECONDS,
    )
    ctx.register_tool(
        name="media_transcribe",
        toolset="skills",
        schema=MEDIA_TRANSCRIBE_SCHEMA,
        handler=_handle_media_transcribe,
        check_fn=_check,
        requires_env=[],
        description=MEDIA_TRANSCRIBE_SCHEMA["description"],
        emoji="📝",
        execution_timeout=_MEDIA_TRANSCRIBE_TIMEOUT_SECONDS,
    )
    ctx.register_tool(
        name="image_ocr",
        toolset="skills",
        schema=IMAGE_OCR_SCHEMA,
        handler=_handle_image_ocr,
        check_fn=_check_image,
        requires_env=[],
        description=IMAGE_OCR_SCHEMA["description"],
        emoji="🖼️",
        execution_timeout=_PLATFORM_REQUEST_TIMEOUT_SECONDS,
    )
    ctx.register_tool(
        name="social_batch_submit",
        toolset="skills",
        schema=SOCIAL_BATCH_SUBMIT_SCHEMA,
        handler=_handle_social_batch_submit,
        check_fn=_check,
        requires_env=[],
        description=SOCIAL_BATCH_SUBMIT_SCHEMA["description"],
        emoji="📦",
    )
    ctx.register_tool(
        name="social_batch_status",
        toolset="skills",
        schema=SOCIAL_BATCH_STATUS_SCHEMA,
        handler=_handle_social_batch_status,
        check_fn=_check,
        requires_env=[],
        description=SOCIAL_BATCH_STATUS_SCHEMA["description"],
        emoji="🔎",
    )
