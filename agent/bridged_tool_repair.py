"""hc-1040 (v2026.8.31 hotfix): a direct call to a tool behind the ``tool_call`` bridge is
never repaired into a different, visible tool.

Backport of fork main's ``agent.turn_tool_validation._repair_or_bridge`` (fork PR #478) onto
the cloud image line. Differences at this revision: the bridge takes the single
``{"name", "arguments"}`` shape, and the ordered Anthropic blocks ride on the assistant
message itself (there is no Bedrock sidecar).
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, Optional


def repair_or_bridge(agent: Any, tc: Any, assistant_message: Any) -> Optional[str]:
    """The name an unknown-name call gets: the agent's own repair, unless the closest real
    tool is one the model cannot see.

    ``repair_tool_call`` matches only the visible names. Plugin and MCP tools sit behind
    the ``tool_call`` bridge and are not among them, so a model calling one directly
    landed on the nearest visible name: on the cloud image ``social_search`` became
    ``tool_search`` (which then failed on the missing ``queries``), and the platform's
    search was never asked. Repeat the repair over the visible names plus every
    registered or bridge-reachable tool. A bridge-reachable winner gets this call wrapped
    into ``tool_call``. A registered tool this session cannot reach gets no repair, so the
    model is told the name is unavailable. A string that does not parse stays the outer
    arguments, so the JSON retry and truncation refusal after the name check treat it as
    before."""
    from agent.agent_runtime_helpers import repair_tool_call
    from agent.message_sanitization import coalesce_tool_call_id
    from agent.tool_executor import _tool_search_scoped_names
    from tools.registry import registry
    from tools.tool_search import TOOL_CALL_NAME

    repaired = agent._repair_tool_call(tc.function.name)
    visible = set(agent.valid_tool_names or ())
    bridged = _tool_search_scoped_names(agent) if TOOL_CALL_NAME in visible else frozenset()
    hidden = (set(registry.get_all_tool_names()) | bridged) - visible
    best = repair_tool_call(SimpleNamespace(valid_tool_names=visible | hidden), tc.function.name)
    if best not in hidden:
        return repaired
    if best not in bridged:
        return None
    raw, wrapped = tc.function.arguments, None
    try:
        raw = json.loads(raw.strip() or "{}") if isinstance(raw, str) else raw
    except json.JSONDecodeError:
        pass
    else:
        wrapped = {"name": best, "arguments": {} if raw is None else raw}
        tc.function.arguments = json.dumps(wrapped, ensure_ascii=False)
    # Native Anthropic replay reads the ordered blocks, not tool_calls.
    call_id = coalesce_tool_call_id(tc)
    for block in getattr(assistant_message, "anthropic_content_blocks", None) or ():
        if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("id") == call_id:
            block.update(name=TOOL_CALL_NAME, **({} if wrapped is None else {"input": wrapped}))
    return TOOL_CALL_NAME
