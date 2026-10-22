"""ApexNodes 平台工具网关客户端(P1)——插件共用的唯一 vendor 出口。

背景(DESKTOP-CLOUD-CAPABILITY-PARITY-PD §3 D1):桌面与云端跑同一份插件、
同一个网关调用;vendor key(TikHub/豆包/…)永不出云。差异只剩一个 base_url:
云容器走内网 base(env),桌面走公网 ``https://api.apex-nodes.com``。

── API 契约(与 hermes-cloud 网关腿并行开发,以本表为准) ────────────────────────
鉴权:``Authorization: Bearer <Agent API key>``;请求头 ``X-Capability-Version=<runtime 版本>``。

ASR 族:
  POST {base}/tools/v1/asr/transcribe
    JSON  {"media_url": str}                            ← 基本形态(网关自取媒体)
    multipart file=<音频/视频文件>                        ← ≤阈值小文件:本地抽音轨压缩后上传
                                                          (压缩链 ffmpeg → macOS afconvert
                                                          兜底 → 原文件,PD §8)
    → {"text": str, "segments"?: [...], "duration_seconds": float, "cost_cents": int}
  POST {base}/tools/v1/asr/upload-url                   ← hc-560 大文件三跳(>阈值,默认 8MB):
    {"filename": str, "size_bytes": int,                  ① 领预签名 → ② PUT put_url 直传 COS
     "content_type"?: str}                                → ③ JSON media_url 提交 transcribe;
    → {"put_url": str, "media_url": str,                  直传通道不可用(旧网关 404/COS 故障/
       "expires_in": int, ...}                            PUT 失败)自动回退 multipart,转写本身
                                                          的业务错误(402/413/429)原样透出

社媒族(platform ∈ SOCIAL_PLATFORMS 10 平台白名单):
  POST {base}/tools/v1/social/{platform}/{action} → {"data": {...}, "cost_cents": int}
    action(从存量插件调用面整理,一一对应):
      content|search|profile|comments|trending|posts|captions ← apexnodes-social-tools 七工具
      top-posts                                              ← creator_top_posts
      download                                               ← social_download。data 返回
                                                               直链 download_url(+可选
                                                               fallback_urls/download_headers)
                                                               与元数据;本端按主→备用→
                                                               一次刷新取件,断流严格续传
                                                               (PD §8 / hc-735)
      image-ocr                                              ← image_ocr({url|image_urls,
                                                               prompt};OCR 在云侧执行;仅有
                                                               裸图片 URL 识别不出平台时,
                                                               路径段回退 "douyin"——该段
                                                               只作路由/白名单用途)
  批量任务(族级端点,不带 platform 段;master 侧编排,与存量 /media/batch/* 同语义):
    POST {base}/tools/v1/social/batch/submit               ← social_batch_submit
    GET  {base}/tools/v1/social/batch/status/{job_id}      ← social_batch_status

视频生成族:
  POST {base}/tools/v1/video/generate → {"data": {...}, "cost_cents": int}
                                                           ← generate_video
  GET  {base}/tools/v1/check → image/video 段带 hc-945 的逐链路健康(legs)
                                                           ← 生成前预检(hc-969)

错误语义(全部显式降级文案,不静默吞):
  401 key 失效→提示重新登录;402 配额/余额;429 限流(本客户端带有限退避重试,
  日限 429 除外);503 按 download resolve / ASR / 图片视频生成 / 其他能力分段,
  不向用户暴露供应商细节;其余透传 detail。图片/视频生成只在能自己恢复的失败上
  提示再试(hc-969,见 media_error_message)。
──────────────────────────────────────────────────────────────────────────────

模式解析(insight:云端 P1 回退通道 = 旧 master 内网端点,PD §8):
  1. ``TOOLS_GATEWAY_DISABLED=1``            → 关网关(插件回退旧 master 直连路径);
  2. ``TOOLS_GATEWAY_BASE`` 已设             → 网关模式,用该 base;
  3. 桌面已登录(config.yaml custom_providers 里有 Apex-nodes.com 托管条目)
                                             → 网关模式,base=公网 ``https://api.apex-nodes.com``;
  4. 都没有                                  → 非网关模式(云容器零新 env 时行为与迁移前
                                               完全一致,走各插件的 legacy 默认 base)。

Agent API key 解析(桌面与云同一把 key 的两种落点):
  ``TOOLS_GATEWAY_KEY`` > ``API_SERVER_KEY`` > ``MODEL_API_KEY``(云容器 env,存量插件同源)
  > ``~/.hermes/config.yaml`` 里 ``custom_providers`` 的 Apex-nodes.com 托管条目 ``api_key``
  (桌面 provision-key 写入,见 apps/desktop/electron/apex-managed.cjs)。
"""

from __future__ import annotations

import json
import logging
import math
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

__all__ = [
    "DAILY_LIMIT_CODES",
    "DESKTOP_SPAWN_ENV_CONTRACT",
    "GATEWAY_PUBLIC_BASE",
    "MEDIA_IMAGE",
    "MEDIA_VIDEO",
    "SOCIAL_PLATFORMS",
    "SOURCE_CONFIG",
    "SOURCE_ENV",
    "SOURCE_NONE",
    "GatewayError",
    "agent_api_key",
    "asr_direct_upload_threshold_bytes",
    "capability_version",
    "credential_source",
    "detect_platform",
    "download_media",
    "extract_audio_for_asr",
    "gateway_base",
    "gateway_disabled",
    "guess_media_content_type",
    "media_cache_dir",
    "media_error_message",
    "media_unavailable_reason",
    "missing_credential_error",
    "request_json",
    "resolve_agent_api_key",
    "stale_credential_message",
    "tools_check",
    "transcribe_upload",
    "unwrap",
    "use_gateway",
]

GATEWAY_PUBLIC_BASE = "https://api.apex-nodes.com"
TOOLS_PREFIX = "/tools/v1"

ENV_BASE = "TOOLS_GATEWAY_BASE"
ENV_KEY = "TOOLS_GATEWAY_KEY"
ENV_DISABLED = "TOOLS_GATEWAY_DISABLED"
# 各插件 legacy 直连路径的 Scheduler base(桌面注入公网值,云容器注入内网值)。
ENV_LEGACY_BASE = "HERMES_PLATFORM_API_BASE"

# hc-604:桌面端 spawn 必须注入的 env —— 唯一声明处。
#
# 两个消费者,两条独立路径,谁也不引用谁的实现:
#   - apps/desktop/electron/apex-platform-tools.ts 的 buildPlatformToolSpawnEnv
#     负责发出这三个键;它的单测直接从本文件读这个字面量做比对,漏一个即红。
#   - tests/plugins/test_desktop_platform_tool_credentials.py 只把这三个键设进
#     环境,然后枚举磁盘上每一个 plugins/apexnodes-* 目录,断言它们都能解析出
#     凭据与公网 base。新增平台工具插件被 glob 自动纳管,无需登记。
#
# 为什么是 TOOLS_GATEWAY_KEY 而不是 API_SERVER_KEY:后者是 runtime 自身
# OpenAI 兼容 API server 的 bearer(hermes_cli/config.py:"Required whenever the
# API server is enabled"),把两种互不相干的凭据塞进同一个变量名,是下一次三天
# 排查的起点。TOOLS_GATEWAY_KEY 只被本客户端读。
DESKTOP_SPAWN_ENV_CONTRACT = (ENV_KEY, ENV_BASE, ENV_LEGACY_BASE)

# 凭据来源(credential_source() 的取值)——错误文案据此给出**真正有用**的下一步,
# 而不是一句放之四海皆无效的「请重新登录」。
SOURCE_NONE = "none"  # 哪儿都没有:从未配置 / 未登录
SOURCE_ENV = "env"  # 桌面 spawn 注入 / 云容器 env
SOURCE_CONFIG = "config"  # config.yaml custom_providers 兜底副本(可能是陈的)

