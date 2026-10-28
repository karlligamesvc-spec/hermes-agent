"""hc-1103: everything an APEX user can read about who the engine is and which version it runs, in one process.

test_apex_identity_exits.py runs this once per surface; the environment decides which one (nothing set:
plain engine or Desktop with single-thread mode off; ``APEX_SINGLE_THREAD_ACTIVE=1``: Desktop's
single-thread mode; ``HERMES_MANAGED_RUNTIME=1``: a cloud container). It loads the bundled apex-overlay
plugin the way plugin discovery does, then prints every exit as one JSON object. What depends on the
machine (clock, install stamp, versions, install directory, update check) is pinned, so the output is
the same on every machine.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def _pin_machine() -> None:
    import agent.coding_context
    import hermes_cli._startup_fast as startup_fast
    from hermes_cli import banner
    from hermes_cli import config
    from hermes_cli import source_check
    from hermes_cli import steward
    import hermes_time
    from hermes_cli.version_info import VersionInfo

    hermes_time.now = lambda: datetime(2026, 10, 28, 12, 0, tzinfo=UTC)
    agent.coding_context.build_coding_workspace_block = lambda cwd=None: "Workspace: pinned"
    version = VersionInfo(base_version="0.22.5", derived_version="0.22.5", distance=0, commit=None, branch=None,
                          source="build", distribution="desktop-app")
    banner.get_version_info = lambda: version
    steward.read_install_stamp = lambda root: {"distribution": "desktop-app", "tag": "v2026.10.27-fork.aa8e554e"}
    startup_fast.project_root_str = lambda: "/Applications/APEX.app/Contents/Resources/engine"
    startup_fast.read_openai_version = lambda: "2.0.0"
    config.detect_install_method = lambda root: "desktop-app"
    config.recommended_update_command = lambda: "hermes update"
    source_check.check_for_updates = lambda passive=True: {"behind": 1}


def _load_plugin() -> None:
    from hermes_cli import plugins
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest

    manager = PluginManager()
    manager._discovered = True
    plugins._plugin_manager = manager
    spec = importlib.util.spec_from_file_location("apex_overlay_plugin", ROOT / "plugins" / "apex-overlay" / "__init__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.register(PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager))


def _identity_and_help(platform: str, **kwargs) -> str:
    """The stable tier's first two paragraphs: who the engine says it is, and the help line after it."""
    from agent.system_prompt import build_system_prompt_parts
    from run_agent import AIAgent

    agent = AIAgent(api_key="test-key", base_url="https://openrouter.ai/api/v1", model="test/model",
                    provider="openrouter", platform=platform, quiet_mode=True, skip_memory=True, enabled_toolsets=[],
                    session_id=f"hc-1103-{platform}", **kwargs)
    return "\n\n".join(build_system_prompt_parts(agent)["stable"].split("\n\n")[:2])


def _stdout(call) -> str:
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        call()
    return re.sub(r"(?m)^Python: \S+$", "Python: <pinned>", buffer.getvalue())


def main() -> None:
    _pin_machine()
    _load_plugin()

    import hermes_cli._startup_fast as startup_fast
    from agent import system_prompt
    from hermes_cli.slash_exec import CommandContext, execute_command
    from tools import voice_live

    exits = {
        "session-identity-and-help": _identity_and_help("tui", skip_context_files=True, load_soul_identity=True),
        "subagent-identity-and-help": _identity_and_help("subagent", skip_context_files=True),
        "help-line-with-hermes-agent-skill": system_prompt.HERMES_AGENT_HELP_GUIDANCE,
        "slash-version-im": execute_command("version", CommandContext(surface="gateway")).text,
        "slash-version-desktop-and-cli": _stdout(startup_fast.print_fast_version_info),
        "voice-live-persona": voice_live.live_instructions({}),
    }
    print(json.dumps(exits, ensure_ascii=False))


if __name__ == "__main__":
    main()
