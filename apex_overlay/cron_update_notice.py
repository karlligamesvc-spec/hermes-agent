"""hc-1183 changing where a cron job delivers says when it delivers nowhere, as creating one does.

``cronjob_manage`` ``create`` adds ``_local_delivery_notice`` to its result (upstream #51568): a job whose
delivery resolves to no target is saved locally and never reaches the chat it was made in, and the notice says
so. ``update`` echoes only the mode guidance, so a model that read the notice and then set ``deliver='origin'``
from a Desktop chat got a plain success back, and promised the user a delivery that never happens (hc-1166
acceptance, 0.17.74). This seam gives ``update`` the same notice whenever the call sets ``deliver``: the job is
re-read after the update and the notice comes from upstream's own function, so create and update cannot
disagree about the same job.

Patch point: ``tools.cronjob_tools._JOB_ACTIONS["update"]``, the dispatch table ``cronjob()`` reads; the module
attribute ``_action_update`` is re-pointed too, for direct callers. Armed with ``post_import.when_imported``, so
plugin discovery never imports the tool module. Upstream files stay untouched.
"""

from __future__ import annotations

import functools
import json
import logging
from types import ModuleType

from apex_overlay import post_import

logger = logging.getLogger(__name__)

_TOOL_MODULE = "tools.cronjob_tools"
_MARK = "_apex_cron_update_notice"


def _install(module: ModuleType) -> bool:
    actions = getattr(module, "_JOB_ACTIONS", None)
    update = actions.get("update") if isinstance(actions, dict) else None
    if update is None or not all(hasattr(module, name) for name in ("_local_delivery_notice", "get_job", "_dumps")):
        logger.error("apex-overlay: tools.cronjob_tools has no update action or delivery notice to patch")
        return False
    if getattr(update, _MARK, False):
        return True

    @functools.wraps(update)
    def update_with_notice(job, a):
        result = update(job, a)
        deliver = module._normalize_deliver_param(a.get("deliver"))
        if deliver is None:
            return result
        try:
            payload = json.loads(result)
            updated = module.get_job(job["id"]) if isinstance(payload, dict) and payload.get("success") is True else None
        except (OSError, ValueError, KeyError):  # the update already happened; a notice we cannot add must not hide it
            logger.warning("apex-overlay: could not re-read a cron job to add its delivery notice", exc_info=True)
            return result
        notice = module._local_delivery_notice(updated, deliver) if updated else None
        if not notice:
            return result
        payload["message"] = notice
        return module._dumps(payload)

    setattr(update_with_notice, _MARK, True)
    actions["update"] = update_with_notice
    module._action_update = update_with_notice
    return True


def apply() -> bool:
    return post_import.when_imported(_TOOL_MODULE, _install)