# 10 平台白名单(PD §2 目标 3;新平台=网关配置变更,本端零改动)。
SOCIAL_PLATFORMS = (
    "douyin",
    "xiaohongshu",
    "tiktok",
    "instagram",
    "youtube",
    "bilibili",
    "kuaishou",
    "wechat_mp",
    "wechat_channels",
    "twitter",
)

# 分享链接 → 平台识别(顺序敏感:mp.weixin 必须先于 weixin 域族)。
_PLATFORM_HOST_SIGNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("wechat_mp", ("mp.weixin.qq.com",)),
    ("wechat_channels", ("channels.weixin.qq.com", "finder.video.qq.com")),
    ("douyin", ("v.douyin.com", "douyin.com", "iesdouyin.com")),
    ("xiaohongshu", ("xhslink.com", "xiaohongshu.com")),
    ("tiktok", ("tiktok.com",)),
    ("kuaishou", ("v.kuaishou.com", "kuaishou.com", "gifshow.com")),
    ("bilibili", ("bilibili.com", "b23.tv")),
    ("youtube", ("youtube.com", "youtu.be")),
    ("instagram", ("instagram.com",)),
    ("twitter", ("twitter.com", "x.com", "t.co")),
)

_TRUTHY = {"1", "true", "yes", "on"}

# 429 有限退避:最多重试 2 次,Retry-After 上限 8s(媒体长轮询场景不宜久睡)。
_MAX_429_RETRIES = 2
_MAX_RETRY_AFTER_SECONDS = 8.0

# hc-735: vendor 直链属于短时效 CDN 资源。单一 URL 内允许「首次 + 两次恢复」；
# URL 之间的主/fallback/重新解析编排由调用插件负责，避免共享下载器知道业务协议。
_MEDIA_DOWNLOAD_ATTEMPTS = 3
_CONTENT_RANGE_RE = re.compile(r"^bytes (\d+)-(\d+)/(\d+)$", re.IGNORECASE)

# hc-560 大音频直传:>阈值走「upload-url → PUT 直传 COS → JSON media_url 提交」,
# ≤阈值维持 multipart(默认 8MB,env 可调;0=全部直传,拉大=事实关停直传)。
ENV_ASR_DIRECT_UPLOAD_THRESHOLD = "TOOLS_GATEWAY_ASR_DIRECT_UPLOAD_THRESHOLD_BYTES"
ASR_DIRECT_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024
_ASR_UPLOAD_URL_TIMEOUT_SECONDS = 60.0  # 预签名是元数据小调用
_ASR_PUT_CHUNK_BYTES = 1024 * 1024
_ASR_PUT_ATTEMPTS = 2  # 首次 + 重试一次
# 转写通道的业务性判定(额度/尺寸/限流/鉴权):upload-url 返回这些时按最终结论
# 原样抛出,不再让同一请求换 multipart 通道重演一遍(尤其 413——回退只会把超限
# 文件再推一次 web 层)。其余(旧网关 404、503 direct_upload_unavailable、网络
# 故障)才是「通道不可用」,回退 multipart。
_ASR_DIRECT_VERDICT_STATUSES = frozenset({401, 402, 413, 429})


class GatewayError(RuntimeError):
    """网关调用失败——message 即面向用户的显式降级文案(中文,不静默)。

    ``vendor_code`` 是 503 ``vendor_unavailable`` 背后服务端自己的 code(hc-969)。"""

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
        vendor_code: str | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.vendor_code = vendor_code


