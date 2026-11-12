"""apex-overlay plugin — boot hook that applies ApexNodes seams onto upstream.

This bundled plugin is the *load-time entry point* for the ``apex_overlay``
package. Its only job is to call each overlay seam's ``apply()`` during plugin
discovery, which the CLI runs early in startup (``cli.py`` deferred-startup,
before the ``/model`` picker cache prewarm) and the gateway runs at boot
(``gateway/run.py``). That ordering is what lets the hc-392 provider denylist
take effect *before* the picker's background prewarm would otherwise fetch a
disabled provider's catalog.

Why a plugin (and not an in-place import in model_switch.py)?
------------------------------------------------------------
The whole point of ``apex_overlay/`` is to keep our behavioral debt OUT of hot
upstream files so they merge cleanly on the next bump. A bundled plugin +
``apply()`` keeps the upstream files byte-for-byte upstream; the only non-code
touch is one line in ``cli-config.yaml.example`` adding ``apex-overlay`` to
``plugins.enabled`` — the cleanest seam tier (config > plugin > in-place).

See ``apex_overlay/README.md`` for the full pattern.
"""

from __future__ import annotations

import importlib
import logging

logger = logging.getLogger(__name__)

# The China IM seams, applied in this order: each seam module with the warning logged when its
# apply() reports a missing upstream target.
_CN_IM_SEAMS = (
    (
        "first_turn_ack",
        "apex-overlay: hc-401 first_turn_ack seam did not fully apply "
        "(see prior error). Native no-edit CN-IM entries "
        "(wecom/weixin/dingtalk/qqbot) will sit in ~14.6s of first-turn "
        "silence with no 'received, working' ack.",
    ),
    (
        "cn_im_messages",
        "apex-overlay: hc-401 CN-IM message localization seam did not "
        "fully apply (see prior error). Gateway control/status messages "
        "(busy-ack, gateway-busy, no-home-channel, mid-run rejections) "
        "may leak English to wecom/weixin/dingtalk/qqbot users.",
    ),
    (
        "cn_im_banners",
        "apex-overlay: hc-976 CN-IM runtime banner filter seam did not "
        "apply (see prior error). The session-reset notice and the ◆ "
        "model/provider/context lines will reach weixin/wecom/dingtalk/"
        "qqbot/feishu users.",
    ),
    (
        "im_question_reply_only",
        "apex-overlay: hc-1018 cloud IM question-and-reply-only seam did not "
        "apply (see prior error). With apex.im_question_reply_only on, "
        "status lines and the runtime's English failure replies (provider, "
        "model, /model) still reach weixin/wecom/dingtalk/qqbot/feishu users.",
    ),
)


# Tool seams, applied last in this order (register() is at its complexity cap, so new plain seams go here).
_TOOL_SEAMS = (
    (
        "vision_answer",
        "apex-overlay: hc-1065 vision answer seam did not fully apply "
        "(see prior error). vision_analyze asks the auxiliary model to "
        "describe everything again, and may return its private reasoning "
        "or a cut-off answer as if it were complete.",
    ),
    (
        "apex_identity",
        "apex-overlay: hc-1103 APEX identity seam did not fully apply (see "
        "prior error). Subagents may call themselves Hermes Agent by Nous "
        "Research, a cloud assistant may say it runs on Hermes Agent, and "
        "/version in IM may print the engine's banner instead of APEX's version.",
    ),
    (
        "upstream_copy",
        "apex-overlay: hc-1116 upstream wording seam did not fully apply (see "
        "prior error). A new assistant's first reply may point to /help, and IM "
        "notices may name Hermes or tell the user to run hermes commands.",
    ),
    (
        "hosted_profiles",
        "apex-overlay: hc-1166 hosted assistants seam did not fully apply (see "
        "prior error). With one engine hosting every assistant, assistants other "
        "than APEX may lose the platform tools and Feishu, and their sessions are "
        "not auto-archived or curated.",
    ),
    (
        "cron_account_env",
        "apex-overlay: hc-1169 cron account credentials seam did not fully apply (see "
        "prior error). With several assistants, every cron job runs without the "
        "account's web search, platform tools and Feishu / WeChat credentials; web "
        "search falls back to a keyless backend without saying so.",
    ),
    (
        "im_launch_profile",
        "apex-overlay: hc-1171 IM launch-profile seam did not fully apply (see prior "
        "error). With several assistants, the messaging gateway configures neither "
        "Feishu nor WeChat and the bound bot never connects.",
    ),
    (
        "lark_log_redaction",
        "apex-overlay: hc-1174 Feishu log redaction seam did not apply (see prior "
        "error). The Feishu SDK's websocket address, credentials included "
        "(access_key, ticket), is written to the logs as is.",
    ),
    (
        "cron_update_notice",
        "apex-overlay: hc-1183 cron update notice seam did not apply (see prior error). "
        "Changing where a scheduled job delivers no longer says when its result will "
        "reach no chat, so a Desktop chat may promise the result comes back.",
    ),
    (
        "cron_desktop_delivery",
        "apex-overlay: hc-1186 Desktop cron delivery seam did not fully apply (see prior "
        "error). A scheduled job made in a Desktop chat does not post its result back into "
        "that chat; the chat then says so instead of promising it.",
    ),
    (
        "session_title",
        "apex-overlay: hc-1192 session title seam did not fully apply (see prior "
        "error). Session titles follow the language of the user's first message "
        "instead of the interface language, a greeting titled in Chinese is kept "
        "as the final title, and on the APEX relay the model title waits for the "
        "whole first turn.",
    ),
    (
        "browser_window",
        "apex-overlay: hc-1179 Desktop browser window seam did not fully apply (see "
        "prior error). With browser.headed on, the browser_exec window gets no "
        "persistent profile, so a sign-in in it is lost next turn; and the "
        "apex.browser_hide_automation switch no longer reaches the Chromium launch args.",
    ),
    (
        "folder_grants",
        "apex-overlay: hc-1207 folder grants seam did not fully apply (see prior "
        "error). A folder handed over in Desktop (添加文件夹, a Finder drop or paste) "
        "that is outside the chat's working directory reaches the agent only as "
        "\"path is outside the allowed workspace\".",
    ),
)


