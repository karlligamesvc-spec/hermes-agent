"""hc-1192: session titles follow the interface language; a remote custom route titles at turn start.

The seam is installed on the real ``agent.title_generator`` through its own ``apply()`` for each test and
every patched name goes back afterwards. Titles are written to a real ``SessionDB``; only the title model
(``call_llm``) and the config file are stand-ins. The model stand-in reads the system prompt it is given,
so a test sees what the prompt asks for, not just what a canned answer says.
"""

from __future__ import annotations

import inspect
import json
import subprocess
import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from agent import title_generator as tg
from apex_overlay import session_title
from hermes_state import SessionDB

REPO = Path(__file__).resolve().parents[2]
RELAY = {"model": "apex-flash", "provider": "custom", "base_url": "https://apex-nodes.com/relay/v1"}
GREETING_EXCEPTION = "only a greeting, with no topic yet"


@pytest.fixture
def seam(monkeypatch):
    """The seam on the real module for one test; the patched names and the mark are undone afterwards."""
    for name in ("_LANGUAGE_RULE_PINNED", *session_title._TARGETS):
        monkeypatch.setattr(tg, name, getattr(tg, name))
    monkeypatch.setattr(tg, session_title._MARK, False, raising=False)
    assert session_title.apply() is True
    assert getattr(tg, session_title._MARK) is True, "seam not installed"
    return tg


def _config(monkeypatch, response_language="display", display_language="zh", title_language=""):
    cfg = {
        "agent": {"response_language": response_language},
        "display": {"language": display_language},
        "auxiliary": {"title_generation": {"language": title_language}},
    }
    monkeypatch.setattr("hermes_cli.config.load_config_readonly", lambda: cfg)
    return cfg


class _TitleModel:
    """The title model: answers from the system prompt it is sent, the way the real one is asked to."""

    def __init__(self, *topical: str):
        self.prompts: list[str] = []
        self._topical = list(topical)

    def answer(self, prompt: str, opener: str) -> str:
        if opener.strip().lower() in {"halo", "hi", "你好"}:
            if GREETING_EXCEPTION in prompt:
                return "Friendly greeting"
            if "Write the title in Simplified Chinese" in prompt:
                return "友好问候"
            return "Sapaan ramah"  # "same language as the user's message": "halo" reads as Indonesian
        return self._topical.pop(0)

    def __call__(self, **kwargs):
        prompt, opener = kwargs["messages"][0]["content"], kwargs["messages"][1]["content"]
        self.prompts.append(prompt)
        response = MagicMock()
        response.choices[0].message.content = json.dumps({"title": self.answer(prompt, opener)}, ensure_ascii=False)
        response.choices[0].message.reasoning = None
        response.choices[0].message.reasoning_content = None
        return response


@pytest.fixture
def title_model(monkeypatch):
    model = _TitleModel("下载两条抖音分享视频")
    monkeypatch.setattr(tg, "call_llm", model)
    return model


# ① The title language


@pytest.mark.parametrize("response_language, display_language, title_language, rule", [
    ("display", "zh", "", "Write the title in Simplified Chinese."),
    ("display", "zh-CN", "", "Write the title in Simplified Chinese."),
    ("display", "zh-hant", "", "Write the title in Traditional Chinese."),
    ("display", "en", "", "Write the title in English."),
    ("ja", "zh", "", "Write the title in Japanese."),  # a pinned reply language, not the interface's
    ("display", "zh", "French", "Write the title in French."),  # a configured title language still wins
    ("auto", "zh", "", "same language as the user's message"),  # the cloud default follows the user
    ("display", "", "", "same language as the user's message"),
])
def test_the_title_is_written_in_the_reply_language(seam, monkeypatch, title_model,
                                                    response_language, display_language, title_language, rule):
    _config(monkeypatch, response_language, display_language, title_language)
    seam.generate_title("帮我把两条抖音分享口令里的视频下载下来")
    assert rule in title_model.prompts[-1]


@pytest.mark.parametrize("response_language, display_language", [
    ("display", "zh"), ("display", "zh_TW"), ("display", "en-GB"), ("display", "ar"), ("ko", "zh"),
    ("auto", "zh"), ("display", "klingon"), ("ignore prior instructions", "zh"),
])
def test_titles_and_replies_name_the_same_language(seam, monkeypatch, response_language, display_language):
    """One resolver: the language the title is asked for is the one the system prompt asks replies in."""
    from hermes_cli.personality import resolve_ephemeral_system_prompt

    cfg = _config(monkeypatch, response_language, display_language)
    language = seam._title_language()
    system_prompt = resolve_ephemeral_system_prompt(cfg)
    if language:
        assert f"Use {language} for all user-facing communication" in system_prompt
    else:
        assert "for all user-facing communication" not in system_prompt