# ---------------------------------------------------------------------------
# 面向用户的报错:中英两版(hc-984)
# ---------------------------------------------------------------------------
# Every sentence this client (and the apexnodes image/video tools through it) writes
# itself, as (zh, en). The language is the user's: HERMES_LANGUAGE, then
# display.language in config.yaml (the Desktop writes zh by default and the user can
# switch to English), Chinese unless that is English. The hosted copies in apex-nodes
# use the same rule (hc-961 sets zh there). The server's own sentences are passed on
# as they are. ``{label}`` / ``{Label}`` name the media (图片/视频, image/video).
_COPY: dict[str, tuple[str, str]] = {
    "credential_missing_desktop": (
        "尚未登录 ApexNodes 账号,平台工具(图片/视频生成、图片 OCR、媒体转写)不可用。"
        "请打开 设置 → 账户 完成登录;登录后本对话直接重试即可,无需其他配置。",
        "You are not signed in to ApexNodes, so platform tools (image/video generation, image OCR, "
        "media transcription) are unavailable. Open Settings → Account and sign in; then simply try "
        "again in this chat, nothing else to set up.",
    ),
    "credential_missing_container": (
        "本环境没有平台凭据,平台工具不可用。请为容器注入 {env_key}(或 API_SERVER_KEY),再重启 Agent 容器。",
        "This environment has no platform credential, so platform tools are unavailable. Inject "
        "{env_key} (or API_SERVER_KEY) into the container and restart the Agent container.",
    ),
    "credential_stale_config": (
        "平台凭据被服务端拒绝(401);当前用的是 config.yaml 里的备用副本,它可能已经过期。"
        "请先把 APEX 更新到最新版并重启(桌面端会在启动时自动换发凭据);若更新后仍然如此,"
        "再到 设置 → 账户 重新登录一次。",
        "The server rejected the platform credential (401). The one in use is the backup copy in "
        "config.yaml, which may have expired. Update APEX to the latest version and restart it (the "
        "Desktop re-issues the credential at start-up); if it still happens, sign in again under "
        "Settings → Account.",
    ),
    "credential_stale_desktop": (
        "平台凭据被服务端拒绝(401)。请到 设置 → 账户 重新登录一次以换发凭据;"
        "若刚登录过仍然如此,请重启 APEX(启动时会自动换发)。",
        "The server rejected the platform credential (401). Sign in again under Settings → Account "
        "to get a new one; if you just did, restart APEX (it re-issues the credential at start-up).",
    ),
    "credential_stale_container": (
        "平台凭据被服务端拒绝(401):该 Agent Key 可能已轮换或被停用,请管理员重新下发 Agent Key 后重启容器。",
        "The server rejected the platform credential (401): this Agent Key may have been rotated or "
        "disabled. An admin needs to issue a new Agent Key and restart the container.",
    ),
    "quota_402": (
        "平台工具额度不足(402):套餐配额已用尽或余额不足,请升级套餐/充值后再试。",
        "Not enough platform tool quota (402): the plan's allowance or the balance has run out. "
        "Upgrade the plan or top up, then try again.",
    ),
    "too_large_413": (
        "文件超过平台大小上限(413),本次未能处理。",
        "The file is over the platform's size limit (413) and was not processed.",
    ),
    "rate_limited_429": (
        "平台工具请求过于频繁(429):已自动退避重试仍被限流,请稍等 1-2 分钟再试。",
        "Too many platform tool requests (429): still rate-limited after backing off. Wait 1-2 "
        "minutes and try again.",
    ),
    "download_unavailable_503": (
        "视频链接解析/下载服务暂不可用(503),请稍后重试或直接上传视频文件。",
        "The video link resolving/download service is unavailable right now (503). Try again later "
        "or upload the video file directly.",
    ),
    "asr_unavailable_503": (
        "视频转写服务暂不可用(503),请稍后重试或先提供已有文字稿。",
        "The video transcription service is unavailable right now (503). Try again later or provide "
        "an existing transcript first.",
    ),
    "capability_unavailable_503": (
        "平台能力暂不可用(503),请稍后重试。",
        "This platform capability is unavailable right now (503). Try again later.",
    ),
    "gateway_error_status": ("平台工具网关返回错误(HTTP {status})", "The platform tool gateway returned an error (HTTP {status})"),
    "with_detail": ("{message}(详情: {detail})", "{message} (details: {detail})"),
    "gateway_unconfigured": (
        "平台工具网关未配置(缺 {env_base},亦未检测到桌面登录凭证),无法调用平台能力。",
        "The platform tool gateway is not configured ({env_base} is missing and no Desktop sign-in "
        "was found), so platform capabilities cannot be called.",
    ),
    "network_error": (
        "无法连接平台服务(网络错误):{error}。请检查网络/代理后重试;凭据本身没有问题。",
        "Could not reach the platform service (network error): {error}. Check the network or proxy "
        "and try again; the credential itself is fine.",
    ),
    # hc-984: no retry promise for an answer nobody could read.
    "gateway_unreadable": (
        "平台工具网关的回答读不出来,这次没有结果。",
        "The platform tool gateway sent an answer that could not be read; there is no result this time.",
    ),
    "media_daily_limit": ("今天的{label}生成额度用完了，明天恢复。", "Today's {label} generation quota is used up; it comes back tomorrow."),
    "media_switched_off": (
        "平台现在暂时关闭了{label}生成，重新开放之前重试也不会成功。",
        "The platform has switched {label} generation off for now; retrying will not work until it is back.",
    ),
    "media_not_configured": (
        "平台还没有开通{label}生成服务，重试也不会成功。",
        "The platform has not set up {label} generation; retrying will not help.",
    ),
    "media_auth_failed": (
        "平台的{label}生成服务配置出了问题，要等平台修好才能用，重试也不会成功。",
        "The platform's {label} generation setup is broken and works again only once the platform "
        "fixes it; retrying will not help.",
    ),
    "media_no_reason": ("{label}生成服务出了问题，没有说明原因。", "The {label} generation service had a problem without saying why."),
    "media_no_reason_status": (
        "{label}生成服务出错了({status}),没有说明原因。",
        "The {label} generation service failed ({status}) without saying why.",
    ),
    "media_unreadable": (
        "{label}生成服务的回答读不出来，这次没有结果。",
        "The {label} generation service sent an answer that could not be read; there is no result this time.",
    ),
    "media_paused_model": (
        "你选的{label}模型最近连续几次都没生成成功，平台先暂停了它，{when}；"
        "现在也可以在输入框的「+」菜单里换一个{label}模型。",
        "The {label} model you picked failed several times in a row and the platform paused it; "
        "{when}. You can also pick another {label} model from the \"+\" menu in the input box now.",
    ),
    "media_paused": (
        "{label}生成最近连续几次都没成功，平台先暂停了它，{when}。",
        "{Label} generation failed several times in a row and the platform paused it; {when}.",
    ),
    "when_minutes": ("大约 {minutes} 分钟后可以再试", "try again in about {minutes} minutes"),
    "when_later": ("过一会儿可以再试", "try again in a while"),
    "media_unreachable": ("无法连接{label}生成服务: {reason}", "Could not reach the {label} generation service: {reason}"),
    "media_not_object": ("generate_{media} 的参数必须是 JSON 对象。", "generate_{media} expects a JSON object argument."),
    "media_missing_prompt": ("请提供{label}描述", "Please describe the {label}."),
    "media_failed": ("{label}生成失败: {reason}", "{Label} generation failed: {reason}"),
    "media_setting_malformed": ("当前{label}模型设置格式无效", "The current {label} model setting is malformed"),
    "media_setting_unknown": ("当前{label}模型设置不是可用的模型", "The current {label} model setting is not an available model"),
    "media_setting_unreadable": ("无法读取当前{label}模型设置", "Could not read the current {label} model setting"),
    # Input images (参考图、首帧、首尾帧).
    "input_images_not_list": (
        "images 必须是列表，每一项是 {{source, role, kind}}。",
        "images must be a list of {{source, role, kind}} objects.",
    ),
    "input_image_source_missing": ("images 第 {index} 项没有 source。", "images item {index} has no source."),
    "input_images_unsupported_server": (
        "平台还不支持带图生成(参考图、首帧、首尾帧),这次没有生成。可以先不带图生成，或等平台更新后再试。",
        "The platform does not take input images (references, first or last frames) yet; nothing was "
        "generated. Generate without images for now, or try again after the platform updates.",
    ),
    "input_image_missing": (
        "找不到第 {index} 张图({source}),这次没有生成。请让用户重新发图，或用生成结果里的 image_ref。",
        "Image {index} ({source}) was not found; nothing was generated. Ask for the image again, or use "
        "the image_ref from an earlier result.",
    ),
    "input_image_too_large": (
        "第 {index} 张图超过 {mb} MB,没有上传，这次没有生成。",
        "Image {index} is over {mb} MB and was not uploaded; nothing was generated.",
    ),
    "input_image_download_failed": (
        "第 {index} 张图的链接下载不下来({reason}),这次没有生成。",
        "Image {index}'s link could not be downloaded ({reason}); nothing was generated.",
    ),
    "input_image_upload_failed": (
        "第 {index} 张图上传失败：{reason}。这次没有生成，也不会改成不带图去生成。",
        "Image {index} could not be uploaded: {reason}. Nothing was generated, and nothing will be "
        "generated without the image.",
    ),
}

# (zh, en) media names for ``{label}``.
_MEDIA_NAMES = {"image": ("图片", "image"), "video": ("视频", "video")}


def _configured_display_language() -> str:
    """``display.language`` as the user's config.yaml says it, or "" when it says nothing.

    Read raw (``read_raw_config_readonly``: no defaults merged): the merged runtime config
    fills in the upstream default (``en``), which would make every unset home English
    instead of the APEX default."""
    try:
        from hermes_cli.config import read_raw_config_readonly

        config = read_raw_config_readonly()  # {} for a missing or unparseable file
    except (ImportError, OSError, ValueError):  # outside the runtime / unreadable: the default
        return ""
    display = config.get("display") if isinstance(config, dict) else None
    language = display.get("language") if isinstance(display, dict) else None
    return language if isinstance(language, str) else ""


def ui_language() -> str:
    """``en`` when the user's language is English, otherwise ``zh`` (the APEX default)."""
    configured = (os.getenv("HERMES_LANGUAGE") or "").strip() or _configured_display_language()
    return "en" if configured.strip().lower().startswith("en") else "zh"


def say(key: str, *, media: str | None = None, **fields: Any) -> str:
    """One sentence from :data:`_COPY` in the user's language (hc-984)."""
    zh, en = _COPY[key]
    english = ui_language() == "en"
    if media is not None:
        name = _MEDIA_NAMES[media][1 if english else 0]
        fields = {"label": name, "Label": name.capitalize() if english else name, "media": media, **fields}
    return (en if english else zh).format(**fields)


# ---------------------------------------------------------------------------
# 配置解析:模式 / base / key / 版本
# ---------------------------------------------------------------------------

def gateway_disabled() -> bool:
    """P1 一键回退开关(PD §8):置 1 时插件走迁移前的 master 直连路径。"""
    return (os.getenv(ENV_DISABLED) or "").strip().lower() in _TRUTHY


def _managed_provider_entry() -> dict[str, Any] | None:
    """桌面托管中转的 custom_providers 条目(provision-key 写入 config.yaml)。

    形如 ``{name: Apex-nodes.com, base_url: https://apex-nodes.com/relay/v1,
    api_key: ...}``(apps/desktop/electron/apex-managed.cjs 的
    ``MANAGED_PROVIDER_NAME`` / ``syncCustomProviderKeyYaml``)。找不到或
    config 不可读时返回 None——绝不抛,插件在无桌面形态(云容器)也会走到这。
    """
    try:
        from hermes_cli.config import load_config

        config = load_config() or {}
    except Exception:
        return None
    providers = config.get("custom_providers")
    if not isinstance(providers, list):
        return None
    for entry in providers:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip().lower()
        base = str(entry.get("base_url") or "").strip().lower()
        if name == "apex-nodes.com" or "apex-nodes.com" in base:
            return entry
    return None


