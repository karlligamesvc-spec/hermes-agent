"""Registry of external coding-agent families the harness can drive.

One declarative row per family — ``{id, command, args, transport,
session_namespace, quirks}`` — is the single source of truth for how to launch
and speak to each agent. Launch is white-listed by this table (iron rule /
security §4): the harness only ever spawns ``spec.command + spec.args``; it
never interpolates user-supplied strings into a shell.

First wave (``launch=True``): ``claude``, ``codex``, ``cursor``.
``codebuddy`` is defined but ``launch=False`` — kept ready for a later wave,
not part of the first-wave surface (per hc-524 scope: "CodeBuddy 保留但不首发").

Transport assignment (per hc-524 "业界通道已定谳"):
  - ``claude``    → CLAUDE_STREAM_JSON  (Direct provider; ``--output-format stream-json``)
  - ``codex``     → CODEX_APP_SERVER    (Direct provider; ``codex app-server``)
  - ``cursor``    → ACP                 (``cursor-agent acp``)
  - ``codebuddy`` → ACP                 (``npx -y @tencent-ai/codebuddy-code --acp``)

The two Direct providers exist because Claude Code and Codex predate/sidestep
ACP with their own native streaming protocols; everyone else rides ACP.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field


class Transport(str, enum.Enum):
    """Wire protocol a family speaks over stdio."""

    ACP = "acp"  # Agent Client Protocol, JSON-RPC 2.0 over stdio
    CLAUDE_STREAM_JSON = "claude_stream_json"  # Claude Code newline-delimited stream-json
    CODEX_APP_SERVER = "codex_app_server"  # Codex app-server JSON-RPC over stdio


@dataclass(frozen=True, slots=True)
class AgentSpec:
    """How to launch and speak to one coding-agent family.

    ``command``/``args`` are the *only* thing the harness spawns — a fixed,
    audited allow-list entry, never assembled from caller input.
    """

    id: str
    display_name: str
    command: str
    args: tuple[str, ...]
    transport: Transport
    # Namespaces the family's session ids so a ``cursor`` session id can never
    # be mistaken for a ``codex`` thread id when persisted / round-tripped.
    session_namespace: str
    # Human install hint surfaced when the binary is missing.
    install_hint: str = ""
    # First-wave launch surface. False = defined-but-parked (codebuddy).
    launch: bool = True
    # Family-specific behavioural notes consumed by the driver (e.g. resume
    # flag name, min version). Free-form but documented per key at use sites.
    quirks: dict[str, str] = field(default_factory=dict)

    def launch_command(self) -> list[str]:
        """The exact argv the harness will spawn for this family."""
        return [self.command, *self.args]


# --- The table --------------------------------------------------------------
# NB: args are the ACP/Direct entry sub-commands proven against the acpx
# AGENT_REGISTRY. Do not append prompt text here — prompts flow over the wire
# (ACP session/prompt, codex turn/start) or as a per-call arg the driver adds
# (claude -p). This keeps launch white-listed.

_SPECS: tuple[AgentSpec, ...] = (
    AgentSpec(
        id="claude",
        display_name="Claude Code",
        command="claude",
        # Driver appends: -p <prompt> [--resume <session_id>]. --verbose is
        # required by Claude Code whenever --output-format stream-json is used
        # in print mode. We normalize from the authoritative per-message events
        # (system/assistant/user/result), so --include-partial-messages sub-
        # message deltas are deliberately not requested.
        args=("--output-format", "stream-json", "--verbose"),
        transport=Transport.CLAUDE_STREAM_JSON,
        session_namespace="claude",
        install_hint="npm install -g @anthropic-ai/claude-code",
        quirks={
            "resume_flag": "--resume",
            "prompt_flag": "-p",
            "min_version": "2",
            # Official ACP bridge exists but stream-json is the native, lower
            # dependency path we drive by default (npx @agentclientprotocol/claude-agent-acp).
            "acp_bridge": "npx -y @agentclientprotocol/claude-agent-acp",
        },
    ),
    AgentSpec(
        id="codex",
        display_name="Codex",
        command="codex",
        args=("app-server",),
        transport=Transport.CODEX_APP_SERVER,
        session_namespace="codex",
        install_hint="npm install -g @openai/codex",
        quirks={
            "min_version": "0.125.0",
            "acp_bridge": "codex-acp",
        },
    ),
    AgentSpec(
        id="cursor",
        display_name="Cursor Agent",
        command="cursor-agent",
        args=("acp",),
        transport=Transport.ACP,
        session_namespace="cursor",
        install_hint="curl https://cursor.com/install -fsS | bash",
    ),
    AgentSpec(
        id="codebuddy",
        display_name="CodeBuddy Code",
        command="npx",
        args=("-y", "@tencent-ai/codebuddy-code", "--acp"),
        transport=Transport.ACP,
        session_namespace="codebuddy",
        install_hint="npm install -g @tencent-ai/codebuddy-code",
        launch=False,  # defined, parked — not part of the first wave
    ),
)

AGENT_REGISTRY: dict[str, AgentSpec] = {spec.id: spec for spec in _SPECS}


def get_spec(family: str) -> AgentSpec:
    """Look up a family spec by id. Raises KeyError with the known ids."""
    try:
        return AGENT_REGISTRY[family]
    except KeyError:
        known = ", ".join(sorted(AGENT_REGISTRY))
        raise KeyError(f"unknown coding-agent family {family!r}; known: {known}") from None


def list_specs(*, launchable_only: bool = False) -> list[AgentSpec]:
    """All specs, or only the first-wave launchable ones."""
    specs = list(AGENT_REGISTRY.values())
    if launchable_only:
        specs = [s for s in specs if s.launch]
    return specs
