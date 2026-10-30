"""hc-1116: upstream wording on APEX surfaces (apex_overlay/upstream_copy.py).

test_upstream_copy_exits.py pins every exit's words per surface against goldens from clean main. These tests
pin the rest: that every catalog line with upstream wording was looked at (said APEX's way, or left upstream's
for a reason written down here); that the APEX lines never say what they replace and never ask for a value
the caller does not pass; that a moved upstream sentence is reported, not guessed; that applying twice
changes nothing; and that nothing is registered or patched off an APEX surface.
"""

from __future__ import annotations

import importlib.util
import logging
import re
import string
import types
from pathlib import Path

import pytest

from agent import i18n_layers, onboarding, prompt_builder, system_prompt
from agent.i18n import t
from apex_overlay import apex_identity, cn_im_messages, single_thread_prompt, upstream_copy
from apex_overlay.apex_identity import CLOUD, DESKTOP

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("hc1116_probe", Path(__file__).with_name("upstream_copy_probe.py"))
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)

# Catalog keys with upstream wording that stay upstream's on APEX surfaces, and why. A new upstream key with
# such wording fails test_every_upstream_line_is_said_the_apex_way_or_left_for_a_reason until it is decided.
TELEGRAM = "Telegram topics only; APEX connects no Telegram bot"
NOUS = "Nous account commands (/login, /credits, /topup, /subscription); whether APEX hides them in IM is Kael's call"
UPDATE = "IM /update runs the engine's own updater on the host; whether APEX turns it off is Kael's call"
LEFT_UPSTREAM: dict[str, str] = {
    **{key: TELEGRAM for key in (
        "gateway.topic.default_title", "gateway.topic.help", "gateway.topic.mode_disabled",
        "gateway.topic.new_header", "gateway.topic.restored_last_message", "gateway.topic.root_lobby",
        "gateway.topic.root_new", "gateway.topic.status_how_to", "gateway.topic.system_topic_intro",
        "gateway.topic.thread_ready", "platform.telegram.install_hint",
    )},
    **{key: "a platform APEX does not connect (Discord, Slack, Matrix, IRC, Google Chat, email)" for key in (
        "gateway.resume.matrix_blocked_no_origin",
        "platform.discord.approval.question", "platform.discord.command.reload_skills.description",
        "platform.discord.command.reset.description", "platform.discord.command.restart.description",
        "platform.discord.command.skill.description", "platform.discord.command.status.description",
        "platform.discord.command.stop.description", "platform.discord.command.thread.arg_message",
        "platform.discord.command.thread.description", "platform.discord.prompt.clarify_title",
        "platform.discord.thread.auto_create_failed", "platform.discord.thread.default_name",
        "platform.discord.thread.handoff_seed", "platform.discord.thread.seed_message",
        "platform.email.standalone_subject", "platform.google_chat.typing.thinking", "platform.irc.quit_message",
        "platform.matrix.handoff.default_name", "platform.slack.handoff.seed", "platform.slack.task_card.title",
    )},
    **{key: NOUS for key in (
        "gateway.credits.not_logged_in", "gateway.topup.header", "gateway.login.free_tier_remaining",
        "slash.login.description", "slash.subscription.description", "slash.topup.description",
    )},
    **{key: UPDATE for key in (
        "gateway.update.failed_notice", "gateway.update.finished", "gateway.update.finished_success",
        "gateway.update.hermes_cmd_not_found", "gateway.update.managed_action", "gateway.update.not_applicable",
        "gateway.update.platform_not_messaging", "gateway.update.starting", "gateway.update.timed_out",
        "slash.update.description",
    )},
    "gateway.debug.full_logs_hint": "/debug uploads logs to upstream's paste service; whether APEX turns it off is Kael's call",
    "gateway.debug.share_hint": "/debug uploads logs to upstream's paste service; whether APEX turns it off is Kael's call",
    "gateway.kanban.ping.gave_up": "kanban dispatcher notice; the only way on is the hermes kanban CLI, APEX has none",
    "gateway.kanban.truncated_suffix": "kanban dispatcher notice; the only way on is the hermes kanban CLI, APEX has none",
    "gateway.unauthorized.action_notice": "pairing a stranger with the bot; how APEX pairs is Kael's call",
    "gateway.unauthorized.owner_notice": "pairing a stranger with the bot; how APEX pairs is Kael's call",
    "gateway.model.err_skew": "only on a git checkout whose code moved under a running gateway; never APEX's packaged engine or image",
    **{key: "the /model command's own lines (usage, picker); whether APEX keeps /model in IM is Kael's call" for key in (
        "gateway.model.usage_persist", "gateway.model.usage_switch_model", "gateway.model.usage_switch_provider",
        "platform.shared.model_picker_expired", "platform.discord.picker.more_available",
        "platform.slack.picker.more_available", "platform.telegram.picker.expired_model",
        "platform.telegram.picker.more_available",
    )},
    "gateway.usage.reset_wrong_provider": "openai-codex only; APEX runs on its relay",
    "gateway.verbose.mode_log": "/verbose log mode names a file path, not the product",
    "gateway.skills.diff_truncated": "skill-write approval diff; names a file path, not the product",
    "slash.help.description": "/help's own line inside /help, not a pointer to it",
    "slash.hermes.description": "/hermes is a developer command",
    "slash.plan.description": "names the .hermes/plans/ folder, not the product",
    "slash.reload-skills.description": "names the ~/.hermes/skills/ folder, not the product",
    "slash.statusbar.description": "matched only by the word 'model'; CLI status bar",
    "slash.wake.description": "the 'Hey Hermes' wake word is the CLI voice mode; APEX has none",
}