def gateway_base() -> str | None:
    """网关 base URL;None 表示本环境未配置网关(回退 legacy 路径)。"""
    env = (os.getenv(ENV_BASE) or "").strip()
    if env:
        return env.rstrip("/")
    if _managed_provider_entry() is not None:
        # 桌面已登录:relay key 与工具网关同一把,公网 base 固定。
        return GATEWAY_PUBLIC_BASE
    return None


def use_gateway() -> bool:
    """插件在本环境是否应走网关(默认走;显式 DISABLED 或无 base 时不走)。"""
    if gateway_disabled():
        return False
    return gateway_base() is not None


def resolve_agent_api_key() -> tuple[str, str]:
    """凭据 + **来源**(SOURCE_ENV / SOURCE_CONFIG / SOURCE_NONE)。

    来源是错误文案的输入,不是装饰:同样一个 401,来自注入 env 与来自 config.yaml
    副本,用户该做的事完全不同(前者=换发凭据,后者=那份副本已陈,重启/更新桌面端
    让它重新同步)。hc-604 之前只有一句「已过期,请重新登录」,在「压根没配过」和
    「副本陈了」两种情形下都是必然无效的指引。
    """
    for env_name in (ENV_KEY, "API_SERVER_KEY", "MODEL_API_KEY"):
        value = (os.getenv(env_name) or "").strip()
        if value:
            return value, SOURCE_ENV
    entry = _managed_provider_entry()
    if entry is not None:
        value = str(entry.get("api_key") or "").strip()
        if value:
            return value, SOURCE_CONFIG
    return "", SOURCE_NONE


def agent_api_key() -> str:
    return resolve_agent_api_key()[0]


def credential_source() -> str:
    return resolve_agent_api_key()[1]


def _is_desktop() -> bool:
    """桌面端形态判定——只影响文案措辞,不影响任何链路选择。

    ``HERMES_DESKTOP`` 是既有的桌面标记(apexnodes-doc-file-write 同款),但只在
    dashboard spawn 上;messaging gateway 子进程没有它。config.yaml 里存在托管
    provider 条目本身就是「这台是登录过的桌面」的充分判据(云容器不会有),两者
    取或,避免同一个错误在两个子进程里说出两种话。
    """
    if (os.getenv("HERMES_DESKTOP") or "").strip():
        return True
    return _managed_provider_entry() is not None


def missing_credential_error() -> GatewayError:
    """「从未配置」——注意:**不是**过期,所以绝不说「重新登录」。

    重新登录的前提是登录过;对一个没登录过的桌面用户,那条指引只会让他在账户页
    反复点击而毫无变化(hc-604 现场:agent 把「缺失」转述成「过期+请重新登录」)。
    """
    if _is_desktop():
        message = say("credential_missing_desktop")
    else:
        message = say("credential_missing_container", env_key=ENV_KEY)
    return GatewayError(message, status=None, code="credential_missing")


def stale_credential_message(source: str) -> str:
    """「有凭据但服务端不认」——按来源给出真正能解决问题的下一步。"""
    if source == SOURCE_CONFIG:
        # env 没注入,读到的是 config.yaml 里的副本。桌面端 0.17.1 及更早只同步
        # model.api_key、漏掉 custom_providers 条目(hc-595 盲区),于是聊天正常
        # 而工具 401——此时「重新登录」并不会修好那份副本,更新/重启才会。
        return say("credential_stale_config")
    if _is_desktop():
        return say("credential_stale_desktop")
    return say("credential_stale_container")


_capability_version_cache: str | None = None


def capability_version() -> str:
    """X-Capability-Version 的取值 = runtime 发行版本(pyproject version)。

    网关用它做版本协商:过旧版本返回明确「请更新引擎」错误(PD §6)。
    """
    global _capability_version_cache
    if _capability_version_cache is None:
        version = ""
        try:
            from importlib.metadata import version as _dist_version

            version = _dist_version("hermes-agent")
        except Exception:
            version = (os.getenv("HERMES_RUNTIME_VERSION") or "").strip()
        _capability_version_cache = version or "unknown"
    return _capability_version_cache


def detect_platform(text: str | None) -> str | None:
    """从分享文本/链接里识别平台(容忍口令前后噪音文字)。识别不了返回 None。"""
    haystack = (text or "").strip().lower()
    if not haystack:
        return None
    for platform, hosts in _PLATFORM_HOST_SIGNS:
        if any(host in haystack for host in hosts):
            return platform
    return None


# ---------------------------------------------------------------------------
# HTTP:统一请求 + 显式错误映射
# ---------------------------------------------------------------------------

def _server_detail(response: httpx.Response) -> str:
    """尽力从响应体里挖 FastAPI 风格的 detail.message / detail.code。"""
    try:
        body = response.json()
    except Exception:
        return (response.text or "").strip()[:300]
    detail = body.get("detail", body) if isinstance(body, dict) else body
    if isinstance(detail, dict):
        return str(detail.get("message") or detail.get("code") or "").strip()
    return str(detail or "").strip()[:300]


def _server_sentence(response: httpx.Response) -> str:
    """The server's own sentence for a failed call: JSON ``detail.message`` or a string
    ``detail``; "" otherwise (hc-984).

    Unlike :func:`_server_detail` it never falls back to the raw body or a bare code, so
    an nginx HTML page or a plain "Internal Server Error" is never relayed to the user
    as the reason."""
    try:
        body = response.json()
    except ValueError:  # JSONDecodeError / UnicodeDecodeError: not JSON, no sentence
        return ""
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, dict):
        return str(detail.get("message") or "").strip()
    return detail.strip() if isinstance(detail, str) else ""


def _server_code(response: httpx.Response, key: str = "code") -> str | None:
    """服务端机器可读的 detail.code(如 ``asr_no_speech``);没有就 None。

    hc-926:此前 HTTP 错误只保留了文案,调用方分不出「素材没有人声」这类正常结论
    与真故障,只能一律报 tool_error。hc-969:``key="vendor_code"`` 取 503
    ``vendor_unavailable`` 背后的原 code——视频整体关停和上游繁忙都以
    ``vendor_unavailable`` 到达,只有它分得开。"""
    try:
        body = response.json()
    except ValueError:  # JSONDecodeError / UnicodeDecodeError: no machine-readable code
        return None
    detail = body.get("detail") if isinstance(body, dict) else None
    if not isinstance(detail, dict) or not detail.get(key):
        return None
    return str(detail[key]).strip() or None


def _error_from_response(
    response: httpx.Response,
    source: str = SOURCE_ENV,
    *,
    path: str = "",
) -> GatewayError:
    status = response.status_code
    detail = _server_detail(response)
    code = _server_code(response)
    vendor_code = _server_code(response, "vendor_code")
    media = _MEDIA_GENERATE_PATHS.get(path)
    honest = media_error_message(media, status, vendor_code or code, _server_sentence(response)) if media else None
    if honest is not None:
        return GatewayError(honest, status=status, code=code, vendor_code=vendor_code)
    if status == 401:
        # hc-604:按凭据来源分流。此前无论来源一律「请重新登录」,而现场最常见的
        # 一种(env 未注入 → 读到 config.yaml 里的陈副本)恰恰是重新登录修不好的。
        message = stale_credential_message(source)
    elif status == 402:
        message = say("quota_402")
    elif status == 413:
        # hc-560 话术纪律:中性一句;不指引用户本地抽音轨/压缩/装工具/切文件。
        message = say("too_large_413")
    elif status == 429:
        message = say("rate_limited_429")
    elif status == 503:
        if path.startswith("/tools/v1/social/") and path.endswith("/download"):
            message = say("download_unavailable_503")
        elif path.startswith("/tools/v1/asr/"):
            message = say("asr_unavailable_503")
        else:
            message = say("capability_unavailable_503")
    else:
        message = say("gateway_error_status", status=status)
    # 413 不拼服务端 detail:旧版云端的 413 文案带「请在本地抽音轨并压缩」类
    # 自救指引(hc-560 已改中性,但客户端不应依赖服务端版本),中性一句已完整。
    redact_outage_detail = status == 503 and (
        (path.startswith("/tools/v1/social/") and path.endswith("/download"))
        or path.startswith("/tools/v1/asr/")
    )
    if detail and status != 413 and not redact_outage_detail:
        message = say("with_detail", message=message, detail=detail)
    return GatewayError(message, status=status, code=code, vendor_code=vendor_code)


