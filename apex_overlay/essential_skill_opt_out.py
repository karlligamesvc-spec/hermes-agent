"""hc-1275: an essential skill that config.yaml lists in ``skills.disabled`` is off everywhere, not only in skill_view.

The engine pins ``hermes-agent`` (its own operating manual) as essential. ``agent/skill_utils.py``
``get_disabled_skill_names()`` subtracts ``ESSENTIAL_SKILLS`` from the configured lists, and so do the
Settings page's reader and writer (``hermes_cli/skills_config.py``). ``tools/skills_tool.py``
``_is_skill_disabled`` does not subtract, so ``skill_view`` refuses the skill. APEX Desktop lists
``hermes-agent`` among its default-off skills (hc-392, hc-406), and a fresh Desktop session showed the
split: the skill index listed "- hermes-agent: Use, configure, theme, extend, and orchestrate Hermes
Agent.", skill_view refused it and pointed the model at ``hermes skills`` and the files on disk, and with
single-thread mode off the engine's help line told the model to load it. The choice was between letting
Desktop load the upstream manual and not listing it; hc-1275 takes the second.

What changes, only for an essential name that config.yaml lists itself (in the global ``skills.disabled``
list, or the session platform's ``skills.platform_disabled`` list: the two lists the refusal reads):

* ``get_disabled_skill_names`` returns it. That covers the function in ``agent.skill_utils`` (looked up at
  call time by skills_tool, skill_commands, the gateways and the CLI) and the copies ``agent.prompt_builder``
  and ``agent.curator`` bound at import. So the skill index, ``skills_list``, the ``/<skill>`` commands and
  the IM gateway's per-platform list leave it out. With it gone from the index, the system prompt keeps
  the help line that does not point at skill_view (agent/system_prompt.py decides from the index); in
  single-thread mode the APEX line stays either way.
* ``hermes_cli.skills_config.get_disabled_skills`` reports it, and ``save_disabled_skills`` keeps it when
  the set it is given has it. The Settings page then shows it off, and toggling another skill there no
  longer drops it from config.yaml.

Nothing changes where no list names an essential skill. The cloud's list (apex-nodes
``app/services/hosted_skill_grading.py``) leaves ``hermes-agent`` out on purpose, so cloud agents keep the
engine's behaviour. ``ESSENTIAL_SKILLS`` itself is untouched: skills_sync still installs the files and
skill_manage still refuses to delete them.
"""

from __future__ import annotations

import functools
import logging
import os
import sys
import types
from typing import Any, Optional

from apex_overlay import post_import

logger = logging.getLogger(__name__)

_SKILL_UTILS = "agent.skill_utils"
_BOUND_COPIES = ("agent.prompt_builder", "agent.curator")
_SKILLS_CONFIG = "hermes_cli.skills_config"
_ORIGINAL = "__apex_essential_opt_out_original__"
_NEEDED_IN_SKILL_UTILS = ("get_disabled_skill_names", "_skills_cfg", "_normalize_string_set", "ESSENTIAL_SKILLS")
_NEEDED_IN_SKILLS_CONFIG = ("get_disabled_skills", "save_disabled_skills", "_normalize_skill_names", "cfg_get",
                            "save_config")


def _missing(module: types.ModuleType, names: tuple[str, ...]) -> bool:
    absent = [name for name in names if not hasattr(module, name)]
    if absent:
        logger.error("apex-overlay: %s has no %s; an essential skill listed in skills.disabled stays listed",
                     module.__name__, ", ".join(absent))
    return bool(absent)


def _listed_essentials(skill_utils: types.ModuleType, platform: Optional[str]) -> set[str]:
    """The essential names config.yaml lists, read the way ``get_disabled_skill_names`` reads its lists."""
    skills_cfg = skill_utils._skills_cfg()
    if skills_cfg is None:
        return set()
    from gateway.session_context import get_session_env

    resolved = platform or os.getenv("HERMES_PLATFORM") or get_session_env("HERMES_SESSION_PLATFORM")
    listed = skill_utils._normalize_string_set(skills_cfg.get("disabled"))
    platform_listed = (skills_cfg.get("platform_disabled") or {}).get(resolved) if resolved else None
    if platform_listed is not None:
        listed |= skill_utils._normalize_string_set(platform_listed)
    return listed & skill_utils.ESSENTIAL_SKILLS


