"""hc-1116 上游话术不进产品: the open-source engine's own wording, said APEX's way on APEX surfaces.

hc-1083's acceptance found APEX speaking as the open-source engine: a new assistant's first reply told the
user to type /help, and the engine's notices named Hermes and ``hermes`` terminal commands that an APEX user
has no way to run. This seam covers the engine-side exits of that kind (Desktop's own renderer covers the
failed-turn row and the error card, apps/desktop/src/i18n/single-thread-upstream-copy.ts):

* the first-contact note (agent/onboarding.py, both variants): the model is asked to "mention that /help
  shows available commands" in its first reply on Desktop, in Desktop's IM gateway and in a cloud container;
  that clause is dropped, the rest of the note stays upstream's word for word;
* what the model is told about where it runs: the Desktop platform hint ("You are chatting inside the Hermes
  desktop app") and the mid-turn steering note ("Hermes delivers their message") name APEX instead;
* the engine's catalog lines an IM user or a Desktop user reads (``gateway.*``, ``explainer.*``,
  ``approval.timeout``, the ``/help`` descriptions): an APEX language pack for zh and en, registered on top
  of the bundled catalogs the way any plugin pack is (agent/i18n_layers.py), so upstream's catalogs are
  untouched. It drops the Hermes name, ``hermes`` commands, /help, /model and /login advice; where the
  upstream fix is a host command, it says what the user of that surface can do instead (Desktop: quit APEX
  and open it again; cloud: contact APEX). Keys left upstream's, and why, are listed in
  tests/apex_overlay/test_upstream_copy_seam.py (``LEFT_UPSTREAM``);
* the zh line that apex_overlay/cn_im_messages.py writes for the no-home-channel notice, and the APEX
  English it now has to recognise.

Surfaces are hc-1103's (apex_identity.surface): Desktop's single-thread mode (``APEX_SINGLE_THREAD_ACTIVE=1``,
inherited by its IM gateway) and a cloud container (``HERMES_MANAGED_RUNTIME=1``). Anywhere else nothing is
patched or registered and every exit reads byte for byte as upstream's (tests/apex_overlay/__identity__/hc1116).
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from apex_overlay import post_import
from apex_overlay.apex_identity import CLOUD, DESKTOP, surface

logger = logging.getLogger(__name__)

# ---- what the model is told --------------------------------------------------------------------------------

_ONBOARDING_MODULE = "agent.onboarding"
_PROMPT_MODULE = "agent.system_prompt"
_CN_IM_MODULE = "apex_overlay.cn_im_messages"
_MARK = "_apex_upstream_copy"

# The /help clause in each first-contact note; each must occur exactly once.
INTRO_HELP = " and mention that /help shows available commands"
OFFER_HELP = " (mention /help shows commands)"

# (upstream words, APEX words); each upstream phrase must occur exactly once.
DESKTOP_HINT = ("You are chatting inside the Hermes desktop app", "You are chatting inside the APEX desktop app")
STEER_SENDER = ("the user can steer you: Hermes delivers", "the user can steer you: APEX delivers")

# ---- what IM and Desktop users read --------------------------------------------------------------------------

PACK_SOURCE = "apex-overlay:hc-1116"

# What each surface's user can do where upstream names a host command. Desktop: the engine, its IM gateway
# and its database restart with the app. Cloud: the user has no restart or sign-in of their own (the web
# console has neither), so the way on is APEX.
SURFACE_WORDS = {
    DESKTOP: {
        "zh": {"<restart>": "请退出 APEX 再重新打开", "<relogin>": "请重新登录 APEX（用自己密钥的，检查一下密钥）",
               "<free_space>": "腾出一些磁盘空间后再发一次"},
        "en": {"<restart>": "quit APEX and open it again",
               "<relogin>": "sign in to APEX again (or check your own key, if you use one)",
               "<free_space>": "free some disk space, then send your message again"},
    },
    CLOUD: {
        "zh": {"<restart>": "请联系 APEX", "<relogin>": "请联系 APEX", "<free_space>": "请联系 APEX"},
        "en": {"<restart>": "contact APEX", "<relogin>": "contact APEX", "<free_space>": "please contact APEX"},
    },
}

MESSAGES: dict[str, dict[str, str]] = {
    "zh": {
        "approval.timeout": "      ⏱ {waited} 内没有回应，这条命令没有执行。还要做的话，再说一次。",
        "explainer.empty_response": "这次重试后还是没有回复。发「继续」再试一次。",
        "explainer.exit.all_retries_exhausted_no_response": "模型服务重试了几次都没有回应。发送 /retry 再试一次。",
        "explainer.persistence.corrupt": "保存对话的数据库损坏了，这一轮已停下，这条消息没有保存。重试解决不了，请联系 APEX。",
        "explainer.persistence.default": (
            "APEX 没能保存这段对话，为了不丢你的消息，这一轮先停下了。可能是存储空间不够，或者数据库正被占用。"
            "稍后再发一次；一直这样的话，<restart>。"
        ),
        "explainer.persistence.deleted_wal": (
            "另一个进程还占着对话数据库的旧日志，为了保护文件，这一轮停止了写入，这条消息没有保存（数据没有丢）。"
            "<restart>，然后再发一次。"
        ),
        "explainer.persistence.disk": (
            "APEX 没能把这段对话存下来，为了不丢你的消息，这一轮先停下了。存储空间可能满了：<free_space>。"
        ),
        "explainer.persistence.fts_index": (
            "对话的搜索索引坏了，这一轮已停下，这条消息没有保存。对话本身没有损坏。<restart>，然后再发一次。"
        ),
        "explainer.persistence.locked": "对话存储正忙（另一个进程在写），这一轮先停下了。你的消息应该已经存好，稍等一下再发一次。",
        "explainer.persistence.replaced": "运行中对话数据库文件被替换了，这条消息没有保存。<restart>，然后再发一次。",
        "explainer.persistence.session_row_missing": (
            "这段对话在打开期间被从存储里删掉了，也没能重新建起来，这条消息没有保存。请再发一次；一直这样的话，<restart>。"
        ),
        "explainer.persistence.turn_lease": "另一个进程接管了这段对话，这一轮停下了，回复没有保存。等它做完，再发一次。",
        "gateway.background.no_credentials": "❌ 后台任务没能开始：现在连不上模型服务。<relogin>，然后再试。",
        "gateway.bundles.none": "还没有技能包。",
        "gateway.bundles.none_plain": "还没有技能包。",
        "gateway.busy.behavior_interrupt_long": "APEX 忙的时候，新消息会打断正在做的事。",
        "gateway.busy.behavior_queue_long": "APEX 忙的时候，新消息会排到下一轮再处理。",
        "gateway.compress.hygiene_failed": "⚠️ 精简对话历史没有成功，已保持原样。发送 /compress 再试，或用 /new 开始新对话。",
        "gateway.compress.hygiene_timeout_doctor_hint": " 一直这样的话，<restart>。",
        "gateway.errors.auth_failed": "⚠️ 模型服务的登录失效了。<relogin>，然后再试。",
        "gateway.errors.bad_request": "⚠️ 模型服务拒绝了这条请求。换个说法再试试。",
        "gateway.errors.connection_interrupted": "⚠️ 和模型服务的连接中途断了，通常是暂时的。发送 /retry 再试。",
        "gateway.errors.connection_unknown": "⚠️ APEX 连不上模型服务。发送 /retry 再试；一直这样的话，<restart>。",
        "gateway.errors.generic_failed": "⚠️ 出了点问题，这条回复没能完成。发送 /retry 再试，或用 /new 开始新对话。",
        "gateway.errors.generic_failed_with_hint": "⚠️ 出了点问题，这条回复没能完成。{hint}\n发送 /retry 再试，或用 /new 开始新对话。",
        "gateway.errors.hint_auth": " 模型服务的登录已失效，<relogin>。",
        "gateway.errors.hint_quota": " 额度已经用完了。",
        "gateway.errors.no_credentials": "⚠️ 连不上模型服务，这条消息没有处理。<relogin>，然后再试。",
        "gateway.errors.provider_kept_failing": "⚠️ 模型服务一直出错。发送 /retry 再试。",
        "gateway.errors.unreachable": "⚠️ 现在连不上模型服务。稍等一下再发送 /retry；一直这样的话，<restart>。",
        "gateway.errors.usage_limit_resets": "⏱️ 模型服务的用量到上限了，{window} 后恢复。到时发送 /retry 再试。",
        "gateway.exec_approval.header": "APEX 想运行一条需要你确认的命令",
        "gateway.heartbeat.set": (
            "♥ 心跳已设置（每 {interval}）：{prompt}\n这个对话空闲、并且到了间隔时间，就会当作普通的一轮触发。"
            "只在这次运行期间有效；想长期定时，直接跟我说要在什么时候做什么。"
        ),
        "gateway.help.header": "📖 **APEX 命令**\n",
        "gateway.notify.no_home_channel": (
            "📬 {platform} 尚未设置主频道。主频道是 APEX 投递定时任务结果和跨平台消息的地方。\n\n"
            "输入 {sethome_cmd} 将此聊天设为主频道，或忽略以跳过。"
        ),
        "gateway.pause.already_paused": "⏸️ APEX 已经暂停了{suffix}。用 `/pause off` 恢复。",
        "gateway.pause.not_paused": "APEX 没有暂停。",
        "gateway.platform.paused": "✓ {name} 已暂停。用 `/platform resume {name}` 恢复。",
        "gateway.progress.task_card_title": "APEX 正在处理",
        "gateway.restart.restarting": "♻ 正在重启。60 秒内没收到上线消息的话，<restart>。",
        "gateway.shared.history_unreadable": "⚠️ 现在读不到这段对话的历史（之前的消息还在，只是加载不出来）。<restart>，或用 /new 开始新对话。",
        "gateway.shutdown.cron_interrupted": "⚠️ 定时任务「{job}」因 APEX {action}而被打断，这次没有结果。到点会再运行。",
        "gateway.shutdown.notice_restart": "⚠️ APEX 正在重启，手上的事会被打断。重启后随便发一条消息，我会接着做。",
        "gateway.shutdown.notice_shutdown": "⚠️ APEX 正在关闭，手上的事会被打断。重新上线后随便发一条消息，我会接着做。",
        "gateway.skills.disabled": "**{name}** 技能已安装，但没有开启。",
        "gateway.skills.disabled_for_platform": "**{name}** 技能在 {platform} 上没有开启。",
        "gateway.skills.not_installed": "**{name}** 技能还没有安装。",
        "gateway.skills.stacked_disabled": "这次一起调用的 **{names}** 技能在 {platform} 上没有开启。",
        "gateway.startup.db_corrupt": "⚠️ 对话数据库损坏了，消息可能存不下来。重试解决不了，请联系 APEX。",
        "gateway.startup.db_fts_corrupt": "⚠️ 对话的搜索索引坏了（消息本身没有坏），修好之前消息可能存不下来。<restart>。",
        "gateway.startup.db_then_restart": "{action} 然后<restart>。",
        "gateway.startup.handoff_thread_title": "APEX——{title}",
        "gateway.startup.online": "♻️ APEX 已重新上线。",
        "gateway.status.header": "📊 **APEX 状态**",
        "slash.busy.description": "设置 APEX 忙的时候新消息怎么处理",
        "slash.goal.description": "设一个长期目标，APEX 会跨多轮一直推进到完成",
        "slash.snapshot.description": "创建或恢复 APEX 配置和状态的快照",
        "slash.version.description": "显示 APEX 版本",
    },
    "en": {
        "approval.timeout": "      ⏱ No answer in {waited}, so the command was not run. Ask again if you still want it done.",
        "explainer.empty_response": "No reply came back this time, even after retries. Send `continue` to try again.",
        "explainer.exit.all_retries_exhausted_no_response": (
            "the model service didn't answer after all retries. Send /retry to try again."
        ),
        "explainer.persistence.corrupt": (
            "the conversation database is damaged, so this turn stopped and the message was not saved. Retrying "
            "will not fix it; please contact APEX."
        ),
        "explainer.persistence.default": (
            "APEX couldn't save this conversation, so it stopped rather than lose your messages. Storage may be "
            "full, or the database may be in use. Send your message again in a moment; if it keeps happening, "
            "<restart>."
        ),
        "explainer.persistence.deleted_wal": (
            "another process still holds an old copy of the conversation database's log, so writing stopped to "
            "keep the file safe and this message was not saved (nothing is lost). Please <restart>, then send your "
            "message again."
        ),
        "explainer.persistence.disk": (
            "APEX couldn't save this conversation, so it stopped rather than lose your messages. Storage is "
            "probably full: <free_space>."
        ),
        "explainer.persistence.fts_index": (
            "the conversation search index is damaged, so this turn stopped and the message was not saved. The "
            "conversations themselves are fine. Please <restart>, then send your message again."
        ),
        "explainer.persistence.locked": (
            "the conversation store was busy (another process was writing to it), so this turn stopped. Your "
            "message should already be saved — send it again in a moment."
        ),
        "explainer.persistence.replaced": (
            "the conversation database file was replaced while APEX was running, so this message was not saved. "
            "Please <restart>, then send your message again."
        ),
        "explainer.persistence.session_row_missing": (
            "this conversation was deleted from storage while it was open and could not be recreated, so this "
            "message was not saved. Send it again; if it keeps failing, <restart>."
        ),
        "explainer.persistence.turn_lease": (
            "another process took over this conversation, so this turn stopped and the reply was not saved. Wait "
            "for it to finish, then send your message again."
        ),
        "gateway.background.no_credentials": (
            "❌ The background task couldn't start: the model service can't be reached. Please <relogin>, then "
            "try again."
        ),
        "gateway.bundles.none": "No skill bundles yet.",
        "gateway.bundles.none_plain": "No skill bundles yet.",
        "gateway.busy.behavior_interrupt_long": "While APEX is busy, a new message interrupts what it is doing.",
        "gateway.busy.behavior_queue_long": "While APEX is busy, new messages wait for the next turn.",
        "gateway.compress.hygiene_failed": (
            "⚠️ Shortening the conversation history failed, so I kept everything as-is. Send /compress to try "
            "again, or /new to start fresh."
        ),
        "gateway.compress.hygiene_timeout_doctor_hint": " If this keeps happening, <restart>.",
        "gateway.errors.auth_failed": "⚠️ The sign-in to the model service is no longer valid. Please <relogin>, then try again.",
        "gateway.errors.bad_request": "⚠️ The model service rejected this request. Try rephrasing your message.",
        "gateway.errors.connection_interrupted": (
            "⚠️ The connection to the model service dropped mid-request — usually temporary. Send /retry to try again."
        ),
        "gateway.errors.connection_unknown": (
            "⚠️ APEX could not reach the model service. Send /retry to try again; if it keeps happening, <restart>."
        ),
        "gateway.errors.generic_failed": (
            "⚠️ Something went wrong and I couldn't finish this reply. Send /retry to try again, or /new to start a "
            "fresh conversation."
        ),
        "gateway.errors.generic_failed_with_hint": (
            "⚠️ Something went wrong and I couldn't finish this reply.{hint}\nSend /retry to try again, or /new to "
            "start a fresh conversation."
        ),
        "gateway.errors.hint_auth": " The sign-in to the model service has expired; please <relogin>.",
        "gateway.errors.hint_quota": " The usage quota has run out.",
        "gateway.errors.no_credentials": (
            "⚠️ I couldn't connect to the model service, so this message wasn't processed. Please <relogin>, then "
            "try again."
        ),
        "gateway.errors.provider_kept_failing": "⚠️ The model service kept failing. Send /retry to try again.",
        "gateway.errors.unreachable": (
            "⚠️ The model service isn't reachable right now. Wait a moment and send /retry; if it persists, <restart>."
        ),
        "gateway.errors.usage_limit_resets": (
            "⏱️ The model service's usage limit is reached; it resets in {window}. Send /retry after that."
        ),
        "gateway.exec_approval.header": "APEX wants to run a command that needs your OK",
        "gateway.heartbeat.set": (
            "♥ Heartbeat set (every {interval}): {prompt}\nFires as a normal turn whenever this chat is idle and "
            "the interval has passed. It lasts only while APEX keeps running — for a lasting schedule, just tell "
            "me what to do and when."
        ),
        "gateway.help.header": "📖 **APEX commands**\n",
        # Upstream's sentence with the name changed and nothing else, so cn_im_messages can still match it.
        "gateway.notify.no_home_channel": (
            "📬 No home channel is set for {platform}. A home channel is where APEX delivers cron job results and "
            "cross-platform messages.\n\nType {sethome_cmd} to make this chat your home channel, or ignore to skip."
        ),
        "gateway.pause.already_paused": "⏸️ APEX is already paused{suffix}. Use `/pause off` to resume.",
        "gateway.pause.not_paused": "APEX wasn't paused.",
        "gateway.platform.paused": "✓ {name} paused. Resume with `/platform resume {name}`.",
        "gateway.progress.task_card_title": "APEX is working",
        "gateway.restart.restarting": "♻ Restarting. If you don't hear back within 60 seconds, <restart>.",
        "gateway.shared.history_unreadable": (
            "⚠️ I can't read this conversation's history right now (your earlier messages still exist but can't "
            "be loaded). Please <restart>, or send /new to start fresh."
        ),
        "gateway.shutdown.cron_interrupted": (
            "⚠️ Scheduled job '{job}' was cut short because APEX is {action}; no result this run. It will run "
            "again on schedule."
        ),
        "gateway.shutdown.notice_restart": (
            "⚠️ APEX is restarting — your current task will be interrupted. Send any message after the restart "
            "and I'll try to pick up where we left off."
        ),
        "gateway.shutdown.notice_shutdown": (
            "⚠️ APEX is shutting down — your current task will be interrupted. When it is back, send any message "
            "and I'll try to pick up where we left off."
        ),
        "gateway.skills.disabled": "The **{name}** skill is installed but turned off.",
        "gateway.skills.disabled_for_platform": "The **{name}** skill is turned off for {platform}.",
        "gateway.skills.not_installed": "The **{name}** skill is not installed.",
        "gateway.skills.stacked_disabled": "The **{names}** skill(s) in this call are turned off for {platform}.",
        "gateway.startup.db_corrupt": (
            "⚠️ The conversation database is damaged, so messages may not be saved. Retrying will not fix it; "
            "please contact APEX."
        ),
        "gateway.startup.db_fts_corrupt": (
            "⚠️ The conversation search index is damaged (the messages themselves are fine); until it is "
            "repaired, messages may not be saved. Please <restart>."
        ),
        "gateway.startup.db_then_restart": "{action} Then <restart>.",
        "gateway.startup.handoff_thread_title": "APEX — {title}",
        "gateway.startup.online": "♻️ APEX is back online and ready.",
        "gateway.status.header": "📊 **APEX status**",
        "slash.busy.description": "Control how messages behave while APEX is working",
        "slash.goal.description": "Set a standing goal APEX works on across turns until it is done",
        "slash.snapshot.description": "Create or restore snapshots of APEX's config and state",
        "slash.version.description": "Show the APEX version",
    },
}

# cn_im_messages' no-home-channel row: the English middle of the notice, and the zh it becomes.
CN_IM_UPSTREAM_MIDDLE = ". A home channel is where Hermes delivers cron job results and cross-platform messages.\n\nType "
CN_IM_APEX_MIDDLE = CN_IM_UPSTREAM_MIDDLE.replace("Hermes", "APEX")
CN_IM_ZH_NAME = ("主频道用于接收 Hermes 的定", "主频道用于接收 APEX 的定")

_registered: dict[str, str] = {}  # language -> the surface its pack was built for


def messages_for(where: str, lang: str) -> dict[str, str]:
    """The pack for one surface and language, with that surface's words in place of the markers."""
    words = SURFACE_WORDS[where][lang]
    built = {}
    for key, text in MESSAGES[lang].items():
        for marker, replacement in words.items():
            text = text.replace(marker, replacement)
        built[key] = text
    return built