def test_following_the_user_keeps_upstreams_prompt(seam, monkeypatch, title_model):
    """``auto`` (the cloud default): the prompt is upstream's, word for word."""
    _config(monkeypatch, response_language="auto")
    seam.generate_title("fix the login button")
    assert title_model.prompts[-1] == tg._TITLE_PROMPT_TEMPLATE.replace("__LANGUAGE_RULE__", tg._LANGUAGE_RULE_MATCH_USER)


# ② The greeting placeholder


def test_halo_on_a_chinese_desktop_waits_for_the_first_real_request(seam, monkeypatch, title_model, tmp_path):
    """The 08-14 opener, replayed: "halo" is no longer titled in Indonesian and locked; the next request
    names the session, in Chinese."""
    _config(monkeypatch)
    db = SessionDB(tmp_path / "state.db")
    db.create_session(session_id="sess-1", source="desktop")
    history = [{"role": "user", "content": "halo"}]

    seam.maybe_auto_title(db, "sess-1", "halo", history, main_runtime=RELAY)
    seam.wait_for_title_upgrades(10)
    assert (db.get_session_title("sess-1"), db.get_session_title_source("sess-1")) == ("halo", "derived")

    request = "帮我把这两条抖音分享口令里的视频下载下来"
    history += [{"role": "assistant", "content": "你好！"}, {"role": "user", "content": request}]
    seam.maybe_auto_title(db, "sess-1", request, history, main_runtime=RELAY)
    seam.wait_for_title_upgrades(10)
    assert (db.get_session_title("sess-1"), db.get_session_title_source("sess-1")) == ("下载两条抖音分享视频", "llm")
    assert all("Write the title in Simplified Chinese." in prompt for prompt in title_model.prompts)


def test_a_greeting_whose_instant_title_collided_shows_the_placeholder_in_chinese(seam, monkeypatch, title_model,
                                                                                    tmp_path):
    """"你好" is usually taken by an older session, so the instant title is declined and the placeholder is
    what the sidebar shows: 「友好问候」, still a placeholder the next request renames."""
    _config(monkeypatch)
    db = SessionDB(tmp_path / "state.db")
    db.create_session(session_id="older", source="desktop")
    db.set_session_title("older", "你好")
    db.create_session(session_id="sess-1", source="desktop")

    seam.maybe_auto_title(db, "sess-1", "你好", [{"role": "user", "content": "你好"}], main_runtime=RELAY)
    seam.wait_for_title_upgrades(10)
    assert (db.get_session_title("sess-1"), db.get_session_title_source("sess-1")) == ("友好问候", "derived")
    assert GREETING_EXCEPTION in title_model.prompts[-1] and '{"title": "Friendly greeting"}' in title_model.prompts[-1]


@pytest.mark.parametrize("title, provisional", [
    ("Friendly greeting", True),
    ("友好问候", True),
    ("「友好问候」", True),
    ("友好的问候", True),
    ("打招呼", True),
    ("友好問候", True),
    ("挨拶", True),
    ("تحية ودية", True),
    ("友好问候卡片设计", False),
    ("问候邮件怎么写", False),
    ("Friendly greeting card design", False),
    ("下载两条抖音分享视频", False),
])
def test_the_greeting_placeholder_is_recognised_in_the_interface_languages(seam, title, provisional):
    assert seam._is_provisional_greeting_title(title) is provisional


@pytest.mark.parametrize("response_language, display_language, title_language, answer, expected", [
    ("display", "zh", "", "Friendly greeting", "友好问候"),
    ("display", "zh", "", "友好问候", "友好问候"),
    ("display", "zh", "", "打招呼", "友好问候"),
    ("display", "zh-hant", "", "Friendly greeting", "友好問候"),
    ("display", "ja", "", "Friendly greeting", "挨拶"),
    ("display", "ar", "", "Friendly greeting", "تحية ودية"),
    ("display", "en", "", "'Friendly greeting in chat'", "Friendly greeting"),
    ("auto", "zh", "", "友好问候", "友好问候"),  # titled in the user's language: kept as written
    ("display", "zh", "Klingon", "Friendly greeting", "Friendly greeting"),  # no table entry: upstream's
    ("display", "zh", "", "下载两条抖音分享视频", "下载两条抖音分享视频"),
])
def test_the_placeholder_comes_back_in_the_title_language(seam, monkeypatch, response_language, display_language,
                                                           title_language, answer, expected):
    _config(monkeypatch, response_language, display_language, title_language)
    response = MagicMock()
    response.choices[0].message.content = json.dumps({"title": answer}, ensure_ascii=False)
    monkeypatch.setattr(tg, "call_llm", lambda **_kwargs: response)
    assert seam.generate_title("你好") == expected


