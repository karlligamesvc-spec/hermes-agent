"""hc-1082 多助手 · 名字: each assistant answers to its own name, and a sentence renames it.

With several assistants on APEX Desktop (hc-1074), one assistant is one Hermes profile. Its name and
look live in that profile's ``profile.yaml`` under ``ui_meta.apex`` (``name`` / ``shape`` / ``color``):
Desktop writes them through ``profiles.configure`` and draws them in the sidebar and the header. This
seam makes the engine say what the screen shows:

* the single-thread section (hc-1015 ``apex.single-thread``) names the assistant from that key, or
  APEX when none is stored (``name_rules``);
* the ``apex_rename`` tool stores a new name in the same key, with the same per-key revision bump, so
  「以后叫你小李」 renames this assistant on screen too. A name used to be put into memory, and the
  memory ledger is one per person, shared by every assistant: a name written there renames them all.
  The name's second home, the first line of a new assistant's SOUL.md (hc-1078,
  ``apps/desktop/shared/apex-bot-soul.ts``), follows it while that line keeps Desktop's shape;
* a session whose name changed after its prompt was frozen (renamed from the sidebar while the day's
  one long thread is open) hears the new name once, on its next turn (``on_pre_llm_call``).

Desktop's main process settles the multi-bot switch into ``APEX_MULTI_BOT_ACTIVE=1`` before the
engine spawns; it counts only next to single-thread mode's ``APEX_SINGLE_THREAD_ACTIVE=1``. Without
both (the switch off, or a cloud container, which sets neither) the seam registers nothing, and the
section and the apex_memory description are byte for byte what they were.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from pathlib import Path
from typing import Any, Mapping, Optional

from apex_overlay.single_thread_prompt import switch_on as single_thread_on

logger = logging.getLogger(__name__)

SWITCH_ENV = "APEX_MULTI_BOT_ACTIVE"
DEFAULT_NAME = "APEX"
# The profile.yaml ui_meta key Desktop reads and writes: {name, shape, color}.
META_KEY = "apex"
# Desktop's name field takes 12 characters.
MAX_NAME_CHARS = 12
# A stored name longer than this (a hand edit) is not put into the prompt.
MAX_STORED_CHARS = 64

TOOL_NAME = "apex_rename"
# Rides with the built-in memory toolset like apex_memory: a rename used to be remembered there.
TOOLSET = "memory"
# Same set as apexnodes-next-steps' NON_INTERACTIVE_PLATFORMS: nobody there renames anything on screen.
NON_INTERACTIVE_PLATFORMS = frozenset({"api_server", "cron", "webhook", "subagent"})

SCHEMA = {
    "name": TOOL_NAME,
    "description": (
        "改你自己（这个助手）的名字。用户说「以后叫你小李」「你改叫小剪吧」时用："
        "新名字存进这个助手的资料，侧栏和对话里显示的名字跟着改。"
        "只改你自己的名字；用户想让你怎么称呼他，不用这个工具。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": f"新名字，不超过 {MAX_NAME_CHARS} 个字"},
        },
        "required": ["name"],
    },
}

SWITCH_OFF = "现在没有打开多个助手，名字改不了。"
NO_NAME = "没有新名字：name 填用户起的名字。"
TOO_LONG = f"名字太长了：不超过 {MAX_NAME_CHARS} 个字。"
NOT_SAVED = "名字没存上（这个助手的资料文件写不进去），告诉用户这次没改成。"

# The first line Desktop writes into a new assistant's SOUL.md. Pinned, with how a rename rewrites it, in
# apps/desktop/shared/apex-bot-soul-cases.json, which this seam's tests and Desktop's both read.
SOUL_NAME_LINE = "You are {name}, an AI assistant from ApexNodes HK, working alongside APEX for the same person."
_LINE_HEAD, _LINE_TAIL = SOUL_NAME_LINE.split("{name}")

NAME_CHANGED = "（你的名字刚改成了「{name}」：从这句起就用这个名字，被问名字时报它。）"
NAME_NOW = "（你现在的名字是「{name}」。）"

_QUOTES = " \"'「」『』“”‘’"
_LOCK = threading.Lock()
# The name each session was last given (its frozen prompt, a rename, or a note), by session id;
# "" means none was stored, so the session was told APEX.
_told: dict[str, str] = {}
_MAX_TOLD = 512


def switch_on() -> bool:
    """Several assistants are on for this engine: Desktop set both launch variables."""
    return os.environ.get(SWITCH_ENV, "").strip() == "1" and single_thread_on()


def clean_name(raw: Any) -> str:
    """A name as stored and shown: one line, without outer spaces or quote marks."""
    return " ".join(str(raw or "").split()).strip(_QUOTES)


def profile_home(profile_name: str = "") -> Path:
    """This assistant's profile home: the profile a session names, else the bound Hermes home.

    Desktop starts every other assistant's engine with ``--profile <name>``, so there the bound home
    is that assistant's own, on any thread.
    """
    if profile_name:
        from hermes_cli.profiles import get_profile_dir

        return Path(get_profile_dir(profile_name))
    from hermes_constants import get_hermes_home

    return get_hermes_home()


def is_main(home: Path) -> bool:
    """The default profile is the user's main assistant, APEX."""
    from hermes_constants import get_default_hermes_root

    try:
        return home.resolve() == get_default_hermes_root().resolve()
    except OSError:
        return False


