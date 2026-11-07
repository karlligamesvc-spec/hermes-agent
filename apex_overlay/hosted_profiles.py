"""hc-1166 several assistants on one engine (Desktop): what one ``hermes serve`` that
hosts every assistant still owes the profiles it was not started as.

With several assistants on, every assistant is a Hermes profile. Desktop used to start
one ``hermes --profile <name> serve`` per assistant; with the single-engine switch
(``apps/desktop/electron/apex-single-engine.ts``) the primary engine, started as APEX's
root profile, hosts them all: each call names its ``profile`` and the engine binds that
profile's HERMES_HOME, secret scope and state.db for it (``tui_gateway`` ``_profile_home``).
Desktop settles ``APEX_MULTI_BOT_SINGLE_ENGINE=1`` into the engine's environment before
it spawns, and only then does this seam patch anything.

Two things upstream keeps on the launch profile, which an engine of its own used to give
each assistant:

1. **Account credentials Desktop injects at spawn** (``ACCOUNT_ENV_NAMES``): the platform
   tools' key and endpoints, web search, and the Feishu / WeChat apps of the IM 入口. A
   hosted profile's ``get_secret()`` never falls back to the process environment
   (``agent.secret_scope``), so web search, ChatCut's MCP entry, sending to Feishu or
   WeChat and cron delivery to their home channels would fail for every assistant but
   APEX. These names count as process-global for a profile, with the precedence an engine
   of its own gave it (``launch_secret_scope``: the profile's ``.env`` over the launch
   environment):

   - the profile's own value (its ``.env`` or secret sources) wins;
   - a value the launch profile's own ``.env`` loaded is APEX's, never shared;
   - the authorization gates (``PER_ASSISTANT_GATES``) are policy per assistant, never shared.

   ``reload.env`` deletes declared names its home's ``.env`` lacks from ``os.environ``, so
   a shared name missing there is read from the environment frozen when hosting started,
   which kept what Desktop injected.
2. **serve's hourly maintenance.** ``hermes_cli.web_server_sessions`` runs auto-archive
   and the skill curator for the launch profile only. Each hosted assistant profile gets
   the same pass inside its own scope.

Off (no switch, or not a Desktop-spawned backend) nothing is patched, so an engine per
assistant behaves exactly as before.
"""

from __future__ import annotations

import functools
import logging
import os
from contextlib import AbstractContextManager
from pathlib import Path
from types import ModuleType

from apex_overlay import post_import

logger = logging.getLogger(__name__)

#: The credentials and endpoints Desktop injects into every engine it spawns that belong to the
#: signed-in account (or this machine), not to one assistant: the platform tools
#: (apex-platform-tools.ts PLATFORM_TOOL_ENV_KEYS), web search (backend-env.ts), the Feishu app
#: (apex-feishu.ts) and the IM 入口 bindings (apex-im-entry.ts CHANNEL_ENV_DESCRIPTORS).
#: apps/desktop/electron/apex-single-engine-env.test.ts reads both tuples and turns red when
#: Desktop injects a name neither lists.
ACCOUNT_ENV_NAMES = (
    "TOOLS_GATEWAY_KEY",
    "TOOLS_GATEWAY_BASE",
    "HERMES_PLATFORM_API_BASE",
    "SEARXNG_URL",
    "SEARXNG_API_KEY",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_DOMAIN",
    "FEISHU_HOME_CHANNEL",
    "WEIXIN_ACCOUNT_ID",
    "WEIXIN_TOKEN",
    "WEIXIN_BASE_URL",
    "WEIXIN_HOME_CHANNEL",
)

#: Injected by Desktop too, but who may talk to an assistant is that assistant's policy, read only
#: by the messaging gateway's own process: never shared.
PER_ASSISTANT_GATES = ("FEISHU_ALLOWED_USERS", "WEIXIN_ALLOWED_USERS", "WEIXIN_DM_POLICY")

_SECRET_SCOPE_MODULE = "agent.secret_scope"
_MAINTENANCE_MODULE = "hermes_cli.web_server_sessions"
_MARK = "_apex_hosted_profiles"


def single_engine_active(env=None) -> bool:
    """A Desktop-spawned backend hosting several assistants (the switch main settled at launch)."""
    env = os.environ if env is None else env
    return env.get("HERMES_DESKTOP") == "1" and env.get("APEX_MULTI_BOT_SINGLE_ENGINE") == "1"


# ── 1. account credentials ──────────────────────────────────────────────────


