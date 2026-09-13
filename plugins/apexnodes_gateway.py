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

错误语义(全部显式降级文案,不静默吞):
  401 key 失效→提示重新登录;402 配额/余额;429 限流(本客户端带有限退避重试);
  503 按 download resolve / ASR / 其他能力分段,不向用户暴露供应商细节;
  其余透传 detail。
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

import logging
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

__all__ = [
    "DESKTOP_SPAWN_ENV_CONTRACT",
    "SOCIAL_PLATFORMS",
    "SOURCE_CONFIG",
    "SOURCE_ENV",
    "SOURCE_NONE",
    "GATEWAY_PUBLIC_BASE",
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
    "missing_credential_error",
    "request_json",
    "resolve_agent_api_key",
    "stale_credential_message",
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
    """网关调用失败——message 即面向用户的显式降级文案(中文,不静默)。"""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


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
    except Exception:  # noqa: BLE001 — config 不可用等同"未登录"
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
        message = (
            "尚未登录 ApexNodes 账号,平台工具(图片/视频生成、图片 OCR、媒体转写)不可用。"
            "请打开 设置 → 账户 完成登录;登录后本对话直接重试即可,无需其他配置。"
        )
    else:
        message = (
            "本环境没有平台凭据,平台工具不可用。"
            f"请为容器注入 {ENV_KEY}(或 API_SERVER_KEY),再重启 Agent 容器。"
        )
    return GatewayError(message, status=None, code="credential_missing")


def stale_credential_message(source: str) -> str:
    """「有凭据但服务端不认」——按来源给出真正能解决问题的下一步。"""
    if source == SOURCE_CONFIG:
        # env 没注入,读到的是 config.yaml 里的副本。桌面端 0.17.1 及更早只同步
        # model.api_key、漏掉 custom_providers 条目(hc-595 盲区),于是聊天正常
        # 而工具 401——此时「重新登录」并不会修好那份副本,更新/重启才会。
        return (
            "平台凭据被服务端拒绝(401);当前用的是 config.yaml 里的备用副本,"
            "它可能已经过期。请先把 APEX 更新到最新版并重启(桌面端会在启动时自动换发凭据);"
            "若更新后仍然如此,再到 设置 → 账户 重新登录一次。"
        )
    if _is_desktop():
        return (
            "平台凭据被服务端拒绝(401)。请到 设置 → 账户 重新登录一次以换发凭据;"
            "若刚登录过仍然如此,请重启 APEX(启动时会自动换发)。"
        )
    return (
        "平台凭据被服务端拒绝(401):该 Agent Key 可能已轮换或被停用,"
        "请管理员重新下发 Agent Key 后重启容器。"
    )


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
        except Exception:  # noqa: BLE001 — 未以发行包形态安装(裸源码跑)
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
    except Exception:  # noqa: BLE001
        return (response.text or "").strip()[:300]
    detail = body.get("detail", body) if isinstance(body, dict) else body
    if isinstance(detail, dict):
        return str(detail.get("message") or detail.get("code") or "").strip()
    return str(detail or "").strip()[:300]


def _error_from_response(
    response: httpx.Response,
    source: str = SOURCE_ENV,
    *,
    path: str = "",
) -> GatewayError:
    status = response.status_code
    detail = _server_detail(response)
    if status == 401:
        # hc-604:按凭据来源分流。此前无论来源一律「请重新登录」,而现场最常见的
        # 一种(env 未注入 → 读到 config.yaml 里的陈副本)恰恰是重新登录修不好的。
        message = stale_credential_message(source)
    elif status == 402:
        message = "平台工具额度不足(402):套餐配额已用尽或余额不足,请升级套餐/充值后再试。"
    elif status == 413:
        # hc-560 话术纪律:中性一句;不指引用户本地抽音轨/压缩/装工具/切文件。
        message = "文件超过平台大小上限(413),本次未能处理。"
    elif status == 429:
        message = "平台工具请求过于频繁(429):已自动退避重试仍被限流,请稍等 1-2 分钟再试。"
    elif status == 503:
        if path.startswith("/tools/v1/social/") and path.endswith("/download"):
            message = "视频链接解析/下载服务暂不可用(503),请稍后重试或直接上传视频文件。"
        elif path.startswith("/tools/v1/asr/"):
            message = "视频转写服务暂不可用(503),请稍后重试或先提供已有文字稿。"
        else:
            message = "平台能力暂不可用(503),请稍后重试。"
    else:
        message = f"平台工具网关返回错误(HTTP {status})"
    # 413 不拼服务端 detail:旧版云端的 413 文案带「请在本地抽音轨并压缩」类
    # 自救指引(hc-560 已改中性,但客户端不应依赖服务端版本),中性一句已完整。
    redact_outage_detail = status == 503 and (
        (path.startswith("/tools/v1/social/") and path.endswith("/download"))
        or path.startswith("/tools/v1/asr/")
    )
    if detail and status != 413 and not redact_outage_detail:
        message = f"{message}(详情: {detail})"
    return GatewayError(message, status=status)


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
        raise GatewayError(
            f"平台工具网关未配置(缺 {ENV_BASE},亦未检测到桌面登录凭证),无法调用平台能力。",
            code="gateway_unconfigured",
        )
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
            raise GatewayError(
                f"无法连接平台服务(网络错误):{exc}。请检查网络/代理后重试;凭据本身没有问题。",
                code="network_unreachable",
            ) from exc
        if response.status_code == 429 and attempt < _MAX_429_RETRIES:
            delay = _retry_after_seconds(response, attempt)
            attempt += 1
            logger.info("gateway 429 on %s — backoff %.1fs (attempt %d)", path, delay, attempt)
            time.sleep(delay)
            continue
        if response.status_code >= 400:
            raise _error_from_response(response, source, path=path)
        try:
            body = response.json()
        except Exception as exc:  # noqa: BLE001
            raise GatewayError("平台工具网关返回了无法解析的响应,请稍后重试。") from exc
        if not isinstance(body, dict):
            raise GatewayError("平台工具网关返回了意外的响应格式,请稍后重试。")
        return body


def unwrap(response_body: dict[str, Any]) -> dict[str, Any]:
    """把网关 ``{data, cost_cents}`` 信封摊回工具结果面(保持 agent 无感)。"""
    data = response_body.get("data")
    out: dict[str, Any] = dict(data) if isinstance(data, dict) else ({} if data is None else {"data": data})
    if "cost_cents" in response_body and "cost_cents" not in out:
        out["cost_cents"] = response_body.get("cost_cents")
    return out


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


def transcribe_upload(upload_path: Path | str, *, timeout: float) -> dict[str, Any]:
    """把一个本地音频文件提交转写(插件转写路径的唯一提交口)。

    >阈值走「upload-url → PUT 直传 COS → JSON media_url 提交」三跳(大文件不过
    nginx/scheduler 的 multipart 同步管道);≤阈值维持 multipart。直传**通道**故障
    (旧网关无端点、COS 不可用、PUT 失败)自动回退 multipart,绝不因通道失败让转写
    失败;转写本身的业务错误(402/413/429/鉴权)原样抛 :class:`GatewayError`。
    """
    source = Path(upload_path)
    size = source.stat().st_size
    if size > asr_direct_upload_threshold_bytes():
        result = _transcribe_via_direct_upload(source, size, timeout=timeout)
        if result is not None:
            return result
    with open(source, "rb") as fh:
        files = {"file": (source.name, fh, guess_media_content_type(source))}
        return request_json("POST", "/tools/v1/asr/transcribe", files=files, timeout=timeout)


def _transcribe_via_direct_upload(
    source: Path, size: int, *, timeout: float
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
    return request_json(
        "POST", "/tools/v1/asr/transcribe", {"media_url": media_url}, timeout=timeout
    )


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
    except Exception:  # noqa: BLE001
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
                                f"媒体直链下载失败(HTTP {response.status_code}),链接可能已过期。",
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
                            if expected_total is not None and expected_total != response_expected:
                                raise GatewayError(
                                    "媒体直链在续传时长度发生变化,已停止使用残缺文件。",
                                    code="media_download_size_changed",
                                )
                            expected_total = response_expected

                        # Range 被忽略(200)时必须覆盖，绝不能把完整响应追加到残件后面。
                        mode = "ab" if append else "wb"
                        with open(partial, mode) as fh:
                            for chunk in response.iter_bytes():
                                fh.write(chunk)

                        actual = partial.stat().st_size
                        if expected_total is not None and actual != expected_total:
                            continue
                        if actual <= 0:
                            continue
                        partial.replace(dest)
                        return dest
                except (httpx.HTTPError, GatewayError):
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
            raise GatewayError("媒体续传响应缺少有效的 Content-Range。", code="invalid_content_range")
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
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except Exception:  # noqa: BLE001 — 抽取失败回退原文件,不是致命错误
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
