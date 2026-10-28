"""hc-1088 多助手接力 · 引擎这一半: a job one assistant hands to another, and what comes back.

Phase 2 of several assistants on APEX Desktop: the user @-mentions an assistant or clicks 「交给 X」,
and the job runs in the receiving assistant's own 「APEX 主线」. Desktop (hc-1086) composes the
hand-over message and submits it there. This seam makes both engines handle it:

* taking a job: a user message that starts with ``<!-- apex:handoff v=1 id=… from=… -->`` gets a
  note for that turn: do only what was asked, hand nothing on (no nesting), and end with an
  ``<!-- apex:handback … -->`` block, the 交回摘要;
* handing it back: when that turn ends, the block (or, without one, the start of the reply) goes into
  the sender's return box ``<root>/apex/handoff/returns/<from>/<id>.json``, so it arrives even while
  Desktop's window is closed;
* the sender's next turn carries what came back, once, as hc-1082 tells a renamed session its name;
* the ``apex.handoff`` section lists the user's other assistants with the 「分工」 hc-1079 wrote into
  each SOUL.md, so an assistant can offer a job to the one it belongs to with a 「交给」 line in its
  next-step block (hc-1089; the user clicks, the assistant only offers), and a session hears once when
  that list changed after its prompt was frozen. The skills' 「交给」 rule counts on this list.

The message, the block and the readers' rules are pinned in ``apps/desktop/shared/apex-handoff-cases.json``,
which Desktop's tests and these read.

Desktop's main process sets ``APEX_MULTI_BOT_HANDOFF_ACTIVE=1`` (``desktop_features.multi_bot_handoff``)
only next to ``APEX_MULTI_BOT_ACTIVE=1``, and both count only with ``APEX_SINGLE_THREAD_ACTIVE=1``.
Without all three (the switch off, or a cloud container, which sets none) nothing is registered and
every prompt is byte for byte what it was. Only Desktop chat sessions (platform ``desktop``) take part:
subagents, cron, the Desktop-hosted IM gateway (no relay in WeChat) and the embedded terminal see none
of it. Upstream's Bot Chat, ``message_agent`` and ``bot_mode_protocol`` are not used.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import time
from pathlib import Path
from typing import Any, Mapping, Optional

from apex_overlay import assistant_name

logger = logging.getLogger(__name__)

SWITCH_ENV = "APEX_MULTI_BOT_HANDOFF_ACTIVE"
SECTION_ID = "apex.handoff"
MAX_CHARS = 2_000
# Only Desktop chat sessions hand a job over or take one.
PLATFORM = "desktop"
MAIN_PROFILE = "default"

# ── the hand-over message (Desktop writes it; only its first line is read here) ──

PROTOCOL_VERSION = "1"
# The header opens the message, or a paragraph after the gateway's own per-turn notes (a reaction, the HUD,
# interrupted speech), which it puts in front of the model input with a blank line between.
_REQUEST_RE = re.compile(r"(?:\A|\n[ \t]*\n)\s*<!--\s*apex:handoff(?![A-Za-z0-9_])(?P<attrs>[^\n]*?)-->")
_ATTR_RE = re.compile(r"([a-z]+)=(\S+)")
_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
# hermes_constants.PROFILE_ID_RE ("default" included).
_PROFILE_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")

# ── the 交回摘要 block at the end of the receiving turn's reply ──

RETURN_MARKER = "apex:handback"
_RETURN_RE = re.compile(r"<!--\s*apex:handback(?![A-Za-z0-9_])(?P<body>.*?)-->", re.DOTALL)
# apexnodes-next-steps' rule: a block wrapped in a code fence leaves an empty fence behind; drop it too.
_EMPTY_FENCE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})[^\n`]*\n(?:[ \t]*\n)*[ \t]*\1[ \t]*(?:\n|$)", re.MULTILINE)
_LIST_MARKER_RE = re.compile(r"^[-*•]\s*")
_ITEM_RE = re.compile(r"^(?P<key>文件|链接|files?|links?)\s*[:：]\s*(?P<value>.*)$", re.IGNORECASE)
_FILE_KEYS = frozenset({"文件", "file", "files"})
_MARKDOWN_LINK_RE = re.compile(r"^\[[^\]]*\]\((?P<url>[^)\s]+)\)$")
_WRAPPERS = (("「", "」"), ("“", "”"), ('"', '"'), ("'", "'"), ("《", "》"), ("`", "`"), ("<", ">"))
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
SUMMARY_MAX_CHARS = 600
# Without a block, this much of the reply goes back instead.
HEAD_MAX_CHARS = 300
MAX_ITEMS = 10

# ── 「分工」 in a SOUL.md (hc-1079 bot-intake-copy.ts, every locale it writes) ──

DIVISION_HEADINGS = ("## 分工", "## What you handle")
ROLE_PREFIXES = ("- 主要帮用户：", "- 主要幫用戶：", "- Mainly help with: ")
PLATFORM_PREFIXES = ("- 主要给哪个平台做：", "- 主要給哪個平台做：", "- Main platform: ")
SAME_AS_APEX_LINES = (
    "- 主要给哪个平台做：跟 APEX 一样，按用户画像里的主要发布平台",
    "- 主要給哪個平台做：跟 APEX 一樣，按用戶畫像裡的主要發佈平台",
    "- Main platform: same as APEX, the platforms in the user profile",
)
_DIVISION_RE = re.compile(
    r"(?:^|\n)(?:" + "|".join(map(re.escape, DIVISION_HEADINGS)) + r")[ \t]*(?:\n(?P<body>.*?))?(?=\n## |\Z)",
    re.DOTALL,
)
ROLE_MAX_CHARS = 60
MAX_ROSTER = 8

# ── what this engine says ──

SECTION_HEAD = "【APEX 接力 · 平台规则】"
# The 「交给」 line of an apex:next block (apex-nodes docs/NEXT-STEPS-BLOCK-PROTOCOL.md §1, §9, hc-1089).
HANDOFF_ITEM = "`@助手名字 | 按钮字 | 要它做什么`"
OFFER_RULE = (
    "- 下一步明显该由其中一个助手来做时，可以在回复最后的「下一步」块里写一行「交给」项："
    f"{HANDOFF_ITEM}。名字照上面写；按钮字动词开头，不写「交给」和名字；要它做什么用用户的口吻写清对哪个结果做什么；"
    "和别的项一起最多 3 项。用户点了才交，你自己交不了，也不替它做；顺手的小事自己做，不提。"
)
TURN_RULE = "- 别的助手交来活、或者把你交出去的活交回来时，那一回合会另外告诉你怎么接。"
MAIN_ROLE = "主助手，什么活都能接"
NO_ROLE = "还没定分工"

TAKING = """（这一回合是「{sender}」交给你的活，上面这条消息是它转来的：「要你做」是用户要你做的事，后面是「{sender}」上一条结果和里面的文件、链接。
- 只做「要你做」里那件事，用带来的结果和文件，不用让用户再讲一遍前情；缺只有用户知道的关键信息，照常用提问卡问。
- 这一回合不提议交给别的助手，不加「下一步」块，也不主动提下一件事：用户会回到「{sender}」那边接着做。
- 做完在回复最后写交回摘要，块后面不再写字；没有文件或链接就不写那一行：
<!-- apex:handback
一到三句（200 字以内）：做了什么、结果是什么、还要用户定什么
文件：本机文件的完整路径，一个一行
链接：网址，一个一行
-->
- 这次接力不用你记进记忆底账。）"""
RETURNED = "（「{receiver}」把你交给它的活做完交回了，下面是它的交回摘要，只转给你这一次："
RETURNED_TAIL = "用户说到这件事时照这个接着说：结果在「{receiver}」那边，不用重做，也别再交一遍；这次接力不用记进记忆底账。）"
RETURNED_BARE = "（「{receiver}」做完了你交给它的那一回合，但没写交回摘要（可能没做完或被停下）。它回复的开头："
RETURNED_BARE_TAIL = "用户问起时照实说，要看全文请用户去「{receiver}」那边；这次接力不用记进记忆底账。）"
ROSTER_NOW = (
    "（用户在 APEX 里的其他助手现在是这几个，各有分工：\n{lines}\n"
    f"下一步明显该由其中一个来做时，可以在「下一步」块里写一行「交给」项：{HANDOFF_ITEM}，用户点了才交。）"
)
ROSTER_NONE = "（用户现在没有别的助手了，不用再提议交给谁。）"

# A returned job older than this is dropped unread.
RETURN_MAX_AGE_SECONDS = 7 * 24 * 3600
# At most this many come back in one turn (a relay is at most 3 batons); the rest wait for the next.
MAX_RETURNS_PER_TURN = 3

# The roster each session was last given (its frozen section or a note), by session id; "" = none.
_told: dict[str, str] = {}
_MAX_TOLD = 512


def switch_on() -> bool:
    """Relay is on for this engine: Desktop set the relay variable next to the multi-bot pair."""
    return os.environ.get(SWITCH_ENV, "").strip() == "1" and assistant_name.switch_on()


# ── readers (twins of Desktop's, pinned by apex-handoff-cases.json) ──────────


def _message_text(message: Any) -> str:
    if isinstance(message, str):
        return message
    if isinstance(message, list):
        texts = [part.get("text") for part in message if isinstance(part, Mapping) and part.get("type") == "text"]
        return "\n\n".join(text for text in texts if isinstance(text, str))
    return ""


def parse_request(message: Any) -> Optional[dict]:
    """``{"id", "from"}`` when the message opens with a hand-over header (its first one counts), else None."""
    match = _REQUEST_RE.search(_message_text(message))
    if match is None:
        return None
    attrs: dict[str, str] = {}
    for token in match.group("attrs").split():
        pair = _ATTR_RE.fullmatch(token)
        if pair is None or pair.group(1) in attrs:
            return None
        attrs[pair.group(1)] = pair.group(2)
    if attrs.get("v") != PROTOCOL_VERSION:
        return None
    handoff_id, sender = attrs.get("id", ""), attrs.get("from", "")
    if not _ID_RE.fullmatch(handoff_id) or not _PROFILE_RE.fullmatch(sender):
        return None
    return {"id": handoff_id, "from": sender}


def _cap(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


def _unwrap(value: str) -> str:
    value = value.strip()
    link = _MARKDOWN_LINK_RE.match(value)
    if link:
        return link.group("url")
    for left, right in _WRAPPERS:
        if len(value) >= 2 and value.startswith(left) and value.endswith(right):
            return value[len(left) : len(value) - len(right)].strip()
    return value


def _return_body(body: str) -> Optional[dict]:
    summary: list[str] = []
    files: list[str] = []
    links: list[str] = []
    for line in body.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        text = line.strip()
        if not text:
            continue
        item = _ITEM_RE.match(_LIST_MARKER_RE.sub("", text, count=1))
        if item is None:
            summary.append(text)
            continue
        bucket = files if item.group("key").lower() in _FILE_KEYS else links
        value = _unwrap(item.group("value"))
        if value and value not in bucket and len(bucket) < MAX_ITEMS:
            bucket.append(value)
    joined = "\n".join(summary)
    if not (joined or files or links):
        return None
    return {"summary": _cap(joined, SUMMARY_MAX_CHARS), "files": files, "links": links}


def _cut_unterminated_tail(text: str) -> str:
    start = text.rfind("<!--")
    if start < 0 or "-->" in text[start:]:
        return text
    tail = text[start + 4 :].strip()
    if tail.startswith(RETURN_MARKER) or (tail and RETURN_MARKER.startswith(tail)):
        return text[:start]
    return text


def parse_return(text: str) -> tuple[str, Optional[dict]]:
    """``(the reply without any 交回 block, the last usable block or None)``; apexnodes-next-steps' rules."""
    if not text or "<!--" not in text:
        return text or "", None
    block: Optional[dict] = None
    for match in _RETURN_RE.finditer(text):
        parsed = _return_body(match.group("body"))
        if parsed is not None:
            block = parsed
    removed = _RETURN_RE.sub("", text)
    if removed != text:
        removed = _EMPTY_FENCE_RE.sub("", removed)
    visible = _cut_unterminated_tail(removed)
    if visible == text:
        return text, None
    return re.sub(r"\n{3,}", "\n\n", visible).strip(), block