def shared_account_name(name: str) -> bool:
    """Whether the process value of ``name`` is the account's: an account name no ``.env`` loaded."""
    if name not in ACCOUNT_ENV_NAMES:
        return False
    from hermes_cli.env_loader import launch_dotenv_keys

    return name not in launch_dotenv_keys()


def account_value(name: str) -> str:
    """For APEX code that reads a credential straight from the process environment only for the
    launch profile (``doubao_tts``, ``voice_realtime``): the account's ``name`` for a profile this
    engine hosts, ``''`` when several assistants do not share this engine or ``name`` is not shared."""
    if not single_engine_active() or not shared_account_name(name):
        return ""
    return os.environ.get(name) or ""


def _launch_value(module: ModuleType, name: str) -> str | None:
    """``name`` as the engine had it when it started hosting other profiles; None before that."""
    if not getattr(module, "_MULTIPLEX_ACTIVE", False):
        return None
    from tui_gateway.launch_profile_policy import capture_launch_env

    return capture_launch_env().get(name)


class _WithAccountNames(frozenset):
    """``_GLOBAL_ENV_EXACT`` that also counts a shared account name as process-global while the
    bound secret scope has no value of its own for it. ``_is_global_env`` reads
    ``_GLOBAL_ENV_EXACT`` at call time, so every reader sees this."""

    current_scope = staticmethod(lambda: None)

    def __contains__(self, name) -> bool:
        if frozenset.__contains__(self, name):
            return True
        if not shared_account_name(name):
            return False
        own = self.current_scope()
        return not (own and name in own)


def _install_account_env(module: ModuleType) -> bool:
    exact = getattr(module, "_GLOBAL_ENV_EXACT", None)
    current_scope = getattr(module, "current_secret_scope", None)
    environ_or = getattr(module, "_environ_or", None)
    if not isinstance(exact, frozenset) or current_scope is None or environ_or is None:
        return False
    if not isinstance(exact, _WithAccountNames):
        names = _WithAccountNames(exact)
        names.current_scope = current_scope
        module._GLOBAL_ENV_EXACT = names
    if not getattr(environ_or, _MARK, False):

        @functools.wraps(environ_or)
        def environ_or_launch(name: str, default):
            value = environ_or(name, None)
            if value is None and shared_account_name(name):
                value = _launch_value(module, name)
            return default if value is None else value

        setattr(environ_or_launch, _MARK, True)
        module._environ_or = environ_or_launch
    return True


# ── 2. maintenance for every hosted profile ─────────────────────────────────


def hosted_profiles() -> list[tuple[str, Path]]:
    """``(name, home)`` of every local profile this engine hosts besides the one it was started as."""
    from hermes_cli.profiles import profiles_to_serve
    from hermes_constants import get_process_hermes_home

    launch = Path(get_process_hermes_home()).resolve()
    return [(name, Path(home)) for name, home in profiles_to_serve(multiplex=True)
            if Path(home).resolve() != launch]


def profile_scope(home: Path) -> AbstractContextManager:
    """The home + secret + terminal scope a hosted profile's turn runs under: upstream's build scope as
    ``tui_gateway.server`` publishes it (the split module's own copy works only rebound there)."""
    from tui_gateway import server
    return server._profile_build_scope(home)


def _install_maintenance(module: ModuleType) -> bool:
    maintenance = getattr(module, "_maybe_run_skill_maintenance", None)
    archive = getattr(module, "_maybe_auto_archive_for_profile", None)
    if maintenance is None or archive is None:
        return False
    if getattr(maintenance, _MARK, False):
        return True

    @functools.wraps(maintenance)
    def every_profile(started_at: float) -> None:
        maintenance(started_at)
        for name, home in hosted_profiles():
            try:
                with profile_scope(home):
                    archive(name)
                    maintenance(started_at)
            except Exception:  # one assistant's broken home must not skip the others' maintenance
                logger.warning("apex-overlay: maintenance for hosted assistant %s skipped", name, exc_info=True)

    setattr(every_profile, _MARK, True)
    module._maybe_run_skill_maintenance = every_profile
    return True


def apply() -> bool:
    """Patch both seams when several assistants share this engine; a no-op (True) otherwise."""
    if not single_engine_active():
        return True
    ok = post_import.when_imported(_SECRET_SCOPE_MODULE, _install_account_env)
    return post_import.when_imported(_MAINTENANCE_MODULE, _install_maintenance) and ok
