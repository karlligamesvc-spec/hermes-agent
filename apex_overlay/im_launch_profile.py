"""hc-1171 the IM 入口's Feishu and WeChat apps belong to the profile the process was started for.

Desktop binds Feishu and WeChat for the signed-in account and hands each app's credentials, and who
may talk to it, to the engines and the messaging gateway it spawns through their environment only
(``IM_ENV_NAMES``; hc-417 keeps them out of every ``.env``). With one assistant that is all the
gateway needs. With two or more profiles the gateway multiplexes: it loads each profile's platform
config inside that profile's own secret scope, built from the profile's files alone, and a name the
scope lacks never falls back to the process environment. So no profile configured Feishu or WeChat
and the bound bot never connected (reproduced 2026-11-07: one profile, both enabled; two, neither).

This seam gives those names back to the profile they belonged to with one assistant: the one the
process was started for (its launch home; for the gateway, the profile Desktop started it for).

- That profile's own value (its ``.env``, secret sources, managed env) still wins.
- No other profile's scope changes, so exactly one adapter connects to each app and its messages
  reach that one profile. Serving the IM from several assistants is a separate decision (L11–L18).

Only under multiplex semantics: a process serving one profile reads the process environment on a
miss already, so nothing changes there.
"""

from __future__ import annotations

import functools
import logging
import os
import threading
from collections.abc import MutableMapping
from pathlib import Path
from types import ModuleType

from apex_overlay import post_import

logger = logging.getLogger(__name__)

#: Everything Desktop injects for the IM 入口: the Feishu app (apex-feishu.ts) and the channel
#: bindings (apex-im-entry.ts CHANNEL_ENV_DESCRIPTORS), allowlists and home channels included.
#: apps/desktop/electron/apex-im-launch-profile.test.ts turns red when Desktop injects another.
IM_ENV_NAMES = (
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_DOMAIN",
    "FEISHU_ALLOWED_USERS",
    "FEISHU_HOME_CHANNEL",
    "WEIXIN_ACCOUNT_ID",
    "WEIXIN_TOKEN",
    "WEIXIN_BASE_URL",
    "WEIXIN_DM_POLICY",
    "WEIXIN_ALLOWED_USERS",
    "WEIXIN_HOME_CHANNEL",
)

_SCOPE_MODULE = "agent.secret_scope"
_MARK = "_apex_im_launch_profile"

_lock = threading.Lock()
_launch: dict[str, str] | None = None
_announced: set[str] = set()


def launch_values() -> dict[str, str]:
    """The IM names as this process had them when the seam was first applied (plugin discovery, at
    boot). ``reload.env`` later deletes a declared name its ``.env`` lacks from ``os.environ``."""
    global _launch
    with _lock:
        if _launch is None:
            _launch = {name: os.environ[name] for name in IM_ENV_NAMES if os.environ.get(name)}
        return dict(_launch)


def im_values() -> dict[str, str]:
    """Each IM name's live value, else the one the process was started with."""
    started_with = launch_values()
    values = {}
    for name in IM_ENV_NAMES:
        value = os.environ.get(name) or started_with.get(name)
        if value:
            values[name] = value
    return values


def _launch_home_under_multiplex(module: ModuleType, hermes_home) -> bool:
    if not module.is_multiplex_active():  # one profile here: a miss reads the process environment already
        return False
    return module._is_process_home(Path(hermes_home))


def _fill(scope: MutableMapping[str, str], hermes_home) -> None:
    added = []
    for name, value in im_values().items():
        if name not in scope:
            scope[name] = value
            added.append(name)
    key = str(hermes_home)
    if added and key not in _announced:
        _announced.add(key)
        from hermes_constants import profile_name_for_home

        logger.info("apex-overlay: the IM 入口's %s belong to profile %s, the one this process was started for",
                    ", ".join(added), profile_name_for_home(hermes_home) or "?")


def _install_scope_builder(module: ModuleType) -> bool:
    build = getattr(module, "build_profile_secret_scope", None)
    if build is None or not hasattr(module, "_is_process_home") or not hasattr(module, "is_multiplex_active"):
        return False
    if getattr(build, _MARK, False):
        return True

    @functools.wraps(build)
    def build_with_im(hermes_home):
        scope = build(hermes_home)
        try:
            if _launch_home_under_multiplex(module, hermes_home):
                _fill(scope, hermes_home)
        except Exception:
            logger.debug("apex-overlay: could not add the IM 入口's credentials to a scope", exc_info=True)
        return scope

    setattr(build_with_im, _MARK, True)
    module.build_profile_secret_scope = build_with_im
    return True


def apply() -> bool:
    """Freeze the IM names as this process started, then arm the patch."""
    launch_values()
    return post_import.when_imported(_SCOPE_MODULE, _install_scope_builder)
