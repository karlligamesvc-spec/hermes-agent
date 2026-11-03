"""hc-1103 身份和版本说 APEX 的话: who the engine says it is and which version it reports, on APEX surfaces.

hc-1095 made Desktop's single-thread mode answer version questions with the APEX version and replaced
the engine's "You run on Hermes Agent (by Nous Research)" help line there. These exits still spoke as the
open-source engine:

* ``DEFAULT_AGENT_IDENTITY`` ("You are Hermes Agent, built by Nous Research. Be direct: ..."): the
  identity of every prompt that has no SOUL.md, which is every subagent, the background skill curator and
  a session whose SOUL.md is blank. Its first sentence becomes APEX's, the one Desktop's own SOUL.md
  starts with (apps/desktop/shared/apex-default-soul.ts); the behavior rules after it stay upstream's
  word for word;
* the help line in a cloud container's prompt (Desktop's single-thread mode already has hc-1095's APEX
  line; the cloud gets the same one);
* ``/version`` in IM, from the Desktop-hosted gateway and the cloud gateway (``hermes_cli.slash_exec``);
* ``/version`` typed in Desktop and ``hermes --version`` run by the agent's own terminal commands: both
  print through ``hermes_cli._startup_fast.print_fast_version_info``, which asks
  :func:`desktop_version_reply` first (hooked in place: ``hermes --version`` prints before any plugin
  loads);
* the realtime voice persona ("You are Hermes, a calm and friendly voice assistant", tools/voice_live.py,
  hooked in place: the web server that starts a voice session never loads plugins).

Two surfaces say APEX. Desktop's single-thread mode (``APEX_SINGLE_THREAD_ACTIVE=1``, settled by Desktop's
main process before the engine starts and inherited by its IM gateway, slash worker, web server and the
agent's terminal commands) gets all of the above; ``/version`` there reads Desktop's version mirror
(apex_overlay/desktop_version.py). A cloud container (``HERMES_MANAGED_RUNTIME=1``, set in the image) gets
the identity, the help line and an IM ``/version`` naming its 运行版本 and where to change it; its
``hermes --version`` stays the engine's own, because only operators can run it there (hosted agents have no
terminal tool). Anywhere else (Desktop with single-thread mode off, a plain engine) nothing is patched and
every exit reads byte for byte as upstream's (tests/apex_overlay/__identity__/hc1103).

The identity a session reads from SOUL.md is not this seam's: Desktop's main process swaps an untouched
upstream SOUL.md for APEX's (hc-1042), and apex-nodes writes the cloud one.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Callable, Optional

from apex_overlay import desktop_version, post_import
from apex_overlay.single_thread_prompt import switch_on

logger = logging.getLogger(__name__)

DESKTOP = "desktop"
CLOUD = "cloud"
MANAGED_ENV = "HERMES_MANAGED_RUNTIME"
_TRUE_ENV = frozenset({"1", "true", "yes", "on"})

UPSTREAM_IDENTITY = "You are Hermes Agent, built by Nous Research."
# The first sentence of APEX Desktop's own SOUL.md.
APEX_IDENTITY = "You are APEX, an intelligent AI assistant from ApexNodes HK."

DESKTOP_VERSION_UNKNOWN = "APEX 的版本号这边读不到；可以到 设置 › 个性化 看版本号，点「立即检查」看有没有新版。"
CLOUD_VERSION = (
    "APEX 云端助手 · 运行版本 {release}\n"
    "运行版本由 APEX 平台管理，不需要你自己升级；想换版本，登录 apex-nodes.com，在「我的 AI 助手」里点开这个助手，"
    "到「运行版本」里选。"
)
CLOUD_VERSION_NO_RELEASE = (
    "APEX 云端助手\n"
    "运行版本由 APEX 平台管理，不需要你自己升级；想看或换版本，登录 apex-nodes.com，在「我的 AI 助手」里点开这个助手，"
    "到「运行版本」里看。"
)

# (upstream words, APEX words) in the realtime voice persona; each must occur exactly once.
VOICE_RENAMES = (
    ("You are Hermes, a calm and friendly voice assistant.", "You are APEX, a calm and friendly voice assistant."),
    ("- Hermes agent: a full AI agent with tools", "- APEX agent: a full AI agent with tools"),
)

_IDENTITY_MODULE = "agent.system_prompt"
_SLASH_MODULE = "hermes_cli.slash_exec"
_MARK = "_apex_identity_version"


def managed_runtime() -> bool:
    return os.environ.get(MANAGED_ENV, "").strip().lower() in _TRUE_ENV


def surface() -> Optional[str]:
    """``"desktop"`` in Desktop's single-thread mode, ``"cloud"`` in a hosted container, else None."""
    if switch_on():
        return DESKTOP
    return CLOUD if managed_runtime() else None