def _retry_after_seconds(response: httpx.Response, attempt: int) -> float:
    raw = (response.headers.get("Retry-After") or "").strip()
    try:
        delay = float(raw)
    except (TypeError, ValueError):
        delay = float(2 ** attempt)
    return max(0.5, min(delay, _MAX_RETRY_AFTER_SECONDS))


def request_json(
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    *,
    timeout: float = 90,
    files: dict[str, Any] | None = None,
    form_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """对网关发一次 JSON(或 multipart)请求,返回解析后的 JSON dict。

    失败一律抛 :class:`GatewayError`,message 即给用户看的降级文案。
    """
    base = gateway_base()
    key, source = resolve_agent_api_key()
    # 「没配过」优先于「没 base」:两者在桌面端总是一起缺失,而对用户有意义的那句
    # 是「去登录」,不是「缺 TOOLS_GATEWAY_BASE」。
    if not key:
        raise missing_credential_error()
    if not base:
        raise GatewayError(say("gateway_unconfigured", env_base=ENV_BASE), code="gateway_unconfigured")
    headers = {
        "Authorization": f"Bearer {key}",
        "X-Capability-Version": capability_version(),
    }
    url = f"{base}{path}"
    attempt = 0
    while True:
        try:
            with httpx.Client(timeout=timeout, follow_redirects=True) as client:
                response = client.request(
                    method,
                    url,
                    json=payload if files is None else None,
                    data=form_data,
                    files=files,
                    headers=headers,
                )
        except httpx.HTTPError as exc:
            # 第三类:网络失败。既不是「没配过」也不是「凭据失效」——绝不在这里
            # 提登录,否则用户会为一次断网去反复重登。
            raise GatewayError(say("network_error", error=exc), code="network_unreachable") from exc
        if (
            response.status_code == 429
            and attempt < _MAX_429_RETRIES
            # hc-969: a daily limit holds until tomorrow; backing off only makes the user wait.
            and _server_code(response) not in DAILY_LIMIT_CODES
        ):
            delay = _retry_after_seconds(response, attempt)
            attempt += 1
            logger.info("gateway 429 on %s — backoff %.1fs (attempt %d)", path, delay, attempt)
            time.sleep(delay)
            continue
        if response.status_code >= 400:
            raise _error_from_response(response, source, path=path)
        # hc-984: an answer nobody could read is said as such, with no retry promise
        # (it used to say "请稍后重试" for it, on every tool).
        media = _MEDIA_GENERATE_PATHS.get(path)
        unreadable = say("media_unreadable", media=media) if media else say("gateway_unreadable")
        try:
            body = response.json()
        except Exception as exc:
            raise GatewayError(unreadable, code="unreadable_answer") from exc
        if not isinstance(body, dict):
            raise GatewayError(unreadable, code="unreadable_answer")
        return body


def unwrap(response_body: dict[str, Any]) -> dict[str, Any]:
    """把网关 ``{data, cost_cents}`` 信封摊回工具结果面(保持 agent 无感)。"""
    data = response_body.get("data")
    out: dict[str, Any] = dict(data) if isinstance(data, dict) else ({} if data is None else {"data": data})
    if "cost_cents" in response_body and "cost_cents" not in out:
        out["cost_cents"] = response_body.get("cost_cents")
    return out


# ---------------------------------------------------------------------------
# 图片/视频生成:链路健康预检 + 如实错误(hc-969)
# ---------------------------------------------------------------------------
#
# 2026-10-18 评测:桌面端生图、生视频全部失败,用户却被告知「服务繁忙,请稍后重试」,
# 白等很久。服务端 hc-945/hc-948 已如实报错并按链路记健康;这里是桌面这一侧:
#   * 生成前读 /tools/v1/check 的逐链路健康,链路关停或连续失败就当场说清楚,不再
#     发出一个注定要等几分钟才失败的请求。Kael 2026-10-19 拍板:工具保留(check_fn
#     不隐藏),只说「暂时不可用」——隐藏会让助手以为自己不会做,而不是今天暂时不行;
#   * 只有能自己恢复的失败才让用户再试:日限说「明天恢复」,关停/未开通说「重试也
#     不会成功」,其余 503 用服务端逐 code 写好的那句(hc-945 起已如实)。

MEDIA_IMAGE = "image"
MEDIA_VIDEO = "video"
_MEDIA_GENERATE_PATHS = {
    "/tools/v1/image/generate": MEDIA_IMAGE,
    "/tools/v1/video/generate": MEDIA_VIDEO,
}

# 429 codes that hold until tomorrow: request_json answers them on the first
# response instead of backing off, and the user hears when it comes back.
DAILY_LIMIT_CODES = frozenset({"image_daily_limit_reached", "video_daily_limit_reached"})


def _media_switched_off(media: str) -> str:
    return say("media_switched_off", media=media)


# Statuses whose generic sentence is Desktop guidance the server cannot give (sign in
# again, top up, the file is too large, back off): a generation keeps those.
_GENERIC_GUIDANCE_STATUSES = frozenset({401, 402, 413, 429})


def media_error_message(media: str, status: int | None, code: str | None, detail: str = "") -> str | None:
    """The honest sentence for a failed image/video generation, or None to let the
    generic status table answer.

    ``code`` is the server's own code: ``vendor_code`` behind a gateway 503, or
    ``detail.code`` from the legacy master endpoints, so both legs say the same
    thing. Only a failure that can clear by itself invites another try. ``detail``
    is the server's own sentence, never a raw body or a bare code.

    hc-984: every other status (a 422 rejection, a 500 crash in the platform's own code,
    a gateway's empty 502) is the server's sentence too, or says it gave none; it used
    to come out as "平台工具网关返回错误(HTTP n)(详情: …)", and a bare 500 as
    "(详情: Internal Server Error)". Same rule as the hosted copies in apex-nodes."""
    if status == 429 and code in DAILY_LIMIT_CODES:
        return say("media_daily_limit", media=media)
    if status in _GENERIC_GUIDANCE_STATUSES:
        return None
    if status != 503:
        return detail or say(
            "media_no_reason_status", media=media, status=f"HTTP {status}" + (f", {code}" if code else "")
        )
    if code == "video_generation_unavailable":
        # hc-948 rollback lever: the whole capability is off until an operator reopens it.
        return _media_switched_off(media)
    if code == "provider_not_configured":
        return say("media_not_configured", media=media)
    if code == "provider_auth_failed":
        return say("media_auth_failed", media=media)
    # Busy, timeouts, failed jobs: the server's sentence says whether trying again
    # helps (hc-945 rewrote them per code), so it is not wrapped in a retry promise.
    return detail or say("media_no_reason", media=media)


def tools_check(*, timeout: float = 5) -> dict[str, Any] | None:
    """``GET /tools/v1/check``; None when it cannot be read.

    A check that cannot be read never stops a generation: the call goes ahead and
    reports its own outcome."""
    try:
        return request_json("GET", "/tools/v1/check", timeout=timeout)
    except GatewayError:
        logger.info("tools check unreadable; generating without a leg-health verdict")
        return None


def _image_leg_name(section: dict[str, Any], provider: str | None, purpose: str | None, title: str | None) -> str | None:
    """hc-984: the leg an image call without a model lands on: the named provider's, or
    the one the server routes its purpose to (``purpose_legs``; a cover with and without
    a title can differ). None when the check cannot say (a server before hc-984)."""
    if provider:
        return provider.strip().lower()
    routes = section.get("purpose_legs")
    if not isinstance(routes, dict):
        return None
    if (purpose or "").strip().lower() == "cover":
        return routes.get("cover" if (title or "").strip() else "cover_without_title")
    return routes.get("illustration")


def _leg_view(
    section: dict[str, Any],
    media: str,
    model: str | None,
    *,
    provider: str | None = None,
    purpose: str | None = None,
    title: str | None = None,
) -> tuple[Any, Any]:
    """The (entry, health) pair that describes the leg this call will use.

    A selected model is its own leg (``legs["chinaapi:<model>"]``, health fields at
    the top). A video call without a model renders on the default leg, which the
    section describes flat (``serving`` on /tools/v1/check, ``ok`` on the legacy
    check, health under ``health``). An image call without a model reads the leg its
    provider or purpose lands on (hc-984)."""
    legs = section.get("legs")
    if model:
        entry = legs.get(f"chinaapi:{model}") if isinstance(legs, dict) else None
        return entry, entry
    if media == MEDIA_VIDEO:
        return section, section.get("health")
    name = _image_leg_name(section, provider, purpose, title)
    entry = legs.get(name) if name and isinstance(legs, dict) else None
    return entry, entry


def media_unavailable_reason(
    media: str,
    model: str | None,
    read_check: Callable[[], Any],
    *,
    provider: str | None = None,
    purpose: str | None = None,
    title: str | None = None,
) -> str | None:
    """Why this generation should not start, read from hc-945's leg health; None = go ahead.

    ``read_check`` returns the ``image``/``video`` block of /tools/v1/check, or the
    legacy /media/{image,video}/check body; both carry the same per-leg health. hc-984:
    an image without a model is read too, on the leg its provider or purpose lands on
    (``purpose_legs``); before, it was not checked and waited out its request when that
    leg was down. Anything short of a clear "this leg is not serving" goes ahead: an
    older server without leg health or ``purpose_legs``, a model the server does not
    list, an unreadable check."""
    section = read_check()
    if not isinstance(section, dict):
        return None
    entry, health = _leg_view(section, media, model, provider=provider, purpose=purpose, title=title)
    if not isinstance(entry, dict) or not isinstance(health, dict):
        return None
    if entry.get("serving", entry.get("ok")) is not False:
        return None
    if entry.get("configured") is False:
        return _media_switched_off(media)
    if health.get("healthy") is not False:
        return None
    seconds = health.get("retry_after_seconds")
    if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) and seconds > 0:
        when = say("when_minutes", minutes=max(1, math.ceil(seconds / 60)))
    else:
        when = say("when_later")
    return say("media_paused_model" if model else "media_paused", media=media, when=when)


