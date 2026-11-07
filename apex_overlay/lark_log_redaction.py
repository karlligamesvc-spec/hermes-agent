"""hc-1174 the Feishu SDK's websocket address reaches no log with its credentials in it.

``lark_oapi``'s websocket client logs ``connected to <url>`` and ``disconnected to <url>`` on its
``Lark`` logger, and the url carries the connection's credentials as query parameters
(``CREDENTIAL_PARAMS``: ``access_key``, ``ticket``). The Feishu adapter starts that client at INFO, and
the SDK's own default is INFO too, so both lines are written:

- by the ``Lark`` logger's own handler to stdout, which Desktop copies into ``desktop.log``;
- by every handler the record propagates to (``agent.log`` and the other Hermes log files).

Hermes' own redaction passes web-url query parameters through, and neither name is on its list.

This seam puts a filter on the ``Lark`` logger itself: a logger's filters run before any of its
handlers and before propagation, so both copies come out masked (``access_key=***``). The rest of the
address (host, path, ids) stays readable for debugging. Desktop masks the same names in every line it
writes to ``desktop.log`` (apps/desktop/electron/desktop-log-line.ts) for output that does not come
through this logger.
"""

from __future__ import annotations

import logging
import re

#: Query parameters of the Feishu websocket address that are credentials. The other parameters
#: (``fpid``, ``aid``, ``device_id``, ``service_id``) identify the connection and stay readable.
#: apps/desktop/electron/desktop-log-line.test.ts reads this tuple: Desktop masks the same names.
CREDENTIAL_PARAMS = ("access_key", "ticket")

_LOGGER = "Lark"
_CREDENTIAL = re.compile(r"([?&](?:" + "|".join(CREDENTIAL_PARAMS) + r")=)[^&\s'\"<>]+", re.IGNORECASE)


def redact(text: str) -> str:
    """``text`` with the value of every credential query parameter replaced by ``***``."""
    return _CREDENTIAL.sub(r"\1***", text)


class RedactLarkCredentials(logging.Filter):
    """Rewrites a record whose message carries a credential; never drops a record."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        # health: allow BLE001 -- a filter runs inside the SDK's own logger call: a raise here escapes into its connect loop; logging reports an unformattable record at emit
        except Exception:
            return True
        clean = redact(message)
        if clean != message:
            record.msg = clean
            record.args = ()
        return True


def apply() -> bool:
    """Attach the filter to the ``Lark`` logger (it exists before the SDK is imported), once."""
    logger = logging.getLogger(_LOGGER)
    if not any(isinstance(existing, RedactLarkCredentials) for existing in logger.filters):
        logger.addFilter(RedactLarkCredentials())
    return True