def parse_division(soul: str) -> dict:
    """``{"role", "platforms"}`` from a SOUL's 「分工」 section; None for what it does not say."""
    found: dict[str, Optional[str]] = {"role": None, "platforms": None}
    match = _DIVISION_RE.search(soul.replace("\r\n", "\n").replace("\r", "\n"))
    if match is None:
        return found
    for line in (match.group("body") or "").split("\n"):
        line = line.rstrip()
        if found["role"] is None:
            found["role"] = next((line[len(p) :].strip() or None for p in ROLE_PREFIXES if line.startswith(p)), None)
        if found["platforms"] is None and line not in SAME_AS_APEX_LINES:
            found["platforms"] = next(
                (line[len(p) :].strip() or None for p in PLATFORM_PREFIXES if line.startswith(p)), None
            )
    return found


# ── the user's assistants ────────────────────────────────────────────────────


def profile_key(home: Path) -> str:
    return MAIN_PROFILE if assistant_name.is_main(home) else home.name


def _home_of(profile: str) -> Path:
    from hermes_constants import get_default_hermes_root

    root = get_default_hermes_root()
    return root if profile == MAIN_PROFILE else root / "profiles" / profile


def _ui_meta(home: Path) -> dict:
    import hermes_yaml as yaml

    try:
        data = yaml.safe_load((home / "profile.yaml").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        logger.warning("apex-overlay: could not read %s", home / "profile.yaml", exc_info=True)
        return {}
    ui_meta = data.get("ui_meta") if isinstance(data, dict) else None
    return ui_meta if isinstance(ui_meta, dict) else {}


def _entry(ui_meta: dict, key: str) -> dict:
    value = ui_meta.get(key)
    return value if isinstance(value, dict) else {}


def _created(ui_meta: dict) -> Optional[float]:
    for created in (_entry(ui_meta, assistant_name.META_KEY).get("created"), _entry(ui_meta, "hermes-bots").get("created")):
        if isinstance(created, (int, float)) and not isinstance(created, bool) and math.isfinite(created):
            return float(created)
    return None


def _soul(home: Path) -> str:
    try:
        return (home / "SOUL.md").read_bytes().decode("utf-8", errors="replace")
    except OSError:
        return ""


def _display_name(profile: str, ui_meta: dict) -> str:
    """The sidebar's name: ``ui_meta.apex.name``, else APEX for the main assistant and the profile id for others."""
    name = assistant_name.clean_name(_entry(ui_meta, assistant_name.META_KEY).get("name"))
    if name and len(name) <= assistant_name.MAX_STORED_CHARS:
        return name
    return assistant_name.DEFAULT_NAME if profile == MAIN_PROFILE else profile


def name_of(profile: str) -> str:
    return _display_name(profile, _ui_meta(_home_of(profile)))


def roster() -> list[dict]:
    """The sidebar's assistants (store/single-thread-bots.ts ``botRosterFrom``): APEX first, then every
    live named profile with a SOUL.md that Bot Mode has not hidden, oldest first."""
    from hermes_cli.profiles import list_profile_names

    try:
        named = [name for name in list_profile_names() if name != MAIN_PROFILE]
    except Exception:
        logger.warning("apex-overlay: could not list the profiles for the relay roster", exc_info=True)
        named = []
    others = []
    for profile in named:
        home = _home_of(profile)
        ui_meta = _ui_meta(home)
        soul = _soul(home)
        if _entry(ui_meta, "hermes-bots").get("hidden") is True or not soul.strip():
            continue
        others.append((_created(ui_meta), profile, ui_meta, soul))
    others.sort(key=lambda row: (row[0] is None, row[0] or 0.0, row[1]))
    main_home = _home_of(MAIN_PROFILE)
    rows = [(MAIN_PROFILE, _ui_meta(main_home), _soul(main_home))] + [row[1:] for row in others]
    return [
        {"profile": profile, "name": _display_name(profile, ui_meta), **parse_division(soul)}
        for profile, ui_meta, soul in rows[: MAX_ROSTER + 1]
    ]


def _roster_lines(own: str) -> str:
    lines = []
    for assistant in roster():
        if assistant["profile"] == own:
            continue
        role = _cap(assistant["role"], ROLE_MAX_CHARS) if assistant["role"] else ""
        if assistant["profile"] == MAIN_PROFILE:
            work = f"主助手，{role}" if role else MAIN_ROLE
        else:
            work = role or NO_ROLE
        if assistant["platforms"]:
            work += f"，主要给{_cap(assistant['platforms'], ROLE_MAX_CHARS)}做"
        lines.append(f"- {assistant['name']}：{work}")
    return "\n".join(lines)


def _own_profile(profile_name: str = "") -> str:
    return profile_name.strip() or profile_key(assistant_name.profile_home())


def _remember(session_id: str, lines: str) -> None:
    if not session_id:
        return
    if len(_told) >= _MAX_TOLD and session_id not in _told:
        _told.clear()
    _told[session_id] = lines


def render_section(session_info: Mapping[str, Any] | None = None) -> str:
    """The roster and the offer rule for a Desktop chat session, else "" (the runtime then adds none)."""
    info = session_info or {}
    if not switch_on() or info.get("platform") != PLATFORM:
        return ""
    lines = _roster_lines(_own_profile(str(info.get("profile_name") or "")))
    _remember(str(info.get("session_id") or ""), lines)
    if not lines:
        return ""
    indented = "\n".join("  " + line for line in lines.split("\n"))
    return "\n".join((SECTION_HEAD, "- 用户在 APEX 里还有这几个助手，各有分工：", indented, OFFER_RULE, TURN_RULE))


# ── the return box ───────────────────────────────────────────────────────────


def returns_dir(profile: str) -> Path:
    from hermes_constants import get_default_hermes_root

    return get_default_hermes_root() / "apex" / "handoff" / "returns" / profile


def _quoted(text: str) -> str:
    return "\n".join(f"> {line}" if line.strip() else ">" for line in text.split("\n"))


def _return_entry(request: dict, reply: str) -> dict:
    home = assistant_name.profile_home()
    receiver = profile_key(home)
    visible, block = parse_return(reply)
    entry = {
        "v": 1,
        "id": request["id"],
        "from": request["from"],
        "by": receiver,
        "by_name": _display_name(receiver, _ui_meta(home)),
        "at": time.time(),
    }
    if block is not None:
        return {**entry, **block, "has_summary": True}
    head = _cap(_COMMENT_RE.sub("", visible).strip(), HEAD_MAX_CHARS)
    return {**entry, "summary": head, "files": [], "links": [], "has_summary": False}


def _returned_note(entry: dict) -> str:
    receiver = assistant_name.clean_name(entry.get("by_name")) or str(entry.get("by") or "另一个助手")
    summary = str(entry.get("summary") or "").strip()
    lines = [_quoted(summary)] if summary else []
    for key, label in (("files", "文件"), ("links", "链接")):
        items = entry.get(key) if isinstance(entry.get(key), list) else []
        lines.extend(f"{label}：{item}" for item in items[:MAX_ITEMS] if isinstance(item, str) and item.strip())
    if entry.get("has_summary") is True:
        head, tail = RETURNED, RETURNED_TAIL
    else:
        head, tail = RETURNED_BARE, RETURNED_BARE_TAIL
    return "\n".join((head.format(receiver=receiver), *lines, tail.format(receiver=receiver)))


def take_returns(profile: str) -> list[str]:
    """Notes for what came back to ``profile``; each entry is claimed by one engine, then deleted."""
    box = returns_dir(profile)
    try:
        waiting = sorted(
            (path for path in box.iterdir() if path.suffix == ".json" and not path.name.startswith(".")),
            key=lambda path: path.stat().st_mtime,
        )
    except OSError:
        return []
    notes = []
    for path in waiting:
        claimed = path.with_name(f".{path.stem}.{os.getpid()}.taken")
        try:
            os.replace(path, claimed)
        except OSError:
            continue  # another engine took it
        try:
            entry = json.loads(claimed.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            entry = None
        finally:
            claimed.unlink(missing_ok=True)
        if not isinstance(entry, dict):
            continue
        at = entry.get("at")
        if not isinstance(at, (int, float)) or time.time() - at > RETURN_MAX_AGE_SECONDS:
            continue
        notes.append(_returned_note(entry))
        if len(notes) == MAX_RETURNS_PER_TURN:
            break
    return notes


# ── hooks ────────────────────────────────────────────────────────────────────


def _roster_note(session_id: str, own: str) -> Optional[str]:
    lines = _roster_lines(own)
    told = _told.get(session_id)
    _remember(session_id, lines)
    if told == lines or (told is None and not lines):
        return None
    if not lines:
        return ROSTER_NONE
    return ROSTER_NOW.format(lines=lines)


def on_pre_llm_call(session_id: str = "", platform: str = "", user_message: Any = None, **_: Any) -> Optional[str]:
    """This turn's notes: the job being taken, what came back, a changed roster; None when there are none."""
    if not switch_on() or platform != PLATFORM:
        return None
    own = profile_key(assistant_name.profile_home())
    notes = []
    request = parse_request(user_message)
    if request is not None:
        notes.append(TAKING.format(sender=name_of(request["from"])))
    notes.extend(take_returns(own))
    if session_id:
        roster_note = _roster_note(session_id, own)
        if roster_note:
            notes.append(roster_note)
    return "\n\n".join(notes) or None


def on_post_llm_call(
    session_id: str = "", platform: str = "", user_message: Any = None, assistant_response: Any = None, **_: Any
) -> None:
    """At the end of a turn that took a job, put what it hands back into the sender's return box."""
    from utils import atomic_json_write

    if not switch_on() or platform != PLATFORM:
        return
    request = parse_request(user_message)
    if request is None or not isinstance(assistant_response, str) or not assistant_response.strip():
        return
    path = returns_dir(request["from"]) / f"{request['id']}.json"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json_write(path, _return_entry(request, assistant_response))
    except OSError:
        logger.warning("apex-overlay: could not hand job %s back to %s", request["id"], request["from"], exc_info=True)


def apply(ctx: Any) -> bool:
    """Register the section and both turn hooks on this plugin's context. Idempotent per plugin manager.

    Only while the switch is on: Desktop settles all three variables before the engine starts, so with
    any of them off nothing is added.
    """
    register_section = getattr(ctx, "register_system_prompt_section", None)
    register_hook = getattr(ctx, "register_hook", None)
    if register_section is None or register_hook is None:
        logger.warning("apex-overlay: this plugin host cannot register the relay seam")
        return False
    if not switch_on():
        return True
    hooks = getattr(getattr(ctx, "_manager", None), "_hooks", {})
    if on_pre_llm_call in hooks.get("pre_llm_call", ()):
        logger.warning("apex-overlay: relay seam already registered on this plugin manager")
        return False
    try:
        register_section(SECTION_ID, render_section, max_chars=MAX_CHARS)
    except ValueError as exc:
        logger.warning("apex-overlay: relay section not registered: %s", exc)
        return False
    register_hook("pre_llm_call", on_pre_llm_call)
    register_hook("post_llm_call", on_post_llm_call)
    return True
