"""hc-1179 浏览器登录交给用户: the Desktop browser window opens on the user's screen, so a
sign-in or human-verification wall is the user's to clear, not the agent's.

hc-1179 gives APEX Desktop a visible, persistent Chromium (``browser_window`` +
``browser.headed: true``). The user can watch it and take over. This section tells the
agent to use that: when a page needs a login, a QR scan, or a human check (captcha,
slider, SMS code), stop and ask the user to finish it in the window, then continue — never
type a password, never try to solve the check. A login usually holds after once, because
the profile persists.

Only the Desktop product chat gets it: ``platform == "desktop"`` with single-thread mode
on (``APEX_SINGLE_THREAD_ACTIVE=1``). IM, the terminal, cron and api_server have no window
on the user's screen to hand control to. A subagent inherits its parent's prompt.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from apex_overlay import single_thread_prompt

logger = logging.getLogger(__name__)

SECTION_ID = "apex.browser-login"
MAX_CHARS = 1_000

BROWSER_LOGIN_RULES = (
    "浏览器会在用户屏幕上开一个窗口,用这个助手自己的浏览器资料,登录状态会保存,用户也能看到和接手。",
    "遇到要登录、扫码,或人机验证(验证码、滑块、短信验证码)时:自己不要填密码、不要去解验证码。"
    "停下来,请用户在这个窗口里把登录或验证做完,用户说好了再接着做。",
    "要用户登录某个网站才能往下做时,直说要登录哪个站、请用户在窗口里登进去;因为资料会保存,登录一次之后一般就不用再登。",
)

BROWSER_LOGIN_PROMPT = "【浏览器登录 · 交给用户】\n" + "\n".join(f"- {rule}" for rule in BROWSER_LOGIN_RULES)


def render_section(session_info: Mapping[str, Any] | None = None) -> str:
    """The fixed section in Desktop product chat, else "" (the runtime then adds none)."""
    if (session_info or {}).get("platform") != "desktop":
        return ""
    if not single_thread_prompt.switch_on():
        return ""
    return BROWSER_LOGIN_PROMPT


def apply(ctx: Any) -> bool:
    """Register the section on this plugin's context. Idempotent per plugin manager."""
    register = getattr(ctx, "register_system_prompt_section", None)
    if register is None:
        logger.warning("apex-overlay: this plugin host cannot register system prompt sections")
        return False
    try:
        register(SECTION_ID, render_section, max_chars=MAX_CHARS)
    except ValueError as exc:
        logger.warning("apex-overlay: browser login prompt section not registered: %s", exc)
        return False
    return True