def _patch_skill_utils(skill_utils: types.ModuleType) -> bool:
    if _missing(skill_utils, _NEEDED_IN_SKILL_UTILS):
        return False
    original = skill_utils.get_disabled_skill_names
    if getattr(original, _ORIGINAL, None) is not None:
        return True

    @functools.wraps(original)
    def get_disabled_skill_names(platform: Optional[str] = None) -> set[str]:
        return original(platform) | _listed_essentials(skill_utils, platform)

    setattr(get_disabled_skill_names, _ORIGINAL, original)
    skill_utils.get_disabled_skill_names = get_disabled_skill_names
    return True


def _rebind_copy(module: types.ModuleType) -> bool:
    """A module that bound ``get_disabled_skill_names`` at import gets the patched one."""
    skill_utils = sys.modules.get(_SKILL_UTILS)
    patched = getattr(skill_utils, "get_disabled_skill_names", None)
    if getattr(patched, _ORIGINAL, None) is None:
        logger.error("apex-overlay: %s is not patched, so %s keeps the engine's list", _SKILL_UTILS, module.__name__)
        return False
    if _missing(module, ("get_disabled_skill_names",)):
        return False
    module.get_disabled_skill_names = patched
    return True


def _config_listed_essentials(skills_config: types.ModuleType, config: dict, platform: Optional[str]) -> set[str]:
    """The essential names a loaded config lists, read the way ``get_disabled_skills`` reads them."""
    skills_cfg = config.get("skills") or {}
    if not isinstance(skills_cfg, dict):
        return set()
    from agent.skill_utils import ESSENTIAL_SKILLS

    listed = skills_config._normalize_skill_names(skills_cfg.get("disabled"))
    if platform is not None:
        platform_listed = skills_config.cfg_get(skills_cfg, "platform_disabled", platform)
        if platform_listed is not None:
            listed |= skills_config._normalize_skill_names(platform_listed)
    return listed & ESSENTIAL_SKILLS


def _patch_skills_config(skills_config: types.ModuleType) -> bool:
    if _missing(skills_config, _NEEDED_IN_SKILLS_CONFIG):
        return False
    read = skills_config.get_disabled_skills
    if getattr(read, _ORIGINAL, None) is None:

        @functools.wraps(read)
        def get_disabled_skills(config: dict, platform: Optional[str] = None) -> set[str]:
            return read(config, platform) | _config_listed_essentials(skills_config, config, platform)

        setattr(get_disabled_skills, _ORIGINAL, read)
        skills_config.get_disabled_skills = get_disabled_skills
    write = skills_config.save_disabled_skills
    if getattr(write, _ORIGINAL, None) is None:

        @functools.wraps(write)
        def save_disabled_skills(config: dict, disabled: set[str], platform: Optional[str] = None) -> None:
            write(config, disabled, platform)  # the engine's save, which drops essential names
            from agent.skill_utils import ESSENTIAL_SKILLS

            kept = {str(name).strip() for name in disabled} & ESSENTIAL_SKILLS
            if not kept:
                return
            skills_cfg = config["skills"]
            owner: Any = skills_cfg if platform is None else skills_cfg["platform_disabled"]
            key = "disabled" if platform is None else platform
            owner[key] = sorted(set(owner.get(key) or []) | kept)
            skills_config.save_config(config)

        setattr(save_disabled_skills, _ORIGINAL, write)
        skills_config.save_disabled_skills = save_disabled_skills
    return True


def apply() -> bool:
    """Arm every patch; each runs once its module has finished importing (nothing is imported here)."""
    results = [post_import.when_imported(_SKILL_UTILS, _patch_skill_utils)]
    results += [post_import.when_imported(name, _rebind_copy) for name in _BOUND_COPIES]
    results.append(post_import.when_imported(_SKILLS_CONFIG, _patch_skills_config))
    return all(results)
