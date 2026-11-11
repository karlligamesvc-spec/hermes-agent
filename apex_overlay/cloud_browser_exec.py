"""hc-1203 云端助手保留 browser_exec: in an APEX cloud container, browser_exec stays without ``terminal``.

Upstream drops ``browser_exec`` from every session whose tool array lacks ``terminal``
(``model_tools._rewrite_browser_exec``): the tool runs model-written Python on the host, and a session
without the terminal surface must not regain host execution through the browser. APEX's cloud assistants
run with ``terminal`` disabled (apex-nodes ``HOSTED_DISABLED_TOOLSETS``), and Hermes v0.23.0 removed
agent-browser, so under that gate they would have no tool left that opens a web page. Each of them runs
alone in its own container, where ``execute_code`` already runs model-written Python; hc-1203 keeps
``browser_exec`` there.

A cloud container is ``HERMES_MANAGED_RUNTIME=1`` (set in the image; :func:`apex_identity.managed_runtime`).
There the terminal gate lets ``browser_exec`` through. ``terminal`` itself stays off, and the tool's other
schema rewriters (the vision hint, the vault note) still read the session's real tool set. Anywhere else
(Desktop, a plain engine) the gate is upstream's.

Hooked in place from ``model_tools._rewrite_browser_exec``, the one function both callers of the gate go
through: a fresh tool build (``model_tools._apply_dynamic_schemas``) and a tool carried over from a pinned
tools[] (``tools.mcp_tool_agent._drop_gated_carried_tools``). No seam can patch it from ``apply()``:
``model_tools`` is a top-level module whose own import runs plugin discovery (hc-989), and the composed
``browser_exec`` rewriter holds the function object it was built with, so rebinding the module attribute
would not reach it. apex-nodes reads the hook from the image to report the tool as hosted
(``capability_scan``); contract ``cloud-browser-exec-v023-hc1203`` there.
"""

from __future__ import annotations

from apex_overlay.apex_identity import managed_runtime


def keeps_browser_exec() -> bool:
    """True in an APEX cloud container: a session there keeps ``browser_exec`` without ``terminal``."""
    return managed_runtime()