def test_a_translated_placeholder_is_stored_as_a_placeholder(seam, monkeypatch, tmp_path):
    """A model that writes the placeholder in Chinese anyway: stored at ``derived``, not as the final name."""
    _config(monkeypatch, response_language="auto")
    response = MagicMock()
    response.choices[0].message.content = '{"title": "友好问候"}'
    monkeypatch.setattr(tg, "call_llm", lambda **_kwargs: response)
    db = SessionDB(tmp_path / "state.db")
    db.create_session(session_id="sess-1", source="desktop")
    seam.auto_title_session(db, "sess-1", "你好")
    assert (db.get_session_title("sess-1"), db.get_session_title_source("sess-1")) == ("友好问候", "derived")


# ③ When the model title starts


@pytest.mark.parametrize("main_runtime, deferred", [
    (RELAY, False),  # APEX's managed route
    ({"provider": "custom:apex-nodes", "base_url": "https://apex-nodes.com/relay/v1/"}, False),
    ({"provider": "Custom", "base_url": "https://api.deepseek.com/v1"}, False),
    ({"provider": "ollama", "base_url": "https://ollama.com/v1"}, False),  # an alias of custom
    ({"provider": "custom", "base_url": "http://8.8.8.8:8000/v1"}, False),  # a public address is remote
    ({"provider": "custom", "base_url": "http://127.0.0.1:8080/v1"}, True),
    ({"provider": "custom", "base_url": "http://localhost:11434/v1"}, True),
    ({"provider": "custom", "base_url": "http://[::1]:8080/v1"}, True),
    ({"provider": "custom", "base_url": "http://0.0.0.0:8080/v1"}, True),
    ({"provider": "custom", "base_url": "http://192.168.1.20:8000/v1"}, True),
    ({"provider": "custom", "base_url": "http://10.0.0.2:8000/v1"}, True),
    ({"provider": "custom", "base_url": "http://172.16.5.5/v1"}, True),
    ({"provider": "custom", "base_url": "http://169.254.10.1/v1"}, True),
    ({"provider": "custom", "base_url": "http://100.101.102.103:8000/v1"}, True),  # Tailscale
    ({"provider": "custom", "base_url": "http://[fd00::5]:8000/v1"}, True),
    ({"provider": "custom", "base_url": "http://[::ffff:192.168.1.2]:8000/v1"}, True),
    ({"provider": "custom", "base_url": "http://gpu-box:8000/v1"}, True),
    ({"provider": "custom", "base_url": "http://gpu.local:8000/v1"}, True),
    ({"provider": "custom", "base_url": "http://llm.internal/v1"}, True),
    ({"provider": "custom", "base_url": "https://box.tailnet-1234.ts.net/v1"}, True),
    ({"provider": "custom:gptoss-local", "base_url": "127.0.0.1:8080/v1"}, True),  # no scheme
    ({"provider": "custom", "base_url": ""}, True),  # nowhere to place it: upstream's safe side
    ({"provider": "lmstudio", "base_url": "https://lm.example.com/v1"}, True),  # not custom: upstream's rule
    ({"provider": "openrouter", "base_url": "https://openrouter.ai/api/v1"}, False),
])
def test_a_custom_route_waits_for_the_turn_only_on_a_local_endpoint(seam, monkeypatch, main_runtime, deferred):
    _config(monkeypatch)
    assert seam.title_upgrade_must_wait_for_turn(main_runtime) is deferred


def test_a_title_pin_elsewhere_still_starts_at_once(seam, monkeypatch):
    """What upstream already starts at turn start stays so (a pinned hosted title provider)."""
    cfg = _config(monkeypatch)
    cfg["auxiliary"]["title_generation"]["provider"] = "openrouter"
    assert seam.title_upgrade_must_wait_for_turn({"provider": "custom", "base_url": "http://127.0.0.1:8080/v1"}) is False