def _read_document(path: Path) -> dict:
    """profile.yaml as a mapping, {} when missing or empty; anything else raises, so it is never replaced."""
    import hermes_yaml as yaml

    if not path.is_file():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a mapping")
    return data


def stored_name(home: Path) -> str:
    """``ui_meta.apex.name`` from this assistant's profile.yaml, or "" when there is none to use."""
    try:
        data = _read_document(home / "profile.yaml")
    except Exception:
        logger.warning("apex-overlay: could not read the assistant name in %s", home / "profile.yaml", exc_info=True)
        return ""
    ui_meta = data.get("ui_meta")
    entry = ui_meta.get(META_KEY) if isinstance(ui_meta, dict) else None
    name = clean_name(entry.get("name")) if isinstance(entry, dict) else ""
    return name if len(name) <= MAX_STORED_CHARS else ""


def _ui_meta_lock():
    """The lock ``profiles.configure`` merges ui_meta under when this engine serves it, else this module's.

    Holding it keeps a rename and a Desktop save handled by the same engine from interleaving. A save
    handled by another engine process is caught by its per-key revision check: this write bumps
    ``_ui_meta_revisions.apex`` just as that merge does.
    """
    server = sys.modules.get("tui_gateway.server")
    return getattr(server, "_profile_ui_meta_lock", None) or _LOCK


def write_name(home: Path, name: str) -> str:
    """Store ``name`` as ``ui_meta.apex.name``; returns the name it replaced ("" when none was stored).

    The document edit of ``profiles.configure``'s ui_meta merge (tui_gateway/methods_profiles.py
    ``_configure_ui_meta``): read profile.yaml raw, keep every other key and the rest of
    ``ui_meta.apex`` (shape, color), bump the ``apex`` revision, write atomically.
    """
    from utils import atomic_yaml_write

    if not home.is_dir():
        raise FileNotFoundError(f"profile home does not exist: {home}")
    path = home / "profile.yaml"
    with _ui_meta_lock():
        document = _read_document(path)
        ui_meta = document.get("ui_meta")
        ui_meta = ui_meta if isinstance(ui_meta, dict) else {}
        entry = ui_meta.get(META_KEY)
        entry = dict(entry) if isinstance(entry, dict) else {}
        previous = clean_name(entry.get("name"))
        if entry.get("name") == name:
            return previous
        entry["name"] = name
        ui_meta[META_KEY] = entry
        document["ui_meta"] = ui_meta
        revisions = document.get("_ui_meta_revisions")
        revisions = dict(revisions) if isinstance(revisions, dict) else {}
        current = revisions.get(META_KEY)
        valid = isinstance(current, int) and not isinstance(current, bool) and current >= 0
        revisions[META_KEY] = (current if valid else 0) + 1
        document["_ui_meta_revisions"] = revisions
        atomic_yaml_write(path, document, sort_keys=False)
    return previous


def _unified(soul: str) -> str:
    return soul.replace("\r\n", "\n").replace("\r", "\n")


def soul_name(soul: str) -> Optional[str]:
    """The name on a SOUL's first line, or None when that line is not Desktop's template line."""
    first = _unified(soul).split("\n", 1)[0]
    if not (first.startswith(_LINE_HEAD) and first.endswith(_LINE_TAIL)):
        return None
    name = first[len(_LINE_HEAD) : len(first) - len(_LINE_TAIL)]
    return name if name.strip() else None


def rename_in_soul(soul: str, name: str) -> Optional[str]:
    """The SOUL (line endings unified to \\n) calling the assistant ``name``; None for a hand-written first line."""
    if soul_name(soul) is None:
        return None
    unified = _unified(soul)
    newline = unified.find("\n")
    return _LINE_HEAD + name + _LINE_TAIL + ("" if newline == -1 else unified[newline:])


def sync_soul(home: Path, name: str) -> bool:
    """Re-render SOUL.md's first line from the stored name while it keeps Desktop's shape; True when rewritten.

    The same rule as Desktop's writer: only a line of that shape naming someone else is rewritten, and
    APEX's own SOUL (the default profile's identity) never is; APEX's name lives in ui_meta alone.
    """
    from utils import atomic_write_bytes

    path = home / "SOUL.md"
    if is_main(home) or not path.is_file():
        return False
    soul = path.read_bytes().decode("utf-8")
    current = soul_name(soul)
    if current is None or current == name:
        return False
    atomic_write_bytes(path, rename_in_soul(soul, name).encode("utf-8"))
    return True


def _remember(session_id: str, name: str) -> None:
    if not session_id:
        return
    if len(_told) >= _MAX_TOLD and session_id not in _told:
        _told.clear()
    _told[session_id] = name