def _swap_once(text: Any, old: str, new: str, where: str) -> Optional[str]:
    """``text`` with ``old`` (which must occur exactly once) replaced; already-swapped text comes back as is."""
    if isinstance(text, str) and new and new in text and old not in text:
        return text
    if not isinstance(text, str) or text.count(old) != 1:
        logger.error("apex-overlay: %s no longer says %r once; it keeps upstream's words", where, old)
        return None
    return text.replace(old, new)


def _install_first_contact(module: Any) -> bool:
    directive: Optional[Callable[[], str]] = getattr(module, "profile_build_directive", None)
    if getattr(directive, _MARK, False):
        return True
    plain = _swap_once(getattr(module, "PLAIN_INTRO_NOTE", None), INTRO_HELP, "", f"{_ONBOARDING_MODULE}.PLAIN_INTRO_NOTE")
    offer = _swap_once(directive() if callable(directive) else None, OFFER_HELP, "",
                       f"{_ONBOARDING_MODULE}.profile_build_directive()")
    if plain is None or offer is None:
        return False

    def apex_profile_build_directive() -> str:
        return directive().replace(OFFER_HELP, "", 1)

    setattr(apex_profile_build_directive, _MARK, True)
    module.PLAIN_INTRO_NOTE = plain
    module.profile_build_directive = apex_profile_build_directive
    return True


