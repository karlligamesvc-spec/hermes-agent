"""hc-1131: every platform's whole system prompt, built by a real agent with the real apex-overlay plugin.

test_result_delivery_prompt_identity.py runs this once per surface; the environment decides which one. It loads
the plugin and pins the machine the way identity_exits_probe.py does, then prints one JSON object:
platform -> prompt.
"""

from __future__ import annotations

import json

import identity_exits_probe as machine

PLATFORMS = ("desktop", "tui", "cli", "subagent", "cron", "webhook", "api_server", "feishu", "weixin")


def main() -> None:
    machine._pin_machine()
    machine._load_plugin()

    from agent.system_prompt import build_system_prompt
    from run_agent import AIAgent

    prompts = {}
    for platform in PLATFORMS:
        agent = AIAgent(api_key="test-key", base_url="https://openrouter.ai/api/v1", model="test/model",
                        provider="openrouter", platform=platform, quiet_mode=True, skip_context_files=True,
                        skip_memory=True, enabled_toolsets=[], session_id="hc-1131")
        prompts[platform] = build_system_prompt(agent)
    print(json.dumps(prompts, ensure_ascii=False))


if __name__ == "__main__":
    main()
