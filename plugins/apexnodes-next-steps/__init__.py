"""ApexNodes「下一步」块 — IM 编号腿与选题库路径(hc-993,协议 apex-next/1)。

协议单一事实源:apex-nodes ``docs/NEXT-STEPS-BLOCK-PROTOCOL.md``。

创作者技能交付一个结果后,在回复最后写一个 HTML 注释形式的「下一步」块::

    <!-- apex:next
    存进选题库 | 把这 5 个选题存进我的选题库
    写成脚本 | 把第 1 个选题写成 60 秒口播脚本
    -->

结果失败时只写一行 ``<!-- apex:next failed=生成视频 -->``,各端照 hc-973 的
「重试 / 换个办法 / 先给我能出的部分」给退路。HTML 注释在任何 Markdown 渲染里
都不显示,所以没有渲染层的旧桌面版看不到块的原文。

桌面端聊天的按钮由 APEX Desktop 渲染层画(fork ``apps/desktop/src/lib/next-steps.ts``),
本插件只管文字层:

* ``transform_llm_output``(每轮最终回复,改写后的文字就是发给用户、存进会话的文字):
  - ``desktop``:原样保留,渲染层把块画成按钮;
  - 没人能回编号的出口(``api_server`` / ``cron`` / ``webhook`` / ``subagent``):只删块;
  - 其余(飞书、微信、企微、钉钉、QQ、终端……):删块,在末尾换成「接下来可以：
    1. … 回复数字就行。」,并记住本会话「编号 → 那句话」。
* ``pre_llm_call``(下一轮开头,返回的文字附在用户这条消息后面给模型看):
  - 上一轮刚给过编号、这一条只是一个数字(「2」「第2个」「选 2」)→ 告诉模型
    「用户选了第 2 项,等于说了那句话」;编号只用一次,下一条消息一到就作废。
  - 这条消息(或选中的那句话)提到「选题库」→ 附上选题库文件的绝对路径和读写规则。
    路径由运行时的 HERMES_HOME 算出(云端是助手自己的持久卷,桌面端是本机
    ``~/.apexnodes``),模型不用猜。

同一份文件逐字节复制在 hermes-agent fork 的 ``plugins/apexnodes-next-steps/``:
APEX Desktop 的聊天(选题库路径)和本机网关接的 IM(编号)都靠那份。
apex-nodes ``tests/test_next_steps_block.py`` 在 CI 里比对两份字节相同。

开关:``NEXT_STEPS_DISABLE=1`` 时只删块,不出编号、不注入任何文字。
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import unicodedata
from collections import OrderedDict
from typing import Any, Optional

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = "apex-next/1"
MAX_OPTIONS = 3
MAX_LABEL_CHARS = 16
MAX_MESSAGE_CHARS = 300
MAX_TITLE_CHARS = 20
DEFAULT_FAILED_TITLE = "刚才那一步"

# 桌面端聊天:块原样留给渲染层画成按钮。
RENDERED_PLATFORMS = frozenset({"desktop"})
# 没人能回编号的出口:只删块,不出编号。
NON_INTERACTIVE_PLATFORMS = frozenset({"api_server", "cron", "webhook", "subagent"})

TOPIC_LIBRARY_KEYWORD = "选题库"

_MAX_SESSIONS = 512
_SELECTION_TTL_SECONDS = 24 * 3600

# 标记后面不能紧跟英文字母、数字或下划线;不用 \b,因为 Python 的 \b 把汉字当单词字符,
# 桌面端 TypeScript 的不会,两边要对同一段文字给出同一个答案。
_BLOCK_RE = re.compile(r"<!--\s*apex:next(?![A-Za-z0-9_])(?P<body>.*?)-->", re.DOTALL)
_MARKER = "apex:next"
# 模型把块包进了代码块(``` … ```):块删掉后留下的空代码块一起删。
_EMPTY_FENCE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})[^\n`]*\n(?:[ \t]*\n)*[ \t]*\1[ \t]*(?:\n|$)", re.MULTILINE)
_FAILED_RE = re.compile(r"^failed\s*=\s*(?P<title>.*)$")
_LIST_MARKER_RE = re.compile(r"^(?:[-*•]\s+|[0-9０-９]{1,2}\s*[.、)）．]\s*)")
_WRAPPERS = (("「", "」"), ("“", "”"), ('"', '"'), ("'", "'"), ("《", "》"), ("`", "`"))
_SELECTION_RE = re.compile(r"^(?:选\s*)?(?:第\s*)?([1-9])\s*(?:个|项|号|条)?\s*[.。、!！]?$")

# hc-973 桌面过程区失败三按钮的同一份文字(fork apps/desktop/src/i18n/{zh,en}-process.ts
# 的 failure 段;tests/test_next_steps_block.py 在 CI 里逐字比对)。
FAILURE_OPTIONS = {
    "zh": (
        ("重试", "再试一次「{title}」这一步。"),
        ("换个办法", "「{title}」这一步没成功，换个办法继续。"),
        ("先给我能出的部分", "「{title}」先跳过，把已经拿到的部分整理给我。"),
    ),
    "en": (
        ("Retry", 'Try the "{title}" step again.'),
        ("Try another way", "The \"{title}\" step didn't work. Try another way and carry on."),
        ("Give me what you have", 'Skip "{title}" for now and give me what you have so far.'),
    ),
}

NUMBERED_CHROME = {
    "zh": ("接下来可以：", "回复数字就行。"),
    "en": ("What's next:", "Reply with a number."),
}


def _disabled() -> bool:
    return (os.getenv("NEXT_STEPS_DISABLE") or "").strip().lower() in {"1", "true", "yes", "on"}


# ---------------------------------------------------------------------------
# 解析(纯函数)
# ---------------------------------------------------------------------------


def _has_cjk(text: str) -> bool:
    return any("㐀" <= ch <= "鿿" or "豈" <= ch <= "﫿" for ch in text)


def _unwrap(text: str) -> str:
    value = text.strip()
    for left, right in _WRAPPERS:
        if len(value) >= 2 and value.startswith(left) and value.endswith(right):
            return value[len(left) : -len(right)].strip()
    return value


def _split_option(line: str) -> Optional[tuple[str, str]]:
    cuts = [line.find(sep) for sep in ("|", "｜") if sep in line]
    if not cuts:
        return None
    cut = min(cuts)
    label = _unwrap(_LIST_MARKER_RE.sub("", line[:cut].strip()))
    message = _unwrap(line[cut + 1 :])
    if not (1 <= len(label) <= MAX_LABEL_CHARS and 1 <= len(message) <= MAX_MESSAGE_CHARS):
        return None
    return label, message


def _parse_body(body: str) -> Optional[dict]:
    """块内文字 → ``{"failed": 标题或 None, "options": [(按钮字, 那句话), ...]}``;没有可用内容返回 None。"""
    options: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in body.split("\n"):
        line = raw.strip()
        if not line:
            continue
        failed = _FAILED_RE.match(line)
        if failed and "|" not in line and "｜" not in line:
            title = _unwrap(failed.group("title"))[:MAX_TITLE_CHARS] or DEFAULT_FAILED_TITLE
            return {"failed": title, "options": []}
        option = _split_option(line)
        if option is None or option[0] in seen:
            continue
        seen.add(option[0])
        options.append(option)
        if len(options) == MAX_OPTIONS:
            break
    return {"failed": None, "options": options} if options else None


def _cut_unterminated_tail(text: str) -> str:
    """去掉末尾没写完的块(``<!-- apex:next`` 之后没有 ``-->``),也去掉只写了一半的开头标记。"""
    start = text.rfind("<!--")
    if start < 0 or "-->" in text[start:]:
        return text
    tail = text[start + 4 :].strip()
    if tail.startswith(_MARKER) or (tail and _MARKER.startswith(tail)):
        return text[:start]
    return text


def parse_next_steps(text: str) -> tuple[str, Optional[dict]]:
    """``(去掉所有块后的正文, 最后一个可用的块或 None)``。块写在哪里都删,只认最后一个。"""
    if not text or "<!--" not in text:
        return text or "", None
    block: Optional[dict] = None
    for match in _BLOCK_RE.finditer(text):
        parsed = _parse_body(match.group("body"))
        if parsed is not None:
            block = parsed
    removed = _BLOCK_RE.sub("", text)
    if removed != text:
        removed = _EMPTY_FENCE_RE.sub("", removed)
    visible = _cut_unterminated_tail(removed)
    if visible == text:
        return text, None
    return re.sub(r"\n{3,}", "\n\n", visible).strip(), block


def block_language(block: dict) -> str:
    sample = block["failed"] or "".join(label for label, _ in block["options"])
    return "zh" if _has_cjk(sample) else "en"


def options_for(block: dict) -> list[tuple[str, str]]:
    """按钮(或编号)要显示的选项;失败块换成 hc-973 的三项。"""
    if block["failed"] is None:
        return list(block["options"])
    title = block["failed"]
    return [(label, message.format(title=title)) for label, message in FAILURE_OPTIONS[block_language(block)]]


def render_numbered(visible: str, block: dict) -> str:
    head, tail = NUMBERED_CHROME[block_language(block)]
    lines = [head, *(f"{index}. {label}" for index, (label, _) in enumerate(options_for(block), 1)), tail]
    numbered = "\n".join(lines)
    return f"{visible}\n\n{numbered}" if visible else numbered


def parse_selection(text: Any) -> Optional[int]:
    """「2」「第2个」「选 2」「２」「②」→ 2;别的都不算。"""
    if not isinstance(text, str):
        return None
    normalized = unicodedata.normalize("NFKC", text).strip()
    match = _SELECTION_RE.match(normalized)
    return int(match.group(1)) if match else None


def selection_directive(reply: str, number: int, label: str, message: str) -> str:
    # 那句话单独一行:它自己常带「」和句号,再套一层引号会变成「「…。」。
    return (
        f"【下一步】用户回复「{reply}」，就是选了你上一条回复末尾编号里的第 {number} 项「{label}」，"
        f"等于用户说了这句话：\n{message}\n直接照这句话做，不要再问用户选的是哪一项。"
    )


def topic_library_path() -> str:
    """运行时自己的 HERMES_HOME(按当前 profile);不在运行时里(apex-nodes 的测试)时读环境变量。"""
    try:
        from hermes_constants import get_hermes_home
    except ImportError:
        home = os.getenv("HERMES_HOME") or os.path.join(os.path.expanduser("~"), ".hermes")
    else:
        home = str(get_hermes_home())
    return os.path.join(home, "apex", "选题库.md")


def topic_library_context(path: str) -> str:
    return "\n".join(
        (
            f"【选题库】这位用户的选题库是一个 Markdown 文件：{path}（可能还没建）。",
            "- 存选题：文件不存在就用 write_file 新建，第一行写「# 我的选题库」；已经存在就先用 read_file 读全文，"
            "把新选题接在最后，再用 write_file 整份写回，原有条目一个字都不改、不删。",
            "- 每个选题一段：一行「## 选题标题」，下面依次写「- 平台：」「- 一句话：」「- 来源：」（没有就写“自己想的”）"
            "「- 状态：待写」「- 存入：年-月-日」。库里已有同名标题就不重复存。",
            "- 看选题库：用 read_file 读出来，按状态（待写、已写脚本、已拍、已发）分组列给用户；文件不存在就说还没存过选题。",
            "- 改状态：读全文后只改那一条的「状态」行（用户给了发布链接，就在这一条里加一行「- 已发链接：」），再整份写回。",
            "- 回复里说“已存进你的选题库，现在一共 N 个”这类话，不提文件路径和工具名。",
        )
    )


# ---------------------------------------------------------------------------
# 会话状态:编号 → 那句话(只用一次)
# ---------------------------------------------------------------------------

_state_lock = threading.Lock()
_pending: OrderedDict[str, dict] = OrderedDict()


def _remember(session_id: str, options: list[tuple[str, str]]) -> None:
    with _state_lock:
        _pending.pop(session_id, None)
        _pending[session_id] = {"options": options, "at": time.monotonic()}
        while len(_pending) > _MAX_SESSIONS:
            _pending.popitem(last=False)


def _take(session_id: str) -> Optional[list[tuple[str, str]]]:
    with _state_lock:
        entry = _pending.pop(session_id, None)
    if entry is None or time.monotonic() - entry["at"] > _SELECTION_TTL_SECONDS:
        return None
    return entry["options"]


def _reset_state() -> None:
    with _state_lock:
        _pending.clear()


def _log_event(event: str, **fields: Any) -> None:
    payload = {"event": event, **{k: v for k, v in fields.items() if v not in (None, "")}}
    logger.info("next_steps %s", json.dumps(payload, ensure_ascii=False, sort_keys=True))


# ---------------------------------------------------------------------------
# Hooks
# ---------------------------------------------------------------------------


def _on_transform_llm_output(
    response_text: Any = None,
    session_id: str = "",
    platform: str = "",
    **_: Any,
) -> Optional[str]:
    if not isinstance(response_text, str) or "<!--" not in response_text:
        return None
    if platform in RENDERED_PLATFORMS and not _disabled():
        return None
    visible, block = parse_next_steps(response_text)
    if visible == response_text:
        return None
    if _disabled() or platform in NON_INTERACTIVE_PLATFORMS or block is None:
        _log_event("stripped", platform=platform, had_block=block is not None)
        return visible or None
    options = options_for(block)
    if session_id:
        _remember(session_id, options)
    _log_event("numbered", platform=platform, count=len(options), failed=block["failed"] is not None)
    return render_numbered(visible, block)


def _on_pre_llm_call(
    user_message: Any = None,
    session_id: str = "",
    platform: str = "",
    **_: Any,
) -> Optional[str]:
    if _disabled():
        return None
    text = user_message if isinstance(user_message, str) else ""
    parts: list[str] = []
    chosen = ""
    options = _take(session_id) if session_id else None
    if options:
        number = parse_selection(text)
        if number is not None and number <= len(options):
            label, chosen = options[number - 1]
            parts.append(selection_directive(text.strip(), number, label, chosen))
            _log_event("selected", platform=platform, number=number)
    if TOPIC_LIBRARY_KEYWORD in text or TOPIC_LIBRARY_KEYWORD in chosen:
        parts.append(topic_library_context(topic_library_path()))
    return "\n\n".join(parts) or None


def register(ctx) -> None:
    ctx.register_hook("transform_llm_output", _on_transform_llm_output)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