def _apply_seams(seams) -> None:
    for name, warning in seams:
        try:
            if not importlib.import_module(f"apex_overlay.{name}").apply():
                logger.warning(warning)
        except Exception:
            logger.warning("apex-overlay: %s seam failed to load", name, exc_info=True)


# Seams that register on the plugin context itself (system prompt sections), so
# their apply() takes ctx: each with the warning logged when it reports False.
_CONTEXT_SEAMS = (
    (
        "user_profile_prompt",
        "apex-overlay: hc-991 user profile prompt section did not register "
        "(see prior warning). New local sessions will not carry the "
        "account's 用户画像 (the first-use creator answers).",
    ),
    (
        "memory_ledger",
        "apex-overlay: hc-1016 memory ledger seam did not register (see prior "
        "warning). New local sessions will not carry the account's 记忆底账 "
        "and the agent cannot write to it.",
    ),
    (
        "memory_ledger_live",
        "apex-overlay: hc-1097 live memory ledger seam did not register (see "
        "prior warning). A session already open keeps the 记忆底账 of its "
        "first turn: what another assistant or the 「它记得什么」 page noted "
        "since does not reach it.",
    ),
    (
        "single_thread_prompt",
        "apex-overlay: hc-1015 single-thread prompt section did not "
        "register (see prior warning). With desktop_features.single_thread "
        "on, answers may name tools, skills and models again.",
    ),
    (
        "assistant_name",
        "apex-overlay: hc-1082 assistant name seam did not register (see "
        "prior warning). With several assistants on, 「以后叫你小李」 has no "
        "tool to rename this assistant on screen, and a session renamed from "
        "the sidebar keeps the name its prompt was built with.",
    ),
    (
        "handoff",
        "apex-overlay: hc-1088 relay seam did not register (see prior "
        "warning). With relay on, a job handed over from another assistant "
        "is not recognised and nothing is handed back, and assistants cannot "
        "offer a job to the one whose 分工 it is.",
    ),
    (
        "proactive_prompt",
        "apex-overlay: hc-1071 proactive prompt section did not register "
        "(see prior warning). With desktop_features.single_thread on, APEX "
        "may start without asking for facts only the user knows, and results "
        "may end without next-step buttons or an offer of the next job.",
    ),
    (
        "honesty_prompt",
        "apex-overlay: hc-1036 evidence and delivery honesty section did "
        "not register (see prior warning). Desktop sessions will not carry "
        "the evidence levels, the provenance rule or the no-unasked-switch rule.",
    ),
    (
        "result_delivery_prompt",
        "apex-overlay: hc-1131 result delivery prompt section did not register "
        "(see prior warning). In product mode, replies may write local paths "
        "under the result cards again.",
    ),
    (
        "cron_result_prompt",
        "apex-overlay: hc-1183 scheduled result prompt section did not register "
        "(see prior warning). A Desktop chat may promise that a scheduled job's "
        "result comes back into the conversation, where it never appears.",
    ),
    (
        "relay_stream_liveness",
        "apex-overlay: hc-1032 relay stream liveness seam did not apply "
        "(see prior error). A Desktop chat stream whose bytes stop arriving "
        "waits out the 600 s stale timer again, and its retry is metered twice.",
    ),
    (
        "approval_rules_prompt",
        "apex-overlay: hc-1034 approval rules prompt section did not register "
        "(see prior warning). Read-only checks may be bundled into lines that "
        "need approval again, and a declined or unanswered approval may not be "
        "explained to the user.",
    ),
    (
        "chatcut",
        "apex-overlay: hc-1122 ChatCut seam did not fully apply (see prior "
        "warning). With desktop_features.chatcut on, the assistant may not "
        "find ChatCut, and an entry left from before the switch went off may "
        "stay.",
    ),
    (
        "desktop_version",
        "apex-overlay: hc-1095 Desktop version seam did not fully apply (see "
        "prior warning). Asked which version it is, APEX may look up the "
        "open-source engine's releases, say it runs on Hermes Agent and offer "
        "to upgrade it, instead of naming the APEX version and how to update.",
    ),
    (
        "browser_login_prompt",
        "apex-overlay: hc-1179 browser login prompt section did not register (see "
        "prior warning). In Desktop product mode, the agent may try to fill a "
        "login or solve a human check in its browser window itself, instead of "
        "stopping and handing the sign-in to the user.",
    ),
)