# ---------------------------------------------------------------------------
# ASR 提交:小文件 multipart / 大文件 COS 直传三跳(hc-560)
# ---------------------------------------------------------------------------

def asr_direct_upload_threshold_bytes() -> int:
    """直传阈值(字节):env 可调,缺省 8MB;非法值回落缺省。"""
    raw = (os.getenv(ENV_ASR_DIRECT_UPLOAD_THRESHOLD) or "").strip()
    if raw:
        try:
            return int(raw)
        except ValueError:
            pass
    return ASR_DIRECT_UPLOAD_THRESHOLD_BYTES


def transcribe_upload(
    upload_path: Path | str,
    *,
    timeout: float,
    force_refresh: bool | None = None,
) -> dict[str, Any]:
    """把一个本地音频文件提交转写(插件转写路径的唯一提交口)。

    >阈值走「upload-url → PUT 直传 COS → JSON media_url 提交」三跳(大文件不过
    nginx/scheduler 的 multipart 同步管道);≤阈值维持 multipart。直传**通道**故障
    (旧网关无端点、COS 不可用、PUT 失败)自动回退 multipart,绝不因通道失败让转写
    失败;转写本身的业务错误(402/413/429/鉴权)原样抛 :class:`GatewayError`。
    """
    source = Path(upload_path)
    size = source.stat().st_size
    if size > asr_direct_upload_threshold_bytes():
        result = _transcribe_via_direct_upload(
            source,
            size,
            timeout=timeout,
            force_refresh=force_refresh,
        )
        if result is not None:
            return result
    with open(source, "rb") as fh:
        files = {"file": (source.name, fh, guess_media_content_type(source))}
        form_data = None if force_refresh is None else {"force_refresh": str(force_refresh).lower()}
        return request_json(
            "POST",
            "/tools/v1/asr/transcribe",
            files=files,
            form_data=form_data,
            timeout=timeout,
        )


def _transcribe_via_direct_upload(
    source: Path,
    size: int,
    *,
    timeout: float,
    force_refresh: bool | None = None,
) -> dict[str, Any] | None:
    """三跳直传;返回 ``None`` 表示直传通道不可用(调用方回退 multipart)。

    「业务判定 vs 通道故障」的分界:upload-url 若给出 401/402/413/429
    (_ASR_DIRECT_VERDICT_STATUSES)是对本次转写的最终结论——原样抛出;
    其余失败(404 旧网关、503 直传未配置、网络错误)只说明通道不可用。
    第三跳 transcribe 的任何错误都是业务错误,一律透出、不回退。
    """
    try:
        issued = request_json(
            "POST",
            "/tools/v1/asr/upload-url",
            {
                "filename": source.name,
                "size_bytes": size,
                "content_type": guess_media_content_type(source),
            },
            timeout=_ASR_UPLOAD_URL_TIMEOUT_SECONDS,
        )
    except GatewayError as exc:
        if exc.status in _ASR_DIRECT_VERDICT_STATUSES:
            raise
        logger.info("asr upload-url unavailable (status=%s); falling back to multipart", exc.status)
        return None
    put_url = str(issued.get("put_url") or "").strip()
    media_url = str(issued.get("media_url") or "").strip()
    if not (put_url and media_url):
        logger.info("asr upload-url response incomplete; falling back to multipart")
        return None
    try:
        _put_presigned(put_url, source, size, timeout=timeout)
    except GatewayError:
        logger.info("asr direct PUT failed after retry; falling back to multipart")
        return None
    payload: dict[str, Any] = {"media_url": media_url}
    if force_refresh is not None:
        payload["force_refresh"] = force_refresh
    return request_json("POST", "/tools/v1/asr/transcribe", payload, timeout=timeout)


def _put_presigned(put_url: str, source: Path, size: int, *, timeout: float) -> None:
    """把文件流式 ``PUT`` 到预签名 URL(带 Content-Length,不整读进内存;失败重试
    一次)。预签名 PUT 对请求头零约束(契约 §3.5),故不带 Content-Type,避免与
    签名头列表冲突。失败抛 :class:`GatewayError`。"""
    last_error: Exception | None = None
    for attempt in range(1, _ASR_PUT_ATTEMPTS + 1):
        try:
            with open(source, "rb") as fh:
                chunks = iter(lambda: fh.read(_ASR_PUT_CHUNK_BYTES), b"")
                # 显式 Content-Length ⇒ httpx 按定长成帧(COS 的 PUT Object 需要),
                # 不落 Transfer-Encoding: chunked。
                with httpx.Client(timeout=timeout, follow_redirects=False) as client:
                    response = client.request(
                        "PUT",
                        put_url,
                        content=chunks,
                        headers={"Content-Length": str(size)},
                    )
            if response.status_code < 400:
                return
            last_error = GatewayError(
                f"直传存储返回 HTTP {response.status_code}", status=response.status_code
            )
        except httpx.HTTPError as exc:
            last_error = exc
        logger.info("asr direct PUT attempt %d/%d failed", attempt, _ASR_PUT_ATTEMPTS)
    raise GatewayError(f"大文件直传失败: {last_error}") from last_error


# ---------------------------------------------------------------------------
# 本地媒体:下载 / 抽音轨(PD §8——大媒体不过网关,网关只出直链)
# ---------------------------------------------------------------------------

