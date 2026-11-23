"""hc-1275: the assistant's own installs of third-party code wait for the user's approval.

What this changes
=================
The upstream approval engine (``tools/approval_detection.py``) is a denylist. It asks before
``hermes gateway stop|restart`` and ``hermes update``, but has no rule for the commands that put
third-party code on the machine and switch it on:

- ``hermes plugins install|update|enable|adopt|trust-update-url``, ``plugins pack install``,
  ``plugins auto-update on`` and ``plugins validate --install-deps``: a catalog entry, a GitHub
  repo or any Git URL, whose code runs inside Hermes once it is enabled;
- ``hermes skills install|update``, ``skills tap add`` and ``skills snapshot import``: hub skills,
  any SKILL.md URL, and the upstream optional skills APEX keeps out of its default set;
- ``hermes mcp add|install``: a server whose tools the assistant then calls (Hermes itself
  starts a stdio one);
- ``hermes config set|unset`` on ``approvals``, ``command_allowlist``, ``plugins``, ``skills``,
  ``mcp_servers`` or ``agent.disabled_toolsets``: the same switches written as settings, including
  the approval policy itself (``hermes config set approvals.mode off``). The file tools already
  refuse to write config.yaml and a shell redirect into it already asks; ``config set`` did not.

Under ``approvals.mode: manual`` (APEX Desktop) the assistant could run every one of them from the
terminal tool without asking. On 2026-11-22 ``detect_dangerous_command`` returned False for
``hermes plugins install kinocut --enable --yes-deps``.

This seam appends one rule per command family to ``DANGEROUS_PATTERNS_COMPILED``. It changes only
which commands need consent; each surface's own policy still decides what consent means:

- APEX Desktop (``manual``): the approval card it already draws for ``approval.request``;
- ``approvals.mode: off`` (cloud native agents): nothing changes, the gate is off;
- unattended runs (cron and the like): their configured deny/approve mode
  (``tools.approval._unattended_deny``).

The user's own installs never pass through the assistant's approval gate: the Plugins page in
Desktop's developer mode, and a terminal the user types in.

Limits
======
A rule on command text slows the assistant down; it is not a boundary. A script file
(``python3 x.py``) or ``browser_exec`` reaches the same installers without a prompt. Quoted prose
that names one of these commands (``grep -rn "hermes plugins install" docs/``) asks too, as
upstream's own ``hermes gateway restart`` rule does: scanning a quote-masked variant instead would
also let ``hermes "plugins" install x`` and ``eval "hermes plugins install x"`` through.

The three install descriptions say "third-party": that word is how the Desktop approval sentence
picks its install warning (``RISKS`` in apps/desktop/src/components/assistant-ui/process/step-intent.ts).
The settings one does not, so its card keeps the plain sentence.
"""

from __future__ import annotations

import importlib
import logging
import re

logger = logging.getLogger(__name__)

_TARGET_MODULE = "tools.approval_detection"
_TARGET_LIST = "DANGEROUS_PATTERNS_COMPILED"

# `hermes`, `hermes.exe` or `python -m hermes_cli[.main]`, then at most four global-option tokens
# before the subcommand (`-p work`, `--profile=work`, `-v`). The engine matches lowercased variants.
_HERMES = r"(?:\bhermes(?:\.exe)?|\bhermes_cli(?:\.main)?)\s+(?:[^\s;&|]+\s+){0,4}?"

PLUGIN_DESCRIPTION = "install, update or enable a third-party Hermes plugin (its code runs inside Hermes)"
SKILL_DESCRIPTION = "install or update a third-party Hermes skill (from a hub, a repo or a URL)"
MCP_DESCRIPTION = "add a third-party MCP server (the assistant can then call its tools)"
SETTINGS_DESCRIPTION = "change the Hermes settings that turn approvals, plugins, skills or MCP servers on or off"

# Setting keys that switch code or the approval policy; `agent.*` only for its toolset list.
_SWITCH_KEYS = r"(?:approvals|command_allowlist|plugins|skills|mcp_servers|agent\.disabled_toolsets)\b"

INSTALL_RULES = (
    (
        _HERMES + r"plugins\s+(?:install|update|enable|adopt|trust-update-url|pack\s+install|auto-?update\s+on)\b"
        r"|" + _HERMES + r"plugins\s+validate\b[^;&|\n]*\s--install-deps\b",
        PLUGIN_DESCRIPTION,
    ),
    (_HERMES + r"skills\s+(?:install|update|tap\s+add|snapshot\s+import)\b", SKILL_DESCRIPTION),
    (_HERMES + r"mcp\s+(?:add|install)\b", MCP_DESCRIPTION),
    (_HERMES + r"config\s+(?:set|unset)\s+(?:-\S+\s+)*[\"']?" + _SWITCH_KEYS, SETTINGS_DESCRIPTION),
)


def apply() -> bool:
    """Append each rule once; False (logged) when the upstream rule list is gone."""
    try:
        module = importlib.import_module(_TARGET_MODULE)
    except ImportError:
        logger.exception("apex-overlay: hc-1275 could not import %s", _TARGET_MODULE)
        return False
    rules = getattr(module, _TARGET_LIST, None)
    if not isinstance(rules, list):
        logger.error("apex-overlay: hc-1275 %s.%s is missing or not a list", _TARGET_MODULE, _TARGET_LIST)
        return False
    flags = getattr(module, "_RE_FLAGS", re.IGNORECASE | re.DOTALL)
    present = {description for _, description in rules}
    for pattern, description in INSTALL_RULES:
        if description not in present:
            rules.append((re.compile(pattern, flags), description))
    return True