def _apply_context_seams(ctx) -> None:
    for name, warning in _CONTEXT_SEAMS:
        try:
            if not importlib.import_module(f"apex_overlay.{name}").apply(ctx):
                logger.warning(warning)
        except Exception:
            logger.warning("apex-overlay: %s seam failed to load", name, exc_info=True)


def register(ctx) -> None:
    """Apply all apex_overlay seams. Called once during plugin discovery.

    Each ``apply()`` is idempotent and fail-safe: a seam that can't bind to its
    upstream target logs an error and returns False (the seam-test turns that
    into a hard CI failure) but never raises, so a single broken overlay can't
    take down plugin discovery or the host.
    """
    try:
        from apex_overlay import doubao_tts

        doubao_tts.apply(ctx)
    except Exception:
        logger.warning("apex-overlay: doubao_tts seam failed to load", exc_info=True)

    _apply_context_seams(ctx)

    try:
        from apex_overlay import provider_filter

        if not provider_filter.apply():
            logger.warning(
                "apex-overlay: hc-392/hc-621 provider denylist seam did not "
                "fully apply (see prior error). Disabled providers may still "
                "be probed/fetched at startup, and their auth-status polls "
                "may keep resolving tokens / spawning `gh auth token` "
                "(hc-621 warning storm)."
            )
    except Exception:
        logger.warning("apex-overlay: provider_filter seam failed to load", exc_info=True)

    try:
        from apex_overlay import media_tools
        media_tools.apply()
    except Exception:
        logger.exception("APEX COS browser installer seam failed")

    try:
        from apex_overlay import managed_model_catalog

        if not managed_model_catalog.apply():
            logger.warning("apex-overlay: managed model catalog budget seam did not apply")
    except Exception:
        logger.warning("apex-overlay: managed model catalog seam failed to load", exc_info=True)

    try:
        from apex_overlay import model_catalog_dedupe

        if not model_catalog_dedupe.apply():
            logger.warning(
                "apex-overlay: hc-512 model-catalog sentinel dedupe seam did "
                "not fully apply (see prior error). The model picker may show "
                "the managed sentinel id (…-APEX) and the relay's live bare id "
                "as two separate rows for the same route."
            )
    except Exception:
        logger.warning("apex-overlay: model_catalog_dedupe seam failed to load", exc_info=True)

    try:
        from apex_overlay import picker_probe_widening

        if not picker_probe_widening.apply():
            logger.warning(
                "apex-overlay: picker probe widening seam did not fully apply "
                "(see prior error). A main provider that names no saved custom "
                "endpoint (virtual 'moa', or bare 'custom' with an empty "
                "base_url) will collapse the platform model list to its single "
                "configured id, so no further model can be picked."
            )
    except Exception:
        logger.warning(
            "apex-overlay: picker_probe_widening seam failed to load", exc_info=True
        )

    try:
        from apex_overlay import custom_base_url_guard

        if not custom_base_url_guard.apply():
            logger.warning(
                "apex-overlay: custom base_url guard seam did not fully apply "
                "(see prior error). Switching models inside the custom provider "
                "family keeps erasing model.base_url, stranding the managed "
                "relay with no address the picker can match."
            )
    except Exception:
        logger.warning(
            "apex-overlay: custom_base_url_guard seam failed to load", exc_info=True
        )

    try:
        from apex_overlay import custom_row_dedupe

        if not custom_row_dedupe.apply():
            logger.warning(
                "apex-overlay: hc-598 custom row dedupe seam did not fully "
                "apply (see prior error). The model directory will list the "
                "managed endpoint twice — once under its own name and once as "
                "the implementation word 'Custom endpoint', the second copy "
                "falsely marked 'not authenticated'."
            )
    except Exception:
        logger.warning(
            "apex-overlay: custom_row_dedupe seam failed to load", exc_info=True
        )

    try:
        from apex_overlay import models_dev_fast

        if not models_dev_fast.apply():
            logger.warning(
                "apex-overlay: non-blocking models.dev fetch seam did not fully "
                "apply (see prior error). The /model picker may block on a live "
                "~2.4MB models.dev catalog fetch (7-15s from mainland China)."
            )
    except Exception:
        logger.warning("apex-overlay: models_dev_fast seam failed to load", exc_info=True)

    try:
        from apex_overlay import gateway_bootstrap

        if not gateway_bootstrap.apply():
            logger.warning(
                "apex-overlay: hc-384/385 gateway background-startup seam did "
                "not fully apply (see prior error). Slow adapters (Feishu) may "
                "block the gateway's conversation-ready signal at startup."
            )
    except Exception:
        logger.warning("apex-overlay: gateway_bootstrap seam failed to load", exc_info=True)

    try:
        from apex_overlay import feishu_supervisor

        if not feishu_supervisor.apply():
            logger.warning(
                "apex-overlay: hc-384 Feishu self-reconnect supervisor seam did "
                "not fully apply (see prior error). Feishu falls back to the "
                "lark SDK's broken single-shot auto-reconnect, which left bots "
                "dead for hours in prod."
            )
    except Exception:
        logger.warning("apex-overlay: feishu_supervisor seam failed to load", exc_info=True)

    # hc-401: seams porting the four cloud build-time in-place patches into the
    # overlay so the cloud container image can be built from this fork (unify the
    # two runtime assembly lines). Each is idempotent + fail-safe.

    try:
        from apex_overlay import web_tools_extract

        if not web_tools_extract.apply():
            logger.warning(
                "apex-overlay: hc-401 web_extract capability-gate seam did not "
                "fully apply (see prior error). web_extract stays gated by the "
                "broad check_web_api_key and may hang on search-only backends "
                "like ddgs (model calls it, request spins to Feishu timeout)."
            )
    except Exception:
        logger.warning("apex-overlay: web_tools_extract seam failed to load", exc_info=True)

    try:
        from apex_overlay import stt_no_lazy_install

        if not stt_no_lazy_install.apply():
            logger.warning(
                "apex-overlay: hc-401 managed-runtime STT lazy-install guard seam "
                "did not fully apply (see prior error). A managed (768MB) container "
                "may OOM-kill the gateway lazy-installing faster-whisper on first "
                "transcription."
            )
    except Exception:
        logger.warning("apex-overlay: stt_no_lazy_install seam failed to load", exc_info=True)

    _apply_seams(_CN_IM_SEAMS)

    try:
        from apex_overlay import cn_mirror_env

        if not cn_mirror_env.apply():
            logger.warning(
                "apex-overlay: hc-476 runtime CN mirror env seam did not fully "
                "apply (see prior error). Runtime lazy downloads (Playwright "
                "Chromium autoinstall, managed-Node reinstall) may pull from "
                "foreign hosts on mainland-China machines."
            )
    except Exception:
        logger.warning("apex-overlay: cn_mirror_env seam failed to load", exc_info=True)

    try:
        from apex_overlay import im_passthrough

        if not im_passthrough.apply():
            logger.warning(
                "apex-overlay: hc-539 IM passthrough seam did not fully apply "
                "(see prior error). /cc and /codex will NOT enter direct "
                "coding-agent passthrough; those messages fall through to the "
                "normal Hermes agent."
            )
    except Exception:
        logger.warning("apex-overlay: im_passthrough seam failed to load", exc_info=True)

    _apply_seams(_TOOL_SEAMS)