# What an APEX line may not say.
FORBIDDEN = re.compile(r"Hermes|`?hermes [a-z]|/help|Nous|/model|/login|~/\.hermes|<restart>|<relogin>|<free_space>")


def _fields(text: str) -> set[str]:
    return {name for _, name, _, _ in string.Formatter().parse(text) if name}


@pytest.fixture(autouse=True)
def _clean(monkeypatch, tmp_path):
    monkeypatch.delenv(single_thread_prompt.SWITCH_ENV, raising=False)
    monkeypatch.delenv(apex_identity.MANAGED_ENV, raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    # The seam patches these in place; restore upstream's after every test.
    monkeypatch.setattr(onboarding, "PLAIN_INTRO_NOTE", onboarding.PLAIN_INTRO_NOTE)
    monkeypatch.setattr(onboarding, "profile_build_directive", onboarding.profile_build_directive)
    monkeypatch.setattr(system_prompt, "STEER_CHANNEL_NOTE", prompt_builder.STEER_CHANNEL_NOTE)
    monkeypatch.setitem(system_prompt.PLATFORM_HINTS, "desktop", prompt_builder.PLATFORM_HINTS["desktop"])
    monkeypatch.setattr(cn_im_messages, "_HC228_ZH_LITERALS", list(cn_im_messages._HC228_ZH_LITERALS))
    monkeypatch.setattr(upstream_copy, "_registered", {})
    packs = list(i18n_layers.registered_packs())
    yield
    for entry in i18n_layers.registered_packs():
        if entry not in packs:
            i18n_layers.unregister_pack(entry)


def _on(monkeypatch, where: str) -> None:
    if where == DESKTOP:
        monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")
    else:
        monkeypatch.setenv(apex_identity.MANAGED_ENV, "1")


def _apex_packs():
    return [entry for entry in i18n_layers.registered_packs() if entry.source == upstream_copy.PACK_SOURCE]


# ---- the census -----------------------------------------------------------------------------------------------

def test_every_upstream_line_is_said_the_apex_way_or_left_for_a_reason():
    keys = set(probe.upstream_keys())
    said = set(upstream_copy.MESSAGES["zh"])
    assert said == set(upstream_copy.MESSAGES["en"])
    assert not said & set(LEFT_UPSTREAM), "a key is both rewritten and left upstream's"
    undecided = keys - said - set(LEFT_UPSTREAM)
    assert not undecided, f"upstream wording nobody decided on: {sorted(undecided)}"
    # Nothing stale: every listed key still exists upstream with upstream wording.
    assert not (said | set(LEFT_UPSTREAM)) - keys, sorted((said | set(LEFT_UPSTREAM)) - keys)


@pytest.mark.parametrize("where", [DESKTOP, CLOUD])
@pytest.mark.parametrize("lang", list(upstream_copy.MESSAGES))
def test_apex_lines_never_say_what_they_replace_or_ask_for_more(where, lang):
    bundled = i18n_layers.parse_locale_file(ROOT / "locales" / f"{lang}.yaml")
    for key, text in upstream_copy.messages_for(where, lang).items():
        assert not FORBIDDEN.search(text), f"{where}/{lang}/{key}: {text}"
        # A field upstream does not have would raise KeyError at the caller's format().
        assert _fields(text) <= _fields(bundled[key]), f"{where}/{lang}/{key}"


def test_desktop_and_cloud_differ_only_where_the_way_on_differs():
    differ = {key for key in upstream_copy.MESSAGES["zh"]
              if upstream_copy.messages_for(DESKTOP, "zh")[key] != upstream_copy.messages_for(CLOUD, "zh")[key]}
    marked = {key for key, text in upstream_copy.MESSAGES["zh"].items() if "<" in text}
    assert differ == marked


# ---- the anchors: an upstream rewrite is reported, not guessed ----------------------------------------------

def test_every_upstream_anchor_occurs_exactly_once_today():
    assert onboarding.PLAIN_INTRO_NOTE.count(upstream_copy.INTRO_HELP) == 1
    assert onboarding.profile_build_directive().count(upstream_copy.OFFER_HELP) == 1
    assert system_prompt.STEER_CHANNEL_NOTE.count(upstream_copy.STEER_SENDER[0]) == 1
    assert system_prompt.PLATFORM_HINTS["desktop"].count(upstream_copy.DESKTOP_HINT[0]) == 1
    rows = [row for row in cn_im_messages._HC228_ZH_LITERALS if row[0] == upstream_copy.CN_IM_UPSTREAM_MIDDLE]
    assert len(rows) == 1 and rows[0][1].count(upstream_copy.CN_IM_ZH_NAME[0]) == 1


@pytest.mark.parametrize("install, module, attribute", [
    (upstream_copy._install_first_contact, "agent.onboarding", "PLAIN_INTRO_NOTE"),
    (upstream_copy._install_steer_note, "agent.system_prompt", "STEER_CHANNEL_NOTE"),
])
def test_a_moved_sentence_keeps_upstream_words_and_says_so(caplog, install, module, attribute):
    fake = types.SimpleNamespace(PLAIN_INTRO_NOTE="Introduce yourself.", STEER_CHANNEL_NOTE="Steering arrives.",
                                 profile_build_directive=lambda: "Offer a profile.")
    with caplog.at_level(logging.ERROR, logger="apex_overlay.upstream_copy"):
        assert install(fake) is False
    assert getattr(fake, attribute) in ("Introduce yourself.", "Steering arrives.")
    assert "keeps upstream's words" in caplog.text


def test_a_moved_cn_im_row_keeps_upstream_words_and_says_so(caplog):
    fake = types.SimpleNamespace(_HC228_ZH_LITERALS=[("No home channel.", "没有主频道。")])
    with caplog.at_level(logging.ERROR, logger="apex_overlay.upstream_copy"):
        assert upstream_copy._install_cn_im(fake) is False
    assert fake._HC228_ZH_LITERALS == [("No home channel.", "没有主频道。")]


# ---- applying ---------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("environment", [{}, {"APEX_SINGLE_THREAD_ACTIVE": "0"}, {"HERMES_MANAGED_RUNTIME": "0"}])
def test_off_an_apex_surface_nothing_is_registered_or_patched(monkeypatch, environment):
    for name, value in environment.items():
        monkeypatch.setenv(name, value)
    note, steer = onboarding.PLAIN_INTRO_NOTE, system_prompt.STEER_CHANNEL_NOTE
    assert upstream_copy.apply() is True
    assert _apex_packs() == []
    assert (onboarding.PLAIN_INTRO_NOTE, system_prompt.STEER_CHANNEL_NOTE) == (note, steer)
    assert t("gateway.help.header", lang="zh") == "📖 **Hermes 命令**\n"


@pytest.mark.parametrize("where", [DESKTOP, CLOUD])
def test_applying_twice_changes_nothing_more(monkeypatch, where):
    _on(monkeypatch, where)
    assert upstream_copy.apply() is True
    first = (onboarding.PLAIN_INTRO_NOTE, onboarding.profile_build_directive(), system_prompt.STEER_CHANNEL_NOTE,
             system_prompt.PLATFORM_HINTS["desktop"], list(cn_im_messages._HC228_ZH_LITERALS))
    assert upstream_copy.apply() is True
    assert (onboarding.PLAIN_INTRO_NOTE, onboarding.profile_build_directive(), system_prompt.STEER_CHANNEL_NOTE,
            system_prompt.PLATFORM_HINTS["desktop"], list(cn_im_messages._HC228_ZH_LITERALS)) == first
    assert sorted(entry.lang for entry in _apex_packs()) == ["en", "zh"]
    assert "/help" not in onboarding.PLAIN_INTRO_NOTE + onboarding.profile_build_directive()


def test_the_desktop_hint_changes_only_on_desktop(monkeypatch):
    hint = system_prompt.PLATFORM_HINTS["desktop"]
    _on(monkeypatch, CLOUD)
    upstream_copy.apply()
    assert system_prompt.PLATFORM_HINTS["desktop"] == hint


def test_both_languages_read_the_pack_and_the_rest_stays_upstream(monkeypatch):
    _on(monkeypatch, DESKTOP)
    upstream_copy.apply()
    assert t("gateway.help.header", lang="zh") == "📖 **APEX 命令**\n"
    assert t("gateway.errors.unreachable", lang="en").endswith("if it persists, quit APEX and open it again.")
    assert t("gateway.topic.default_title", lang="zh") == "Hermes 聊天"  # left upstream's (Telegram)
    # Another language keeps its own catalog: the pack is zh and en only.
    assert "Hermes" in t("gateway.help.header", lang="ja")


def test_wechat_still_gets_the_no_home_channel_notice_in_chinese_from_apex_english(monkeypatch):
    _on(monkeypatch, CLOUD)
    upstream_copy.apply()
    english = t("gateway.notify.no_home_channel", lang="en", platform="weixin", sethome_cmd="/sethome")
    assert "APEX" in english
    localized = cn_im_messages._hc228_localize("weixin", english)
    assert "主频道用于接收 APEX 的定时任务结果" in localized and "home channel" not in localized
    # Upstream's own English (a gateway that started before the pack) still maps, to the APEX name.
    upstream = english.replace("APEX", "Hermes")
    assert cn_im_messages._hc228_localize("weixin", upstream) == localized