def media_cache_dir() -> Path:
    """本地媒体缓存目录(media-delivery 安全根,与 cache/documents 同族)。"""
    try:
        from hermes_constants import get_hermes_home

        home = str(get_hermes_home())
    except Exception:
        home = os.getenv("HERMES_HOME") or str(Path.home() / ".hermes")
    cache = Path(home) / "cache" / "media"
    cache.mkdir(parents=True, exist_ok=True)
    return cache


_EXT_RE = re.compile(r"\.([A-Za-z0-9]{2,5})(?:$|[?#])")


def _guess_extension(url: str, content_type: str | None) -> str:
    match = _EXT_RE.search(url.split("?", 1)[0].rsplit("/", 1)[-1] + "?")
    if match:
        return f".{match.group(1).lower()}"
    if content_type:
        guessed = mimetypes.guess_extension(content_type.split(";", 1)[0].strip())
        if guessed:
            return guessed
    return ".mp4"


def download_media(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = 600,
    dest_dir: Path | None = None,
    filename_hint: str = "",
) -> Path:
    """把一个 vendor 直链可靠地下载到本地媒体缓存。

    使用同目录 ``.part`` 文件；断流后优先以严格校验的 ``Range`` 续传，服务端忽略
    Range 并返回 200 时安全地从头覆盖。只有长度完整的响应才原子改名为最终文件。
    失败会清理残件并抛 :class:`GatewayError`，错误面绝不包含签名 URL。
    """
    target_dir = dest_dir or media_cache_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    request_headers = {k: str(v) for k, v in (headers or {}).items() if v is not None}
    stem = re.sub(r"[^\w-]+", "_", filename_hint).strip("_")[:40] or "media"
    unique = uuid.uuid4().hex[:8]
    suffix = _guess_extension(url, None)
    dest = target_dir / f"{stem}_{unique}{suffix}"
    partial = dest.with_name(f"{dest.name}.part")
    expected_total: int | None = None

    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            for _attempt in range(_MEDIA_DOWNLOAD_ATTEMPTS):
                offset = partial.stat().st_size if partial.exists() else 0
                attempt_headers = dict(request_headers)
                if offset:
                    attempt_headers["Range"] = f"bytes={offset}-"
                try:
                    with client.stream("GET", url, headers=attempt_headers) as response:
                        if response.status_code >= 400:
                            raise GatewayError(
                                f"媒体下载地址返回 HTTP {response.status_code},尚不能确定分享链接是否失效。",
                                status=response.status_code,
                                code="media_download_http_error",
                            )

                        # 共享下载器也服务图片/生成视频取件。首次响应仍按 Content-Type
                        # 解析无扩展名 URL，保持 hc-735 前的文件类型行为；续传后不再改名。
                        if offset == 0 and not partial.exists():
                            response_suffix = _guess_extension(
                                url, response.headers.get("Content-Type")
                            )
                            if response_suffix != suffix:
                                suffix = response_suffix
                                dest = target_dir / f"{stem}_{unique}{suffix}"
                                partial = dest.with_name(f"{dest.name}.part")

                        append = offset > 0 and response.status_code == 206
                        response_expected = _validate_download_response(
                            response,
                            requested_offset=offset,
                            append=append,
                        )
                        if response_expected is not None:
                            if (
                                expected_total is not None
                                and expected_total != response_expected
                            ):
                                raise GatewayError(
                                    "媒体直链在续传时长度发生变化,已停止使用残缺文件。",
                                    code="media_download_size_changed",
                                )
                            expected_total = response_expected

                        # Range 被忽略(200)时必须覆盖，绝不能把完整响应追加到残件后面。
                        mode = "ab" if append else "wb"
                        with open(partial, mode) as fh:  # windows-footgun: ok — mode is always binary (ab/wb)
                            fh.writelines(response.iter_bytes())

                        actual = partial.stat().st_size
                        if expected_total is not None and actual != expected_total:
                            continue
                        if actual <= 0:
                            continue
                        partial.replace(dest)
                        return dest
                except GatewayError as exc:
                    # 同一个已被拒绝的签名重复请求不会产生新地址。让调用方立即
                    # 切备用线路；仅限流和服务端暂时故障在本 URL 上重试。
                    if exc.code == "media_download_http_error" and exc.status not in (
                        429,
                        500,
                        502,
                        503,
                        504,
                    ):
                        raise
                    continue
                except httpx.HTTPError:
                    # 保留 .part 供下一次严格 Range 恢复；最终失败统一在外层清理。
                    continue
    finally:
        if not dest.exists():
            partial.unlink(missing_ok=True)

    raise GatewayError(
        "媒体直链下载中断,自动续传仍未完成;请稍后重试或直接上传视频文件。",
        code="media_download_incomplete",
    )


def _validate_download_response(
    response: httpx.Response,
    *,
    requested_offset: int,
    append: bool,
) -> int | None:
    """返回完整对象总字节数；协议不可信时抛错，禁止把响应拼进残件。"""
    raw_length = (response.headers.get("Content-Length") or "").strip()
    content_length = int(raw_length) if raw_length.isdigit() else None

    if response.status_code == 206 and not append:
        raise GatewayError(
            "媒体直链在未请求续传时返回了局部响应。",
            code="invalid_content_range",
        )

    if append:
        raw_range = (response.headers.get("Content-Range") or "").strip()
        match = _CONTENT_RANGE_RE.fullmatch(raw_range)
        if match is None:
            raise GatewayError(
                "媒体续传响应缺少有效的 Content-Range。", code="invalid_content_range"
            )
        start, end, total = (int(value) for value in match.groups())
        if start != requested_offset or end < start or end >= total:
            raise GatewayError("媒体续传响应范围不匹配。", code="invalid_content_range")
        segment_size = end - start + 1
        if content_length is not None and content_length != segment_size:
            raise GatewayError("媒体续传响应长度不匹配。", code="invalid_content_range")
        return total

    # 首次请求或 Range 被服务器忽略后返回的完整 200。
    return content_length


def extract_audio_for_asr(media_path: Path | str, *, timeout: int = 1800) -> Path | None:
    """本地抽音轨压缩(16kHz 单声道 AAC),供上传转写(multipart 或直传)。

    压缩兜底链(hc-560):ffmpeg 存在 → ffmpeg;无 ffmpeg 且 macOS 有 afconvert
    (系统自带)→ afconvert;两者都无、或任何一步失败 → 返回 None,调用方直接
    上传原文件——压缩是带宽优化(PD §8),不是正确性前提,绝不因压缩失败让转写失败。
    """
    source = Path(media_path)
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return _extract_audio_ffmpeg(ffmpeg, source, timeout=timeout)
    if sys.platform == "darwin":
        afconvert = shutil.which("afconvert")
        if afconvert:
            return _extract_audio_afconvert(afconvert, source, timeout=timeout)
    return None


def _run_audio_extraction(command: list[str], output: Path, *, timeout: int, tool: str) -> Path | None:
    """跑一条抽音轨命令;任何失败(崩溃/超时/非零退出/空产物)→ 清残件返回 None。"""
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,  # ffmpeg reads stdin for interactive keys
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except Exception:
        logger.warning("%s audio extraction crashed; uploading original media", tool, exc_info=True)
        output.unlink(missing_ok=True)
        return None
    if completed.returncode != 0 or not output.exists() or output.stat().st_size == 0:
        logger.info(
            "%s audio extraction failed (rc=%s); uploading original media", tool, completed.returncode
        )
        output.unlink(missing_ok=True)
        return None
    return output


def _extract_audio_ffmpeg(ffmpeg: str, source: Path, *, timeout: int) -> Path | None:
    output = media_cache_dir() / f"asr_{uuid.uuid4().hex[:8]}.m4a"
    command = [
        ffmpeg,
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "48k",
        str(output),
    ]
    return _run_audio_extraction(command, output, timeout=timeout, tool="ffmpeg")


