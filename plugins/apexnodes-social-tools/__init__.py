"""ApexNodes social data tools.

平台工具网关 P1(DESKTOP-CLOUD-CAPABILITY-PARITY-PD D1/D2):本插件自
hermes-cloud ``app/runtime_plugins/apexnodes-social-tools`` 迁入 fork,
桌面与云端同一份代码。默认走平台工具网关
``/tools/v1/social/{platform}/{action}``(vendor key 永不出云);
``TOOLS_GATEWAY_DISABLED=1`` 时回退迁移前的 master 数据网关路径
(云端 P1 回退通道,P2 删)。
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


CAPABILITIES = (
    "content",
    "search",
    "profile",
    "comments",
    "trending",
    "posts",
    "captions",
    # hc-600: 抖音官方洞察族(巨量算数)+ 在售商品。这四个是 cloud 侧 hc-600 就已加上、
    # fork 侧一直没跟的那批——契约 v2→v4 里差的就是它们(v3 也从未同步到本仓)。
    "keyword_insight",
    "audience",
    "creator_discovery",
    "product",
)


def _use_gateway() -> bool:
    return _gateway is not None and _gateway.use_gateway()


# ── legacy master 数据网关路径(迁移前行为,原样保留) ──────────────────────────

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


def _request(method: str, path: str, payload: dict[str, Any] | None = None, timeout: int = 90) -> dict[str, Any]:
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
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw).get("detail", raw)
        except json.JSONDecodeError:
            detail = raw
        if isinstance(detail, dict):
            message = detail.get("message") or detail.get("code") or raw
        else:
            message = str(detail or raw)
        raise RuntimeError(message) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接跨平台数据服务: {exc.reason}") from exc


def _legacy_check() -> bool:
    try:
        data = _request("GET", "/data/social/check", timeout=5)
        return bool(data.get("configured"))
    except Exception:
        return False


def _check() -> bool:
    # 网关模式:可用性=配置齐(base+key);额度/限流/上游故障在调用时显式报错。
    if _use_gateway():
        return bool(_gateway.agent_api_key())
    return _legacy_check()


def _schema(name: str, description: str, required: list[str]) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": {
                "platform": {
                    "type": "string",
                    "description": "One of douyin, xiaohongshu, tiktok, instagram, youtube, bilibili, kuaishou, wechat_channels, wechat_mp.",
                },
                "query": {"type": "string", "description": "Search query or keyword."},
                "url": {"type": "string", "description": "Content URL when available."},
                "user_id": {"type": "string", "description": "Platform user id / sec_user_id / channel id / username."},
                "item_id": {"type": "string", "description": "Platform content id such as aweme_id, note_id, or video_id."},
                "cursor": {"type": "string", "description": "Pagination cursor."},
                "count": {"type": "integer", "description": "Result count, max 100."},
                "params": {"type": "object", "description": "Provider-specific read-only parameters when needed."},
            },
            "required": required,
        },
    }


SCHEMAS = {
    "social_content": _schema("social_content", "Fetch one public social post/video by platform and URL or item id.", ["platform"]),
    "social_search": _schema("social_search", "Search public content on a whitelisted social platform.", ["platform", "query"]),
    "social_profile": _schema("social_profile", "Fetch a public creator/profile record from a whitelisted social platform.", ["platform", "user_id"]),
    "social_comments": _schema("social_comments", "Fetch public comments for one social content item.", ["platform", "item_id"]),
    "social_trending": _schema("social_trending", "Fetch public trending/hot content for a whitelisted social platform.", ["platform"]),
    "social_posts": _schema("social_posts", "List a public creator's recent posts/videos by platform and creator id (any platform's id spelling).", ["platform", "user_id"]),
    "social_captions": _schema("social_captions", "Fetch a YouTube video's official subtitle/caption text by URL or video id — a transcript with no ASR cost.", ["platform"]),
}

# hc-600: the insight tools take a keyword / a date window / a sub-intent rather
# than one object id, so they get their own schema instead of the id-shaped one.
# Kept byte-for-byte in step with hermes-cloud's copy — the shared contract locks
# the parameter projection (names/types/required/enum), so a one-sided edit here
# turns BOTH repos' contract tests red.
INSIGHT_SCHEMAS: dict[str, dict[str, Any]] = {
    "social_keyword_insight": {
        "name": "social_keyword_insight",
        "description": (
            "抖音官方（巨量算数）关键词洞察：一个题材/关键词现在热不热、趋势往哪走、有哪些关联长尾词、"
            "当前有哪些实时热点。找选题、判断题材热度时用这个，而不是用 social_search 抓几条样本去猜。"
            "focus 选择要哪一面：trend=热度日趋势(默认)｜overview=一句话水位概览｜related=关联词/长尾选题｜"
            "hot_topics=实时热点榜(不传关键词时的默认)｜topic=某个热点的详情(topic 必须逐字来自 hot_topics)。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "platform": {"type": "string", "description": "目前仅 douyin（巨量算数是抖音官方数据）。"},
                "keyword": {"type": "string", "description": "要看的关键词，例如「猫粮」。"},
                "keyword_list": {"type": "string", "description": "多个关键词做对比，英文逗号分隔，例如「猫粮,狗粮」。"},
                "focus": {"type": "string", "description": "trend | overview | related | hot_topics | topic"},
                "topic": {"type": "string", "description": "focus=topic 时的热点名，必须与 hot_topics 返回的名字逐字一致。"},
                "start_date": {"type": "string", "description": "可选，YYYYMMDD 或 YYYY-MM-DD。不传则自动取最近一个有效的 30 天窗口。"},
                "end_date": {"type": "string", "description": "可选，同上。数据有约两天延迟，不传即可，别自己顶到今天。"},
            },
            "required": ["platform"],
        },
    },
    "social_audience": {
        "name": "social_audience",
        "description": (
            "抖音官方（巨量算数）人群画像：某个题材/关键词的受众是谁 —— 年龄、性别、地域、兴趣等维度的"
            "占比与 TGI 偏好强度。回答「谁在看/谁在买」时用。注意这是**题材的人群**，不是某个账号的粉丝。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "platform": {"type": "string", "description": "目前仅 douyin。"},
                "keyword": {"type": "string", "description": "要看受众的关键词/题材，例如「猫粮」。"},
                "start_date": {"type": "string", "description": "可选 YYYYMMDD；不传自动取最近有效窗口。"},
                "end_date": {"type": "string", "description": "可选 YYYYMMDD。"},
            },
            "required": ["platform", "keyword"],
        },
    },
    "social_creator_discovery": {
        "name": "social_creator_discovery",
        "description": (
            "按关键词找达人/对标账号（抖音官方达人库）：返回候选达人的名字、粉丝数、点赞总数、作品数、"
            "垂类标签与主页链接。用户说「帮我找几个对标账号」「这个品类谁在做」但**给不出链接**时用这个；"
            "已经有账号链接/ID 时用 social_profile 或 social_posts。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "platform": {"type": "string", "description": "目前仅 douyin。"},
                "keyword": {"type": "string", "description": "品类/题材关键词，例如「猫粮」「美妆」。"},
                "count": {"type": "integer", "description": "候选数量，默认 20，最多 50。"},
            },
            "required": ["platform", "keyword"],
        },
    },
    "social_product": {
        "name": "social_product",
        "description": (
            "按关键词查平台在售商品：标题、价格、销量、评分、评价数、店铺。做爆品/选品分析时用来看"
            "「同类商品在卖什么、什么价位、卖得怎样」。注意这是**商品**，不是讲商品的视频（那是 social_search）。"
            "目前仅 TikTok Shop（platform=tiktok）。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "platform": {"type": "string", "description": "目前仅 tiktok（TikTok Shop）。"},
                "keyword": {"type": "string", "description": "商品关键词。"},
            },
            "required": ["platform", "keyword"],
        },
    },
}

# hc-346: enumerate a creator's works and rank them by interaction volume — the
# batch-pipeline selector. The master pages the creator's posts feed (bounded by a
# scan cap), filters by like/collect/comment threshold + time range, and returns a
# ranked, honestly-annotated sample (it is a scanned window, not a platform-wide board).
CREATOR_TOP_POSTS_SCHEMA = {
    "name": "creator_top_posts",
    "description": (
        "List a creator's top works ranked by interaction volume. Give a creator homepage link "
        "(url) — or a single douyin 合集/mix share link (url) to enumerate just that collection — "
        "or platform+user_id, plus a like threshold (min_likes, e.g. 100000). Returns the "
        "scanned posts that meet the threshold, ranked, with an honest 'scanned N, M matched' note. "
        "Read-only enumeration — no download/transcription."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "platform": {"type": "string", "description": "douyin/xiaohongshu/tiktok/kuaishou/bilibili/youtube/instagram. Optional if url is given."},
            "url": {"type": "string", "description": "Creator homepage share link (douyin 主页 分享链接), or a douyin 合集 share link (douyin.com/collection/… or mix/…) to enumerate only that collection."},
            "user_id": {"type": "string", "description": "Creator id (e.g. douyin sec_user_id) when you already have it."},
            "min_likes": {"type": "integer", "description": "Keep only posts with at least this many likes (e.g. 100000 for 10万)."},
            "min_collects": {"type": "integer", "description": "Optional minimum collect/favorite count."},
            "min_comments": {"type": "integer", "description": "Optional minimum comment count."},
            "since": {"type": "string", "description": "Optional earliest publish date (YYYY-MM-DD)."},
            "until": {"type": "string", "description": "Optional latest publish date (YYYY-MM-DD)."},
            "sort_by": {"type": "string", "description": "Rank by: likes (default), collects, comments, shares, plays, published."},
            "top": {"type": "integer", "description": "Return at most this many ranked posts."},
            "scan_limit": {"type": "integer", "description": "Cap how many recent posts to scan (default platform cap)."},
        },
        "required": [],
    },
}


def _payload(args: dict) -> dict[str, Any]:
    if not isinstance(args, dict):
        raise RuntimeError("tool expects a JSON object argument")
    platform = str(args.get("platform") or "").strip().lower()
    if not platform:
        raise RuntimeError("请提供 platform")
    return {
        "platform": platform,
        "query": args.get("query"),
        "url": args.get("url"),
        "keyword": args.get("keyword"),
        "user_id": args.get("user_id"),
        "item_id": args.get("item_id"),
        "cursor": args.get("cursor"),
        "count": args.get("count"),
        "params": args.get("params") if isinstance(args.get("params"), dict) else {},
    }


def _gateway_platform_or_error(platform: str) -> str | None:
    """返回错误文案(平台不在白名单),合法时返回 None。"""
    if platform in _gateway.SOCIAL_PLATFORMS:
        return None
    supported = "、".join(_gateway.SOCIAL_PLATFORMS)
    return f"不支持的平台「{platform}」(当前支持: {supported})"


def _insight_payload(args: dict) -> dict[str, Any]:
    """hc-600: the insight tools speak keywords / windows / a sub-intent. ``topic``
    is renamed to the gateway's ``topic_name`` here so the agent-facing name stays
    plain while the wire contract stays explicit."""
    if not isinstance(args, dict):
        raise RuntimeError("tool expects a JSON object argument")
    platform = str(args.get("platform") or "").strip().lower()
    if not platform:
        raise RuntimeError("请提供 platform")
    payload: dict[str, Any] = {"platform": platform}
    for key in ("keyword", "keyword_list", "focus", "start_date", "end_date", "count"):
        value = args.get(key)
        if value not in (None, ""):
            payload[key] = value
    if args.get("topic") not in (None, ""):
        payload["topic_name"] = args["topic"]
    return payload


def _insight_handler(capability: str):
    """Same two legs as :func:`_handler` — the insight family only differs in how the
    payload is shaped, not in how it travels. Keeping the transport identical is what
    lets the shared contract assert one endpoint family per tool across both repos."""

    def handle(args: dict, **_kwargs) -> str:
        try:
            payload = _insight_payload(args)
        except RuntimeError as exc:
            return tool_error(f"跨平台数据查询失败: {exc}")
        if _use_gateway():
            platform = payload["platform"]
            invalid = _gateway_platform_or_error(platform)
            if invalid:
                return tool_error(f"跨平台数据查询失败: {invalid}")
            try:
                response = _gateway.request_json(
                    "POST", f"/tools/v1/social/{platform}/{capability}", payload, timeout=90
                )
            except _gateway.GatewayError as exc:
                return tool_error(f"跨平台数据查询失败: {exc}")
            return tool_result(**_gateway.unwrap(response))
        try:
            return tool_result(**_request("POST", f"/data/social/{capability}", payload))
        except RuntimeError as exc:
            return tool_error(f"跨平台数据查询失败: {exc}")

    return handle


def _handler(capability: str):
    def handle(args: dict, **_kwargs) -> str:
        try:
            payload = _payload(args)
        except RuntimeError as exc:
            return tool_error(f"跨平台数据查询失败: {exc}")
        if _use_gateway():
            platform = payload["platform"]
            invalid = _gateway_platform_or_error(platform)
            if invalid:
                return tool_error(f"跨平台数据查询失败: {invalid}")
            try:
                response = _gateway.request_json(
                    "POST", f"/tools/v1/social/{platform}/{capability}", payload, timeout=90
                )
            except _gateway.GatewayError as exc:
                return tool_error(f"跨平台数据查询失败: {exc}")
            return tool_result(**_gateway.unwrap(response))
        try:
            return tool_result(**_request("POST", f"/data/social/{capability}", payload))
        except RuntimeError as exc:
            return tool_error(f"跨平台数据查询失败: {exc}")

    return handle


def _creator_payload(args: dict) -> dict[str, Any]:
    if not isinstance(args, dict):
        raise RuntimeError("tool expects a JSON object argument")
    if not (args.get("url") or args.get("user_id")):
        raise RuntimeError("请提供创作者主页链接 url，或 platform + user_id")
    platform = args.get("platform")
    payload: dict[str, Any] = {
        "platform": str(platform).strip().lower() if platform else None,
        "url": args.get("url"),
        "user_id": args.get("user_id"),
        "since": args.get("since"),
        "until": args.get("until"),
        "sort_by": str(args.get("sort_by") or "likes").strip().lower(),
    }
    for key in ("min_likes", "min_collects", "min_comments", "top", "scan_limit"):
        value = args.get(key)
        if value is not None:
            try:
                payload[key] = int(value)
            except (TypeError, ValueError):
                raise RuntimeError(f"{key} 必须是整数") from None
    return {key: value for key, value in payload.items() if value is not None}


def _creator_handler(args: dict, **_kwargs) -> str:
    # enumeration pages the creator feed master-side; allow a longer budget.
    try:
        payload = _creator_payload(args)
    except RuntimeError as exc:
        return tool_error(f"创作者作品枚举失败: {exc}")
    if _use_gateway():
        platform = str(payload.get("platform") or "").strip() or (
            _gateway.detect_platform(str(payload.get("url") or "")) or ""
        )
        if not platform:
            return tool_error("创作者作品枚举失败: 无法识别平台，请提供 platform，或发送带平台域名的主页分享链接。")
        invalid = _gateway_platform_or_error(platform)
        if invalid:
            return tool_error(f"创作者作品枚举失败: {invalid}")
        payload["platform"] = platform
        try:
            response = _gateway.request_json(
                "POST", f"/tools/v1/social/{platform}/top-posts", payload, timeout=180
            )
        except _gateway.GatewayError as exc:
            return tool_error(f"创作者作品枚举失败: {exc}")
        return tool_result(**_gateway.unwrap(response))
    try:
        return tool_result(**_request("POST", "/data/creator/top-posts", payload, timeout=180))
    except RuntimeError as exc:
        return tool_error(f"创作者作品枚举失败: {exc}")


def register(ctx):
    for tool_name, capability in {
        "social_content": "content",
        "social_search": "search",
        "social_profile": "profile",
        "social_comments": "comments",
        "social_trending": "trending",
        "social_posts": "posts",
        "social_captions": "captions",
    }.items():
        ctx.register_tool(
            name=tool_name,
            toolset="skills",
            schema=SCHEMAS[tool_name],
            handler=_handler(capability),
            check_fn=_check,
            requires_env=[],
            description=SCHEMAS[tool_name]["description"],
            emoji="🔎",
        )
    for tool_name, capability in {
        "social_keyword_insight": "keyword_insight",
        "social_audience": "audience",
        "social_creator_discovery": "creator_discovery",
        "social_product": "product",
    }.items():
        ctx.register_tool(
            name=tool_name,
            toolset="skills",
            schema=INSIGHT_SCHEMAS[tool_name],
            handler=_insight_handler(capability),
            check_fn=_check,
            requires_env=[],
            description=INSIGHT_SCHEMAS[tool_name]["description"],
            emoji="🔎",
        )
    ctx.register_tool(
        name="creator_top_posts",
        toolset="skills",
        schema=CREATOR_TOP_POSTS_SCHEMA,
        handler=_creator_handler,
        check_fn=_check,
        requires_env=[],
        description=CREATOR_TOP_POSTS_SCHEMA["description"],
        emoji="🏆",
    )