def name_rules(session_info: Mapping[str, Any] | None = None) -> str:
    """The single-thread section's lines about this assistant's name, or "" while multi-bot is off."""
    if not switch_on():
        return ""
    info = session_info or {}
    home = profile_home(str(info.get("profile_name") or ""))
    stored = stored_name(home)
    _remember(str(info.get("session_id") or ""), stored)
    main = is_main(home)
    latest = "这次对话里又改了名，以最后一次改的为准。"
    if stored:
        who = "用户在 APEX 里的主助手" if main else "用户在 APEX 里的一个助手，不是主助手 APEX"
        name = f"- 你叫{stored}，是{who}。身份设定或记忆底账里写的旧名字都不算，以这一条为准；{latest}"
    elif main:
        name = (
            "- 你叫 APEX，是用户在 APEX 里的主助手；记忆底账里要是记着用户以前给你起的名字"
            f"（比如「以后叫你小李」），就用最新的那个。{latest}"
        )
    else:
        name = f"- 你叫 APEX。{latest}"
    rename = (
        f"- 用户要给你改名字（比如「以后叫你小李」），用 {TOOL_NAME} 存好新名字（name 填新名字，"
        f"不超过 {MAX_NAME_CHARS} 个字），侧栏和对话里显示的名字会跟着改；改好后就用新名字，被问名字时报最新的那个。"
    )
    own = "你的名字和分工只属于你，不记进底账；用户想让你怎么称呼他，照常记。"
    if main:
        shared = f"- 用户要是有好几个助手，大家共用一份记忆底账。{own}"
    else:
        shared = (
            "- 用户的几个助手共用一份记忆底账：里面关于用户的事对你一样有用；但底账里以前记的称呼"
            f"（比如「以后叫你小李」）是用户对主助手 APEX 说的，不是你的名字。{own}"
            "平台规则里说的「APEX」指这个平台，这些规则对你一样适用。"
        )
    return "\n".join((name, rename, shared))


def on_pre_llm_call(session_id: str = "", platform: str = "", **_: Any) -> Optional[str]:
    """One line for a session whose stored name is not the one it was last given, else None."""
    if not switch_on() or not session_id or platform in NON_INTERACTIVE_PLATFORMS:
        return None
    stored = stored_name(profile_home())
    told = _told.get(session_id)
    _remember(session_id, stored)
    if told is None:
        # Restored after a restart: its frozen prompt was built by an earlier engine, so say the name once.
        return NAME_NOW.format(name=stored) if stored else None
    if told == stored:
        return None
    return NAME_CHANGED.format(name=stored or DEFAULT_NAME)


def handle(args: Mapping[str, Any] | None, session_id: str = "", **_kwargs: Any) -> str:
    """→ {ok, name, previous}. Renames only this assistant: the profile its engine serves."""
    from tools.registry import tool_error, tool_result

    if not switch_on():
        return tool_error(SWITCH_OFF)
    args = args if isinstance(args, Mapping) else {}
    name = clean_name(args.get("name"))
    if not name:
        return tool_error(NO_NAME)
    if len(name) > MAX_NAME_CHARS:
        return tool_error(TOO_LONG)
    home = profile_home()
    try:
        previous = write_name(home, name)
    except Exception:
        logger.warning("apex-overlay: could not store the assistant name in %s", home / "profile.yaml", exc_info=True)
        return tool_error(NOT_SAVED)
    try:
        sync_soul(home, name)
    except Exception:
        # The stored name is the authority; Desktop's next save of this assistant re-renders the line.
        logger.warning("apex-overlay: could not carry the new name into %s", home / "SOUL.md", exc_info=True)
    _remember(session_id, name)
    return tool_result(ok=True, name=name, previous=previous or DEFAULT_NAME)


def apply(ctx: Any) -> bool:
    """Register the tool and the turn hook on this plugin's context. Idempotent per plugin manager.

    Only while the switch is on: Desktop settles both variables before the engine starts, so with it
    off nothing is added, not even a hidden entry in the memory toolset's listing.
    """
    register_tool = getattr(ctx, "register_tool", None)
    register_hook = getattr(ctx, "register_hook", None)
    if register_tool is None or register_hook is None:
        logger.warning("apex-overlay: this plugin host cannot register the assistant name seam")
        return False
    if not switch_on():
        return True
    hooks = getattr(getattr(ctx, "_manager", None), "_hooks", {})
    if on_pre_llm_call in hooks.get("pre_llm_call", ()):
        logger.warning("apex-overlay: assistant name seam already registered on this plugin manager")
        return False
    from tools.registry import no_cache_check_fn

    register_tool(
        name=TOOL_NAME,
        toolset=TOOLSET,
        schema=SCHEMA,
        handler=handle,
        check_fn=no_cache_check_fn(switch_on),
        description=SCHEMA["description"],
        emoji="🏷️",
    )
    register_hook("pre_llm_call", on_pre_llm_call)
    return True
