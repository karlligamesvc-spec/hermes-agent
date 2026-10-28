"""hc-1095 版本照实说: what APEX Desktop says when asked its version, whether it is the newest, how to update.

A user asked APEX which version it was. Nothing in its prompt said, so it went looking: it ran the
engine's own CLI (which prints the open-source engine's name, a build date and "unknown"), compared that
with the open-source project's public releases, said it "runs on Hermes Agent" and offered to upgrade
the "kernel". The truth was APEX 0.17.63, with 0.17.66 downloaded and waiting for 「安装并重启」.

Desktop's main process owns that truth and mirrors it into ``<root>/apex/desktop-version.json``
(apps/desktop/electron/apex-version-state.ts): the app version, the engine this app ships
(bundled-runtime.json) and the shell updater's state as one status code. This seam words it:

* ``apex.desktop-version``, a prompt section with the state at the session's start, how to update
  (左下角「安装并重启」, or 设置 › 个性化 「立即检查」) and what not to do: look versions up, compare
  with other projects, say it runs on something else, offer to upgrade an engine or the system;
* a ``pre_llm_call`` note, once, when the state a session was last given has changed (a download
  finished, an install was put off, or the app was updated under a restored session). What each session
  was last given sits next to the state file, so a restart alone does not repeat it;
* the engine's own every-session line "You run on Hermes Agent (by Nous Research) ... the documentation
  ... always holds the latest" (agent/prompt_builder.py ``HERMES_AGENT_HELP_GUIDANCE`` and its no-skills
  twin), the source of "跑在 Hermes Agent 上" and of looking up the public releases, becomes an APEX line.
  It sits in the stable tier, so a session restored from before keeps its stored prompt (the engine
  sends stored bytes untouched when the rebuilt prefix differs); the note still reaches it once.

Same switch as hc-1015 (``APEX_SINGLE_THREAD_ACTIVE=1``, set by Desktop's main process at launch and
inherited by the Desktop-hosted IM gateway): without it (single-thread mode off, every cloud container)
nothing is registered or patched, and every prompt is byte for byte what it was. Subagents, cron runs,
webhooks and api_server sessions get no section and no note: nobody there asks about versions. The
replaced engine line is process-wide, so they carry the APEX line instead of the upstream one.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Mapping, Optional

from apex_overlay import post_import
from apex_overlay.single_thread_prompt import switch_on

logger = logging.getLogger(__name__)

SECTION_ID = "apex.desktop-version"
MAX_CHARS = 1_500
STATE_RELATIVE_PATH = ("apex", "desktop-version.json")
TOLD_RELATIVE_PATH = ("apex", "desktop-version-told.json")
# Same set as apexnodes-next-steps' NON_INTERACTIVE_PLATFORMS.
NON_INTERACTIVE_PLATFORMS = frozenset({"api_server", "cron", "webhook", "subagent"})
_MAX_TOLD = 512

HOW_TO_UPDATE = "在电脑上的 APEX 里点左下角的「安装并重启」；没看到这个按钮，就到 设置 › 个性化 点「立即检查」"
CHECK_IN_SETTINGS = "可以到 设置 › 个性化 点「立即检查」"

# Word for word the zh notes Desktop shows under the update pill (apps/desktop/src/i18n/desktop-update.ts).
DEFERRED_REASONS = {
    "active_work": "有任务在进行，做完后自动安装更新。",
    "activity_unknown": "正在确认 APEX 是否空闲，确认后自动安装更新。",
    "engine_holders": "有别的程序在用 APEX 引擎，它退出后自动安装更新。",
    "gateway_busy": "消息渠道还在回复消息，回复完自动安装更新。",
    "previous_worker": "上次的 APEX 引擎进程还在退出，退出后自动安装更新。",
}

# One sentence per status code electron/apex-version-state.ts writes; {version} is the new version.
UPDATE_SENTENCES = {
    "latest": "已经是最新版本。",
    "unchecked": f"这次打开 APEX 后还没检查完更新（打开一分钟左右会自动检查）；想马上知道，{CHECK_IN_SETTINGS}。",
    "downloading": "有新版 {version}，正在后台下载；下载好后左下角会出现「安装并重启」。",
    "downloaded": "新版 {version} 已经下载好了，还没装：点左下角的「安装并重启」就能装上。",
    "deferred": "新版 {version} 已经下载好，也点过「安装并重启」了，正在等：{reason}",
    "error": f"上次检查或下载更新没成功（多半是网络问题），APEX 会自己再试；也{CHECK_IN_SETTINGS}。",
    "unavailable": "这个 APEX 不会自己更新，要更新得下载新的安装包重新安装。",
}
# A code this engine does not know, or one that needs a version the file lacks.
UPDATE_UNKNOWN = f"更新情况这边看不到；{CHECK_IN_SETTINGS}。"

SECTION_RULES = (
    "用户问你是什么版本、是不是最新、怎么更新时，就照上面两行回答：报 APEX 的版本号和更新情况；"
    f"要更新，告诉他{HOW_TO_UPDATE}。",
    "不要用终端命令、网页搜索或 GitHub 去查版本，也不要拿任何别的软件或开源项目的版本号来比：那些都不是 APEX 的版本。",
    "你就是 APEX，不说自己“跑在”别的产品或框架上；不提出帮用户升级引擎、内核，也不去改系统设置或安装目录里的文件。",
    "对话中途更新情况有变，会另外告诉你最新的，以最新那条为准。",
)

NOTE = "（APEX 版本信息有变化，以这条为准：{version_line}；更新：{update}被问版本、是不是最新、怎么更新时照这条说，不去查别的。）"

# Replaces the engine's "You run on Hermes Agent (by Nous Research) ..." line in every session's stable tier.
APEX_HELP_GUIDANCE = (
    "You are part of APEX, a product of ApexNodes HK. When the user asks how to use or set up APEX, which "
    "version it is, whether it is up to date or how to update it, answer from the APEX platform information "
    "in this prompt. Do not say you run on another product or framework, and do not look up other projects' "
    "documentation, releases or version numbers to answer."
)
_HELP_MODULE = "agent.system_prompt"
_HELP_ATTRS = ("HERMES_AGENT_HELP_GUIDANCE", "HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS")

_APP_VERSION = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
# The calver core of an engine pin, without its internal "-fork.<sha>" key (as Desktop's engine-display.ts shows it).
_ENGINE_CALVER = re.compile(r"^v?(\d{4}\.\d{1,2}\.\d{1,2})(?:-fork\.\S+)?$")


def _root_file(relative: tuple[str, ...]) -> Path:
    from hermes_constants import get_default_hermes_root

    return get_default_hermes_root().joinpath(*relative)


def state_path() -> Path:
    """Where Desktop mirrors the facts: the root shared by every local profile and the IM gateway."""
    return _root_file(STATE_RELATIVE_PATH)


def read_state() -> Optional[dict]:
    """The mirrored facts, or None when there is no usable file (a cloud container never has one)."""
    path = state_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        logger.warning("apex-overlay: could not read the Desktop version state at %s: %s", path, exc)
        return None
    if not isinstance(raw, dict) or raw.get("schema") != 1 or not _APP_VERSION.match(str(raw.get("app_version"))):
        return None
    return raw


def version_line(state: Mapping[str, Any]) -> str:
    engine = state.get("engine")
    pinned = engine.get("version") if isinstance(engine, Mapping) else None
    match = _ENGINE_CALVER.match(pinned.strip()) if isinstance(pinned, str) else None
    shipped = f"（自带的 AI 引擎 {match.group(1)}，跟着 APEX 一起更新）" if match else ""
    return f"APEX {state['app_version']}{shipped}"


def update_sentence(state: Mapping[str, Any]) -> str:
    update = state.get("update")
    update = update if isinstance(update, Mapping) else {}
    template = UPDATE_SENTENCES.get(str(update.get("status")))
    version = update.get("version")
    if template is None or ("{version}" in template and not (isinstance(version, str) and _APP_VERSION.match(version))):
        return UPDATE_UNKNOWN
    reason = DEFERRED_REASONS.get(str(update.get("reason")), DEFERRED_REASONS["active_work"])
    return template.format(version=version, reason=reason)


def section_text(state: Mapping[str, Any]) -> str:
    lines = (f"版本：{version_line(state)}", f"更新：{update_sentence(state)}", *SECTION_RULES)
    return "【APEX 版本和更新 · 平台信息】\n" + "\n".join(f"- {line}" for line in lines)


def note_text(state: Mapping[str, Any]) -> str:
    return NOTE.format(version_line=version_line(state), update=update_sentence(state))


def _digest(state: Mapping[str, Any]) -> str:
    """What a session was given: the two state lines, not the rules around them."""
    given = f"{version_line(state)}\n{update_sentence(state)}"
    return hashlib.sha256(given.encode("utf-8")).hexdigest()[:16]


def _read_told() -> dict[str, str]:
    try:
        told = json.loads(_root_file(TOLD_RELATIVE_PATH).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return {}
    return {str(k): str(v) for k, v in told.items()} if isinstance(told, dict) else {}


def _remember(session_id: str, digest: str) -> None:
    """Record what this session now knows. Several engines share the file; a lost race costs one extra note."""
    told = _read_told()
    if told.get(session_id) == digest:
        return
    told.pop(session_id, None)
    told[session_id] = digest
    while len(told) > _MAX_TOLD:
        told.pop(next(iter(told)))
    path = _root_file(TOLD_RELATIVE_PATH)
    temp = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".desktop-version-told.", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(told, handle)
        os.replace(temp, path)
    except OSError as exc:
        logger.warning("apex-overlay: could not record the version state given to session %s: %s", session_id, exc)
        if temp is not None:
            Path(temp).unlink(missing_ok=True)


def render_section(session_info: Mapping[str, Any] | None = None) -> str:
    """The section for a new interactive session while single-thread mode is on and Desktop wrote the facts."""
    info = session_info or {}
    if not switch_on() or info.get("platform") in NON_INTERACTIVE_PLATFORMS:
        return ""
    state = read_state()
    if state is None:
        return ""
    session_id = str(info.get("session_id") or "")
    if session_id:
        _remember(session_id, _digest(state))
    return section_text(state)


def on_pre_llm_call(session_id: str = "", platform: str = "", **_: Any) -> Optional[str]:
    """One note when the facts differ from what this session was last given, else None."""
    if not switch_on() or not session_id or platform in NON_INTERACTIVE_PLATFORMS:
        return None
    state = read_state()
    if state is None:
        return None
    digest = _digest(state)
    if _read_told().get(session_id) == digest:
        return None
    _remember(session_id, digest)
    return note_text(state)


def _install_help_guidance(module: Any) -> bool:
    missing = [name for name in _HELP_ATTRS if not isinstance(getattr(module, name, None), str)]
    if missing:
        logger.error("apex-overlay: %s has no %s; the engine's own help line stays", _HELP_MODULE, ", ".join(missing))
        return False
    for name in _HELP_ATTRS:
        setattr(module, name, APEX_HELP_GUIDANCE)
    return True


def apply(ctx: Any) -> bool:
    """Register the section and the turn hook, and replace the engine's help line. Only while the switch is on.

    Desktop settles the switch before the engine starts, so with it off nothing is added or patched.
    """
    register = getattr(ctx, "register_system_prompt_section", None)
    register_hook = getattr(ctx, "register_hook", None)
    if register is None or register_hook is None:
        logger.warning("apex-overlay: this plugin host cannot register the Desktop version seam")
        return False
    if not switch_on():
        return True
    hooks = getattr(getattr(ctx, "_manager", None), "_hooks", {})
    if on_pre_llm_call in hooks.get("pre_llm_call", ()):
        logger.warning("apex-overlay: Desktop version seam already registered on this plugin manager")
        return False
    try:
        register(SECTION_ID, render_section, max_chars=MAX_CHARS)
    except ValueError as exc:
        logger.warning("apex-overlay: Desktop version prompt section not registered: %s", exc)
        return False
    register_hook("pre_llm_call", on_pre_llm_call)
    # Never imported here: plugin discovery may run while agent.system_prompt is still importing.
    return post_import.when_imported(_HELP_MODULE, _install_help_guidance)