def _install_steer_note(module: Any) -> bool:
    note = _swap_once(getattr(module, "STEER_CHANNEL_NOTE", None), *STEER_SENDER, f"{_PROMPT_MODULE}.STEER_CHANNEL_NOTE")
    if note is None:
        return False
    module.STEER_CHANNEL_NOTE = note
    return True


def _install_desktop_hint(module: Any) -> bool:
    hints = getattr(module, "PLATFORM_HINTS", None)
    hint = _swap_once(hints.get("desktop") if isinstance(hints, dict) else None, *DESKTOP_HINT,
                      f"{_PROMPT_MODULE}.PLATFORM_HINTS['desktop']")
    if hint is None:
        return False
    hints["desktop"] = hint  # the one dict agent.prompt_builder and agent.system_prompt share
    return True


def _install_cn_im(module: Any) -> bool:
    rows = getattr(module, "_HC228_ZH_LITERALS", None)
    if not isinstance(rows, list):
        logger.error("apex-overlay: %s has no _HC228_ZH_LITERALS; its no-home-channel zh keeps Hermes", _CN_IM_MODULE)
        return False
    matches = [i for i, row in enumerate(rows) if row[0] in (CN_IM_UPSTREAM_MIDDLE, CN_IM_APEX_MIDDLE)]
    if len(matches) == 2:
        return True
    zh = _swap_once(rows[matches[0]][1], *CN_IM_ZH_NAME, f"{_CN_IM_MODULE} no-home-channel row") if len(matches) == 1 else None
    if zh is None:
        logger.error("apex-overlay: %s no-home-channel row not found once; it keeps Hermes", _CN_IM_MODULE)
        return False
    index = matches[0]
    rows[index] = (CN_IM_UPSTREAM_MIDDLE, zh)
    rows.insert(index, (CN_IM_APEX_MIDDLE, zh))
    return True


def _register_packs(where: str) -> bool:
    from agent import i18n_layers

    for lang in MESSAGES:
        if lang in _registered:
            continue
        i18n_layers.register_pack(lang, i18n_layers.CORE_SURFACE, messages_for(where, lang), source=PACK_SOURCE)
        _registered[lang] = where
    return True


def apply() -> bool:
    """Patch the first-contact notes and the steering note, register the APEX pack, only on an APEX surface.

    Both switches are settled before the engine starts, so off an APEX surface nothing is patched.
    """
    where = surface()
    if where is None:
        return True
    try:
        ok = _register_packs(where)
    except Exception:
        logger.error("apex-overlay: the hc-1116 language pack did not register", exc_info=True)
        ok = False
    # Never imported here: plugin discovery may run while these modules are still importing.
    ok = post_import.when_imported(_ONBOARDING_MODULE, _install_first_contact) and ok
    ok = post_import.when_imported(_PROMPT_MODULE, _install_steer_note) and ok
    ok = post_import.when_imported(_CN_IM_MODULE, _install_cn_im) and ok
    if where == DESKTOP:
        ok = post_import.when_imported(_PROMPT_MODULE, _install_desktop_hint) and ok
    return ok