def _extract_audio_afconvert(afconvert: str, source: Path, *, timeout: int) -> Path | None:
    """macOS 系统自带 afconvert 兜底:m4a 容器、AAC@16kHz 单声道 48kbps(与 ffmpeg
    腿同参数)。CoreAudio 读不动的容器(如 mkv/webm)会以非零退出 → None 回退原文件。"""
    output = media_cache_dir() / f"asr_{uuid.uuid4().hex[:8]}.m4a"
    command = [
        afconvert,
        "-f",
        "m4af",
        "-d",
        "aac@16000",
        "-c",
        "1",
        "-b",
        "48000",
        str(source),
        str(output),
    ]
    return _run_audio_extraction(command, output, timeout=timeout, tool="afconvert")


def guess_media_content_type(path: Path | str) -> str:
    """multipart 上传时的 Content-Type 猜测(猜不出用 octet-stream)。"""
    return mimetypes.guess_type(Path(path).name)[0] or "application/octet-stream"


# ---------------------------------------------------------------------------
# 生成工具的输入图：参考图、首帧、首尾帧(apex-nodes docs/design/generation-input-images.md)
# ---------------------------------------------------------------------------
#
# 两个出片插件共用这一份。``source`` 是之前结果里的 ``image_ref``(``media:…``)、平台签发
# 的图片链接、本机文件(对话里 [Image attached at: …] 的路径)或别的图片链接：句柄和平台
# 链接原样交，本机文件和外链先上传(网关腿 /tools/v1/media/reference-upload,legacy 腿
# /media/reference-upload),交回传回来的 ``image_ref``。任何一张图用不了，整次调用报错，
# 绝不改成不带图的请求(那会按文生出片)。服务端没在 check 里声明 ``input_images.supported``
# 时一张都不发：旧服务端会悄悄丢掉 ``images``。

INPUT_IMAGE_MAX_BYTES = 20 * 1024 * 1024
INPUT_UPLOAD_PATH = "/tools/v1/media/reference-upload"
LEGACY_INPUT_UPLOAD_PATH = "/media/reference-upload"
_SIGNED_IMAGE_MARKER = "/api/v1/media/image/"
_INPUT_DOWNLOAD_TIMEOUT = 30
_INPUT_UPLOAD_TIMEOUT = 120


class InputImageError(RuntimeError):
    """An input image that cannot be used: the call fails and nothing is generated."""


def takes_input_images(section: dict[str, Any] | None) -> bool:
    """Does this check section (the image or video one) say the server takes ``images``?"""
    view = section.get("input_images") if isinstance(section, dict) else None
    return bool(isinstance(view, dict) and view.get("supported"))


def _input_too_large(index: int) -> InputImageError:
    return InputImageError(say("input_image_too_large", index=index, mb=INPUT_IMAGE_MAX_BYTES // (1024 * 1024)))


def _safe_upload_name(filename: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", filename)[-64:] or "image"


def _uploaded_ref(answer: Any, index: int) -> str:
    ref = answer.get("image_ref") if isinstance(answer, dict) else None
    if not isinstance(ref, str) or not ref.startswith("media:"):
        raise InputImageError(say("input_image_upload_failed", index=index, reason="no image_ref"))
    return ref


def _download_input_image(url: str, index: int) -> bytes:
    data = bytearray()
    try:
        with httpx.Client(timeout=_INPUT_DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
            with client.stream("GET", url, headers={"User-Agent": "Mozilla/5.0 (compatible; APEX)"}) as response:
                if response.status_code >= 400:
                    reason = f"HTTP {response.status_code}"
                    raise InputImageError(say("input_image_download_failed", index=index, reason=reason))
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) > INPUT_IMAGE_MAX_BYTES:
                        raise _input_too_large(index)
    except httpx.HTTPError as exc:
        raise InputImageError(say("input_image_download_failed", index=index, reason=exc)) from exc
    return bytes(data)


def upload_input_image(data: bytes, filename: str, index: int) -> str:
    """Gateway leg: one image up to the platform; its ``image_ref``."""
    try:
        body = request_json(
            "POST",
            INPUT_UPLOAD_PATH,
            files={"file": (_safe_upload_name(filename), data, "application/octet-stream")},
            timeout=_INPUT_UPLOAD_TIMEOUT,
        )
    except GatewayError as exc:
        raise InputImageError(say("input_image_upload_failed", index=index, reason=exc)) from exc
    return _uploaded_ref(unwrap(body), index)


def legacy_upload_input_image(api_base: str, data: bytes, filename: str, index: int) -> str:
    """Legacy leg (``TOOLS_GATEWAY_DISABLED=1``): the same upload on the master's internal route."""
    key = agent_api_key()
    if not key:
        raise missing_credential_error()
    boundary = f"apexnodes-{uuid.uuid4().hex}"
    head = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{_safe_upload_name(filename)}\"\r\n"
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode()
    request = urllib.request.Request(
        f"{api_base.rstrip('/')}{LEGACY_INPUT_UPLOAD_PATH}",
        data=head + data + f"\r\n--{boundary}--\r\n".encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_INPUT_UPLOAD_TIMEOUT) as response:
            answer = json.loads(response.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8", errors="replace")).get("detail")
        except (ValueError, AttributeError):
            detail = None
        message = detail.get("message") if isinstance(detail, dict) else detail if isinstance(detail, str) else ""
        reason = message or f"HTTP {exc.code}"
        raise InputImageError(say("input_image_upload_failed", index=index, reason=reason)) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise InputImageError(say("input_image_upload_failed", index=index, reason=exc)) from exc
    return _uploaded_ref(answer, index)


def _input_image_source(
    source: str, index: int, *, upload: Callable[[bytes, str, int], str], server_paths: bool
) -> dict[str, str]:
    if source.startswith("media:"):
        return {"ref": source}
    if source.lower().startswith(("http://", "https://")):
        path = source.split("?", 1)[0].split("#", 1)[0]
        if _SIGNED_IMAGE_MARKER in path:
            return {"url": source}
        return {"ref": upload(_download_input_image(source, index), path.rsplit("/", 1)[-1] or "image", index)}
    local = Path(source).expanduser()
    if local.is_file():
        try:
            if local.stat().st_size > INPUT_IMAGE_MAX_BYTES:
                raise _input_too_large(index)
            data = local.read_bytes()
        except OSError as exc:
            raise InputImageError(say("input_image_upload_failed", index=index, reason=exc)) from exc
        return {"ref": upload(data, local.name, index)}
    if server_paths:
        # Not a file here: a master path from an earlier result; the platform checks it is ours.
        return {"path": source}
    raise InputImageError(say("input_image_missing", index=index, source=source[:120]))


def input_images(
    raw: Any,
    *,
    with_roles: bool,
    takes_images: Callable[[], bool],
    upload: Callable[[bytes, str, int], str],
    server_paths: bool,
) -> list[dict[str, str]]:
    """The request's ``images`` from the tool's, or :class:`InputImageError`; ``[]`` without any.

    ``takes_images`` reads the leg's check; ``upload`` is the leg's upload; ``server_paths``
    only on the legacy leg, where a master path from an earlier result is meaningful."""
    if raw in (None, "", []):
        return []
    if not isinstance(raw, list):
        raise InputImageError(say("input_images_not_list"))
    if not takes_images():
        raise InputImageError(say("input_images_unsupported_server"))
    items: list[dict[str, str]] = []
    for index, entry in enumerate(raw, start=1):
        if isinstance(entry, str):
            entry = {"source": entry}
        if not isinstance(entry, dict):
            raise InputImageError(say("input_images_not_list"))
        source = str(entry.get("source") or entry.get("image_ref") or "").strip()
        if not source:
            raise InputImageError(say("input_image_source_missing", index=index))
        item = _input_image_source(source, index, upload=upload, server_paths=server_paths)
        for key in ("role", "kind") if with_roles else ("kind",):
            value = str(entry.get(key) or "").strip()
            if value:
                item[key] = value
        items.append(item)
    return items
