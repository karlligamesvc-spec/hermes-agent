"""hc-1169 a cron job fires with the signed-in account's credentials, in every Desktop process.

APEX Desktop puts the account's credentials (``ACCOUNT_ENV_NAMES``: the platform tools' key and
endpoints, web search and extraction, the Feishu and WeChat apps of the IM 入口) into the environment of every
engine it spawns and of the messaging gateway; no assistant's ``.env`` holds them. A cron fire runs
under the firing profile's secret scope, built from that profile's files alone
(``cron.scheduler._install_fire_secret_scope``: its ``.env``, secret sources and managed env). Once a
process serves several profiles (several assistants: the Desktop backend activates multi-profile
hosting at boot, the messaging gateway multiplexes) a name missing from that scope never falls back
to the process environment (``agent.secret_scope.get_secret``). So every cron job, APEX's own
included, lost them, whichever process fired it and whatever the single-engine switch says: web
search fell back to a keyless backend while the reply still looked fine (seen live on 2026-11-07),
and a platform tool or a Feishu / WeChat delivery had no credential at all.

This seam adds the account's names to a cron fire's scope, with the precedence an engine of its own
gives an assistant:

- the profile's own value (its ``.env``, secret sources, managed env) wins;
- a value any ``.env`` loaded into this process is that profile's, never the account's;
- who may talk to an assistant (``PER_ASSISTANT_GATES``) stays each assistant's own policy.

Two patch points, both only while a fire runs under multiplex semantics:

1. ``cron.scheduler._install_fire_secret_scope``: once upstream has installed the fire's scope (and,
   for a fire routed to another profile, switched multiplex semantics on for its span), the names go
   into that mapping, which spans the run and its delivery.
2. ``agent.secret_scope.build_profile_secret_scope``: a scope built while a cron execution runs
   carries them too. ``refresh_installed_secret_scope`` replaces the fire's mapping with such a
   rebuild after a plugin discovery, and children the fire spawns for a profile (served workers, MCP
   adoption, kanban) build theirs the same way.

A process serving one profile reads the process environment on a miss already: nothing is added
there, and nothing outside a cron fire changes. In particular the messaging gateway's platform
config and turn scopes stay as they are, so no profile starts a second adapter for the account's
Feishu or WeChat app.
"""

from __future__ import annotations

import functools
import logging
import os
import sys
import threading
from collections.abc import MutableMapping
from types import ModuleType

from apex_overlay import post_import

logger = logging.getLogger(__name__)

#: The credentials and endpoints Desktop injects into every engine and messaging gateway it spawns
#: that belong to the signed-in account (or this machine), not to one assistant: the platform tools
#: (apex-platform-tools.ts PLATFORM_TOOL_ENV_KEYS), web search and web extraction (backend-env.ts),
#: the Feishu app (apex-feishu.ts) and the IM 入口 bindings (apex-im-entry.ts CHANNEL_ENV_DESCRIPTORS).
#: apps/desktop/electron/apex-cron-account-env.test.ts reads both tuples and turns red when Desktop
#: injects a name neither lists.
ACCOUNT_ENV_NAMES = (
    "TOOLS_GATEWAY_KEY",
    "TOOLS_GATEWAY_BASE",
    "HERMES_PLATFORM_API_BASE",
    "SEARXNG_URL",
    "SEARXNG_API_KEY",
    "FIRECRAWL_API_URL",
    "FIRECRAWL_API_KEY",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_DOMAIN",
    "FEISHU_HOME_CHANNEL",
    "WEIXIN_ACCOUNT_ID",
    "WEIXIN_TOKEN",
    "WEIXIN_BASE_URL",
    "WEIXIN_HOME_CHANNEL",
)

#: Injected by Desktop too, but who may talk to an assistant is that assistant's policy: never added.
PER_ASSISTANT_GATES = ("FEISHU_ALLOWED_USERS", "WEIXIN_ALLOWED_USERS", "WEIXIN_DM_POLICY")