def desktop_version_reply() -> Optional[str]:
    """What ``/version`` and ``hermes --version`` print in Desktop's single-thread mode; None elsewhere."""
    if not switch_on():
        return None
    state = desktop_version.read_state()
    if state is None:
        return DESKTOP_VERSION_UNKNOWN
    return f"{desktop_version.version_line(state)}\n更新：{desktop_version.update_sentence(state)}"


def cloud_version_reply() -> Optional[str]:
    """What IM ``/version`` says in a hosted container; None elsewhere."""
    if not managed_runtime():
        return None
    try:
        from hermes_cli import __release_date__ as release
    except ImportError:
        release = None
    return CLOUD_VERSION.format(release=release) if isinstance(release, str) and release else CLOUD_VERSION_NO_RELEASE


def version_reply() -> Optional[str]:
    return desktop_version_reply() or cloud_version_reply()


def apex_live_persona(persona: str) -> str:
    """The realtime voice persona with APEX's name in Desktop's single-thread mode; ``persona`` elsewhere."""
    if not switch_on():
        return persona
    if any(persona.count(old) != 1 for old, _ in VOICE_RENAMES):
        logger.error("apex-overlay: the voice persona's Hermes lines moved; the persona keeps upstream's name")
        return persona
    for old, new in VOICE_RENAMES:
        persona = persona.replace(old, new)
    return persona


def _install_identity(module: Any) -> bool:
    current = getattr(module, "DEFAULT_AGENT_IDENTITY", None)
    if isinstance(current, str) and current.startswith(APEX_IDENTITY):
        return True
    if not isinstance(current, str) or current.count(UPSTREAM_IDENTITY) != 1:
        logger.error("apex-overlay: %s.DEFAULT_AGENT_IDENTITY no longer names Hermes Agent once; it stays", _IDENTITY_MODULE)
        return False
    module.DEFAULT_AGENT_IDENTITY = current.replace(UPSTREAM_IDENTITY, APEX_IDENTITY)
    return True


def _install_version_command(module: Any) -> bool:
    executors = getattr(module, "EXECUTORS", None)
    upstream: Optional[Callable] = executors.get("version") if isinstance(executors, dict) else None
    reply_type = getattr(module, "CommandReply", None)
    if not callable(upstream) or reply_type is None:
        logger.error("apex-overlay: %s has no version executor; /version keeps the engine's banner", _SLASH_MODULE)
        return False
    if getattr(upstream, _MARK, False):
        return True

    def version(ctx: Any) -> Any:
        text = version_reply()
        return reply_type(text) if text else upstream(ctx)

    setattr(version, _MARK, True)
    executors["version"] = version
    return True


def apply() -> bool:
    """Patch the identity, the cloud help line and IM ``/version``, only on an APEX surface.

    Both switches are settled before the engine starts, so off an APEX surface nothing is patched.
    """
    where = surface()
    if where is None:
        return True
    # Never imported here: plugin discovery may run while these modules are still importing.
    ok = post_import.when_imported(_IDENTITY_MODULE, _install_identity)
    if where == CLOUD:
        ok = post_import.when_imported(_IDENTITY_MODULE, desktop_version.install_help_guidance) and ok
    return post_import.when_imported(_SLASH_MODULE, _install_version_command) and ok
