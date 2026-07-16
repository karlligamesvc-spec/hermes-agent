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


def test_scrubbed_env_strips_channel_secrets(monkeypatch) -> None:
    # hc-524 audit P2: the desktop backend may inject IM-channel app secrets
    # (hc-417). These must never reach a spawned third-party CLI (cursor-agent).
    monkeypatch.setenv("FEISHU_APP_SECRET", "feishu-secret")
    monkeypatch.setenv("WECOM_APP_SECRET", "wecom-secret")
    monkeypatch.setenv("DINGTALK_APP_SECRET", "ding-secret")
    monkeypatch.setenv("QQBOT_BOT_TOKEN", "qq-token")
    monkeypatch.setenv("FEISHU_ENCODING_AES_KEY", "aes-key")
    env = harness_for("cursor", "/tmp")._scrubbed_env()
    for leaked in (
        "FEISHU_APP_SECRET",
        "WECOM_APP_SECRET",
        "DINGTALK_APP_SECRET",
        "QQBOT_BOT_TOKEN",
        "FEISHU_ENCODING_AES_KEY",
    ):
        assert leaked not in env, f"{leaked} leaked into spawned CLI env"