_CRON_MODULE = "cron.scheduler"
_SCOPE_MODULE = "agent.secret_scope"
_MARK = "_apex_cron_account_env"

_launch_lock = threading.Lock()
_launch: dict[str, str] | None = None


def launch_values() -> dict[str, str]:
    """The account's names as this process had them when the seam was first applied (plugin
    discovery, at boot). ``reload.env`` later deletes a declared name its ``.env`` lacks from
    ``os.environ``, and the account's names are declared ones."""
    global _launch
    with _launch_lock:
        if _launch is None:
            _launch = {name: os.environ[name] for name in ACCOUNT_ENV_NAMES if os.environ.get(name)}
        return dict(_launch)


def account_values() -> dict[str, str]:
    """What this process can lend a cron fire: each name's live value, else the one it was started
    with; never a name any ``.env`` loaded into this process, whose value is that profile's own."""
    from hermes_cli.env_loader import launch_dotenv_keys

    loaded = launch_dotenv_keys()
    started_with = launch_values()
    values = {}
    for name in ACCOUNT_ENV_NAMES:
        if name in loaded:
            continue
        value = os.environ.get(name) or started_with.get(name)
        if value:
            values[name] = value
    return values


def fill(scope: MutableMapping[str, str]) -> list[str]:
    """Add the account's names ``scope`` has no value of its own for; returns the names added."""
    added = []
    for name, value in account_values().items():
        if name not in scope:
            scope[name] = value
            added.append(name)
    return added


def _multiplexed_cron_execution() -> bool:
    """A cron execution is running in this context under multiplex semantics."""
    identity = sys.modules.get("cron.execution_identity")
    if identity is None:  # no fire has started in this process; never import cron from here
        return False
    from agent.secret_scope import is_multiplex_active

    return identity.current_cron_execution() is not None and is_multiplex_active()


def _fill_installed_fire_scope() -> None:
    from agent.secret_scope import current_secret_scope, current_secret_scope_home, is_multiplex_active
    from hermes_constants import profile_name_for_home

    if not is_multiplex_active():  # one profile here: a miss reads the process environment already
        return
    scope = current_secret_scope()
    if not isinstance(scope, MutableMapping):
        logger.warning("apex-overlay: cron fire scope is read-only; the account's credentials were not added")
        return
    added = fill(scope)
    if added:
        logger.info("apex-overlay: cron fire for profile %s gets the account's %s",
                    profile_name_for_home(current_secret_scope_home()) or "?", ", ".join(added))


def _install_fire_scope(module: ModuleType) -> bool:
    install = getattr(module, "_install_fire_secret_scope", None)
    if install is None:
        return False
    if getattr(install, _MARK, False):
        return True

    @functools.wraps(install)
    def install_with_account():
        tokens = install()
        try:
            _fill_installed_fire_scope()
        except Exception:  # a credential we could not add must not cost the fire
            logger.warning("apex-overlay: could not add the account's credentials to a cron fire", exc_info=True)
        return tokens

    setattr(install_with_account, _MARK, True)
    module._install_fire_secret_scope = install_with_account
    return True


def _install_scope_builder(module: ModuleType) -> bool:
    build = getattr(module, "build_profile_secret_scope", None)
    if build is None:
        return False
    if getattr(build, _MARK, False):
        return True

    @functools.wraps(build)
    def build_with_account(hermes_home):
        scope = build(hermes_home)
        try:
            if _multiplexed_cron_execution():
                fill(scope)
        except Exception:
            logger.debug("apex-overlay: could not add the account's credentials to a cron scope", exc_info=True)
        return scope

    setattr(build_with_account, _MARK, True)
    module.build_profile_secret_scope = build_with_account
    return True


def apply() -> bool:
    """Freeze the account's values as this process started, then arm both patches."""
    launch_values()
    ok = post_import.when_imported(_SCOPE_MODULE, _install_scope_builder)
    return post_import.when_imported(_CRON_MODULE, _install_fire_scope) and ok
