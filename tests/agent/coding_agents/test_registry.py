"""Registry contract: launch commands, transports, and first-wave gating."""

from __future__ import annotations

import pytest

from agent.coding_agents.registry import (
    AGENT_REGISTRY,
    Transport,
    get_spec,
    list_specs,
)

# family -> (command, args, transport, session_namespace, launch)
EXPECTED = {
    "claude": (
        "claude",
        ("--output-format", "stream-json", "--verbose"),
        Transport.CLAUDE_STREAM_JSON,
        "claude",
        True,
    ),
    "codex": (
        "codex",
        ("app-server",),
        Transport.CODEX_APP_SERVER,
        "codex",
        True,
    ),
    "cursor": (
        "cursor-agent",
        ("acp",),
        Transport.ACP,
        "cursor",
        True,
    ),
    "codebuddy": (
        "npx",
        ("-y", "@tencent-ai/codebuddy-code", "--acp"),
        Transport.ACP,
        "codebuddy",
        False,  # parked — not first wave
    ),
}


@pytest.mark.parametrize("family", sorted(EXPECTED))
def test_spec_matches_expected(family: str) -> None:
    command, args, transport, namespace, launch = EXPECTED[family]
    spec = get_spec(family)
    assert spec.command == command
    assert spec.args == args
    assert spec.transport == transport
    assert spec.session_namespace == namespace
    assert spec.launch is launch
    assert spec.launch_command() == [command, *args]


def test_registry_covers_exactly_the_four_families() -> None:
    assert set(AGENT_REGISTRY) == set(EXPECTED)


def test_launchable_only_excludes_parked_codebuddy() -> None:
    launchable = {s.id for s in list_specs(launchable_only=True)}
    assert launchable == {"claude", "codex", "cursor"}
    assert "codebuddy" not in launchable


def test_claude_and_codex_are_direct_others_acp() -> None:
    # Exactly the two Direct providers ride native protocols; the rest ACP.
    direct = {s.id for s in AGENT_REGISTRY.values() if s.transport != Transport.ACP}
    assert direct == {"claude", "codex"}


def test_no_prompt_text_baked_into_launch_args() -> None:
    # Launch is white-listed; prompts must not be pre-baked into argv.
    for spec in AGENT_REGISTRY.values():
        joined = " ".join(spec.args).lower()
        assert "prompt" not in joined
        assert "{" not in joined  # no interpolation placeholders


def test_get_spec_unknown_raises_with_known_ids() -> None:
    with pytest.raises(KeyError) as exc:
        get_spec("gemini")
    assert "claude" in str(exc.value)  # error lists the known families
