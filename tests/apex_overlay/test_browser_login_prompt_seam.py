"""Seam-test + behavior test for apex_overlay.browser_login_prompt (hc-1179).

The section tells the Desktop agent to hand a browser sign-in / human check to the user.
Proven:
  * it renders only in Desktop product mode (platform desktop + single-thread switch on);
  * the copy keeps the two safety rules — don't type a password, don't solve the check —
    so a reword that drops either turns this test red;
  * apply() registers on a plugin ctx and reports a host that cannot.

Run via scripts/run_tests_parallel.py (per-file fresh interpreter).
"""

from __future__ import annotations

from apex_overlay import browser_login_prompt, single_thread_prompt


def test_renders_only_in_desktop_product_mode(monkeypatch):
    monkeypatch.setattr(single_thread_prompt, "switch_on", lambda: True)

    section = browser_login_prompt.render_section({"platform": "desktop"})
    assert section == browser_login_prompt.BROWSER_LOGIN_PROMPT
    assert section  # non-empty


def test_blank_off_desktop(monkeypatch):
    monkeypatch.setattr(single_thread_prompt, "switch_on", lambda: True)
    assert browser_login_prompt.render_section({"platform": "wecom"}) == ""
    assert browser_login_prompt.render_section(None) == ""
    assert browser_login_prompt.render_section({}) == ""


def test_blank_when_switch_off(monkeypatch):
    monkeypatch.setattr(single_thread_prompt, "switch_on", lambda: False)
    assert browser_login_prompt.render_section({"platform": "desktop"}) == ""


def test_copy_keeps_the_handoff_and_safety_rules():
    prompt = browser_login_prompt.BROWSER_LOGIN_PROMPT
    # The sign-in is handed to the user in the window…
    assert "用户" in prompt
    assert "窗口" in prompt
    # …and the agent does neither of the two prohibited things itself.
    assert "不要填密码" in prompt
    assert "不要去解验证码" in prompt


def test_apply_registers_section():
    registered = {}

    class _Ctx:
        def register_system_prompt_section(self, section_id, fn, max_chars):
            registered["id"] = section_id
            registered["fn"] = fn
            registered["max_chars"] = max_chars

    assert browser_login_prompt.apply(_Ctx()) is True
    assert registered["id"] == browser_login_prompt.SECTION_ID
    assert registered["max_chars"] == browser_login_prompt.MAX_CHARS


def test_apply_reports_host_without_section_support():
    class _Bare:
        pass

    assert browser_login_prompt.apply(_Bare()) is False


def test_plugin_register_applies_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_browser_login_plugin_under_test")
    assert "browser_login_prompt" in called, "plugin.register() must call browser_login_prompt.apply()"
