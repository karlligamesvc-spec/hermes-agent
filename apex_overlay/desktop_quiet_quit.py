"""hc-1217 APEX Desktop's messaging gateway stops without a home-channel broadcast.

When the gateway stops, upstream tells two kinds of chat (``gateway/run_shutdown.py``
``_notify_active_sessions_of_shutdown``): first every chat whose task is running, then every served
profile's home channel. On Desktop the Feishu home channel is the owner's own direct chat (the
account's open_id), and Desktop stops this gateway each time APEX quits, so every quit put
「⚠️ APEX 正在关闭，手上的事会被打断……」 into the owner's own chat, also when nothing was running.

Upstream already has a quiet stop: a drain marker with ``suppress_notification`` leaves out ONLY the
home-channel broadcast. The notice to a chat whose task is running, the reply to an in-chat
``/restart`` and the interrupted-cron notices stay. This seam makes every stop of Desktop's
messaging gateway quiet in that sense. It writes no marker: on macOS a marker carries no
instantiation epoch, so one left behind would hold the next launch in ``draining`` for up to an hour.

Desktop marks the gateway it spawns with ``ENV_NAME`` (apps/desktop/electron/apex-gateway.ts
``GATEWAY_RUN_ENV``). The mark is read once, when the seam applies (plugin discovery at boot):
without it nothing is patched, so a cloud container or any gateway Desktop did not start keeps
upstream's behaviour. The home channel itself stays configured; scheduled-task delivery uses it.

Patch point: ``gateway.drain_control.drain_notification_suppressed``, which the shutdown path
imports at call time and reads only there (``tests/apex_overlay/test_desktop_quiet_quit.py``
counts its callers). Armed with ``post_import.when_imported``, so plugin discovery never imports
a gateway module (hc-989). Upstream files stay untouched.
"""

from __future__ import annotations

import functools
import logging
import os
from types import ModuleType

from apex_overlay import post_import

logger = logging.getLogger(__name__)

ENV_NAME = "APEX_DESKTOP_MESSAGING_GATEWAY"

_TARGET_MODULE = "gateway.drain_control"
_TARGET = "drain_notification_suppressed"
_MARK = "_apex_desktop_quiet_quit"


def desktop_gateway() -> bool:
    """True in the messaging gateway APEX Desktop spawned."""
    return os.environ.get(ENV_NAME, "").strip() == "1"


def _install(module: ModuleType) -> bool:
    original = getattr(module, _TARGET, None)
    if original is None:
        logger.error("apex-overlay: %s has no %s to patch", _TARGET_MODULE, _TARGET)
        return False
    if getattr(original, _MARK, False):
        return True

    @functools.wraps(original)
    def quiet_on_desktop(*_args, **_kwargs) -> bool:
        logger.info(
            "Home-channel shutdown broadcast left out: APEX Desktop's messaging gateway stops quietly; "
            "chats with a running task are still told"
        )
        return True

    setattr(quiet_on_desktop, _MARK, True)
    setattr(module, _TARGET, quiet_on_desktop)
    return True


def apply() -> bool:
    if not desktop_gateway():
        return True
    return post_import.when_imported(_TARGET_MODULE, _install)
