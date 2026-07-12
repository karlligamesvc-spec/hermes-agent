"""Security §4: the child env is scrubbed of Hermes secrets and given the real
HOME so the external agent authenticates from its OWN credential store — the
adapter never forwards Hermes provider credentials into the user's agent."""

from __future__ import annotations

from agent.coding_agents import harness_for


def test_scrubbed_env_strips_hermes_provider_credentials(monkeypatch) -> None:
    # A Hermes provider key present in the parent env must NOT reach the child:
    # the user's coding agent bills its own subscription, not Hermes' key.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-hermes-secret")
    env = harness_for("cursor", "/tmp")._scrubbed_env()
    assert "ANTHROPIC_API_KEY" not in env


def test_scrubbed_env_sets_a_real_home(monkeypatch) -> None:
    monkeypatch.setenv("HOME", "/Users/real-user")
    env = harness_for("cursor", "/tmp")._scrubbed_env()
    # HOME is present and is a concrete path (external CLI reads ~/.claude etc.).
    assert env.get("HOME")
    assert env["HOME"].startswith("/")


def test_scrubbed_env_keeps_benign_vars(monkeypatch) -> None:
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    env = harness_for("cursor", "/tmp")._scrubbed_env()
    assert "PATH" in env  # non-secret env is preserved so the CLI can run