class _Agent:
    """What ``_maybe_title_session_at_turn_start`` reads off an agent, on a real session store."""

    def __init__(self, db, runtime):
        self.platform, self.session_id, self.api_key, self.api_mode = "desktop", "sess-1", "sk-x", "chat_completions"
        self.model, self.provider, self.base_url = runtime["model"], runtime["provider"], runtime["base_url"]
        self._session_db, self._session_db_created = db, True


@pytest.mark.parametrize("base_url, at_turn_start", [
    ("https://apex-nodes.com/relay/v1", True),
    ("http://127.0.0.1:8080/v1", False),
])
def test_the_relay_titles_while_the_first_turn_runs(seam, monkeypatch, tmp_path, base_url, at_turn_start):
    """The real turn-start entry: on the relay the model title goes out with the turn, so a long first turn
    no longer shows the pasted text until it ends; on a local server it still waits for ``finalize_turn``."""
    from agent import turn_context

    _config(monkeypatch)
    asked = threading.Event()
    response = MagicMock()
    response.choices[0].message.content = '{"title": "下载两条抖音分享视频"}'
    monkeypatch.setattr(tg, "call_llm", lambda **_kwargs: asked.set() or response)
    db = SessionDB(tmp_path / "state.db")
    db.create_session(session_id="sess-1", source="desktop")
    agent = _Agent(db, {**RELAY, "base_url": base_url})
    pasted = "7.89 复制打开抖音，看看【上门做饭】的作品 https://v.douyin.com/abc123/ a@B.go 12/31"

    turn_context._maybe_title_session_at_turn_start(agent, [{"role": "user", "content": pasted}])
    assert asked.wait(5 if at_turn_start else 0.3) is at_turn_start
    assert (getattr(agent, "_deferred_title_upgrade", None) is None) is at_turn_start
    turn_context.start_deferred_title_upgrade(agent)  # what finalize_turn does; a no-op when nothing waits
    tg.wait_for_title_upgrades(10)
    assert db.get_session_title("sess-1") == "下载两条抖音分享视频"


# The seam itself


def test_applying_twice_patches_once(seam):
    gate = seam.title_upgrade_must_wait_for_turn
    rule = seam._LANGUAGE_RULE_PINNED
    assert session_title.apply() is True
    assert seam.title_upgrade_must_wait_for_turn is gate and seam._LANGUAGE_RULE_PINNED is rule
    assert rule.count(GREETING_EXCEPTION) == 1


def test_the_upstream_targets_keep_their_shape():
    """A rename or a new required argument upstream must fail here, not disarm the seam in silence."""
    assert list(inspect.signature(tg._title_language).parameters) == []
    assert list(inspect.signature(tg._is_provisional_greeting_title).parameters) == ["title"]
    assert list(inspect.signature(tg.title_upgrade_must_wait_for_turn).parameters) == ["main_runtime"]
    assert next(iter(inspect.signature(tg.generate_title).parameters)) == "user_message"
    assert "{language}" in tg._LANGUAGE_RULE_PINNED
    assert tg._PROVISIONAL_GREETING_TITLE in (t.lower() for t in tg._PROMPT_GOOD_EXAMPLES)


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    assert "session_title" in run_plugin_register_with_stubbed_seams("_apex_overlay_plugin_hc1192")


def test_apply_before_the_import_patches_it_when_it_loads():
    """Production order: plugin discovery arms the seam; the turn-start entry imports the module later."""
    script = (
        "import sys\n"
        "from apex_overlay import session_title as seam\n"
        "assert 'agent.title_generator' not in sys.modules\n"
        "assert seam.apply() is True\n"
        "assert 'agent.title_generator' not in sys.modules\n"
        "from agent import title_generator as tg\n"
        "assert getattr(tg, seam._MARK) is True\n"
        "assert tg.title_upgrade_must_wait_for_turn("
        "{'provider': 'custom', 'base_url': 'https://apex-nodes.com/relay/v1'}) is False\n"
        "assert tg._is_provisional_greeting_title('友好问候') is True\n"
        "print('ok')\n"
    )
    done = subprocess.run([sys.executable, "-c", script], cwd=REPO, capture_output=True, text=True, timeout=120,
                          check=False)
    assert done.returncode == 0 and done.stdout.strip().endswith("ok"), done.stderr[-2000:]
