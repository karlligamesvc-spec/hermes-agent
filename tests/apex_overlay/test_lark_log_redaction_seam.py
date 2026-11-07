"""hc-1174 the Feishu SDK's websocket address is logged without its credentials.

``lark_oapi`` logs ``connected to <url>`` / ``disconnected to <url>`` on its ``Lark`` logger,
which writes through its own stdout handler (Desktop copies that into ``desktop.log``) and also
propagates to the Hermes log files. The url carries ``access_key`` and ``ticket``.

The SDK is the ``feishu`` extra, which the test environment does not install, so the
subprocess tests build the ``Lark`` logger the way ``lark_oapi/core/log.py`` (1.6.8) does. The
last test runs the real SDK where it is installed (the Desktop bundle ships it since hc-1170).
"""

from __future__ import annotations

import importlib.util
import logging
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from apex_overlay import lark_log_redaction

REPO = Path(__file__).resolve().parents[2]

ACCESS_KEY = "f0e1d2c3b4a5968778695a4b3c2d1e0f"
TICKET = "7a1c9e2b-3d4f-4a6b-8c0d-1e2f3a4b5c6d"
URL = (
    "wss://msg-frontier.feishu.cn/ws/v2?fpid=493&aid=552564&device_id=7570123456789"
    f"&access_key={ACCESS_KEY}&service_id=33554678&ticket={TICKET}"
)
MASKED_URL = (
    "wss://msg-frontier.feishu.cn/ws/v2?fpid=493&aid=552564&device_id=7570123456789"
    "&access_key=***&service_id=33554678&ticket=***"
)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (f"connected to {URL} [conn_id=7570123456789]", f"connected to {MASKED_URL} [conn_id=7570123456789]"),
        (f"disconnected to {URL}", f"disconnected to {MASKED_URL}"),
        (f"wss://h/ws?access_key={ACCESS_KEY}", "wss://h/ws?access_key=***"),
        (f"wss://h/ws?TICKET={TICKET}&fpid=1", "wss://h/ws?TICKET=***&fpid=1"),
        (f"url='wss://h/ws?ticket={TICKET}'", "url='wss://h/ws?ticket=***'"),
        ("receive message, type: ping, conn_id=7570", "receive message, type: ping, conn_id=7570"),
        ("wss://h/ws?my_ticket=keep&service_id=2", "wss://h/ws?my_ticket=keep&service_id=2"),
    ],
    ids=["connected", "disconnected", "first-param", "upper-case", "quoted", "no-url", "longer-name"],
)
def test_redact_masks_the_credentials_and_keeps_the_rest(text, expected):
    assert lark_log_redaction.redact(text) == expected


def _run(script: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )


# Built the way lark_oapi/core/log.py builds it; the ws Client then sets INFO.
_SDK_LOGGER = (
    'sdk_logger = logging.getLogger("Lark")\n'
    "sdk_handler = logging.StreamHandler(sys.stdout)\n"
    'sdk_handler.setFormatter(logging.Formatter("[Lark] [%(asctime)s] [%(levelname)s] %(message)s"))\n'
    "sdk_logger.addHandler(sdk_handler)\n"
    "sdk_logger.setLevel(logging.INFO)\n"
)
_SEAM = "lark_log_redaction.apply()\n"


@pytest.mark.parametrize("seam_first", [True, False], ids=["seam-before-sdk", "seam-after-sdk"])
def test_both_copies_of_the_sdk_line_are_masked(seam_first):
    """The SDK's own stdout copy and the copy propagated to Hermes' handlers."""
    result = _run(
        "import logging, sys\n"
        "from apex_overlay import lark_log_redaction\n"
        'logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="propagated %(message)s")\n'
        + (_SEAM + _SDK_LOGGER if seam_first else _SDK_LOGGER + _SEAM)
        # the SDK formats eagerly (str.format); other callers may pass %-args
        + f'logging.getLogger("Lark").info("connected to {{}} [conn_id=7570123456789]".format({URL!r}))\n'
        + f'logging.getLogger("Lark").info("disconnected to %s", {URL!r})\n'
    )
    for stream, label in ((result.stdout, "stdout (desktop.log)"), (result.stderr, "propagated (agent.log)")):
        assert ACCESS_KEY not in stream and TICKET not in stream, f"{label} leaked:\n{stream}"
        assert f"connected to {MASKED_URL} [conn_id=7570123456789]" in stream, f"{label}:\n{stream}"
        assert f"disconnected to {MASKED_URL}" in stream, f"{label}:\n{stream}"
    assert result.stdout.startswith("[Lark] ["), "the SDK's own handler must keep its format"


def test_apply_is_idempotent():
    logger = logging.getLogger("Lark")
    before = list(logger.filters)
    try:
        assert lark_log_redaction.apply() is True
        assert lark_log_redaction.apply() is True
        ours = [f for f in logger.filters if isinstance(f, lark_log_redaction.RedactLarkCredentials)]
        assert len(ours) == 1
    finally:
        logger.filters[:] = before


def test_a_record_it_cannot_format_is_passed_through_untouched():
    record = logging.LogRecord("Lark", logging.INFO, __file__, 1, "%s and %s", ("one",), None)
    assert lark_log_redaction.RedactLarkCredentials().filter(record) is True
    assert (record.msg, record.args) == ("%s and %s", ("one",))


def test_records_without_credentials_keep_their_arguments():
    record = logging.LogRecord("Lark", logging.INFO, __file__, 1, "ping %s", ("7570",), None)
    assert lark_log_redaction.RedactLarkCredentials().filter(record) is True
    assert (record.msg, record.args) == ("ping %s", ("7570",))


def test_the_feishu_extra_still_pins_the_sdk_this_was_checked_against():
    """lark-oapi 1.6.8: logger "Lark" with its own stdout handler; the ws client logs the url.

    A version bump has to re-check those three facts (and the credential names) before
    this pin is moved.
    """
    pyproject = (REPO / "pyproject.toml").read_text(encoding="utf-8")
    assert 'feishu = ["lark-oapi==1.6.8"' in pyproject


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    assert "lark_log_redaction" in run_plugin_register_with_stubbed_seams("_apex_overlay_plugin_hc1174")


@pytest.mark.skipif(importlib.util.find_spec("lark_oapi") is None, reason="feishu extra not installed")
def test_the_real_sdk_logs_the_address_masked():
    result = _run(
        f"""
        from apex_overlay import lark_log_redaction
        lark_log_redaction.apply()
        import lark_oapi
        from lark_oapi.core.log import logger
        client = lark_oapi.ws.Client("cli_test", "not-a-secret")
        client._conn_id = "7570123456789"
        logger.info(client._fmt_log("connected to {{}}", {URL!r}))
        """
    )
    assert ACCESS_KEY not in result.stdout and TICKET not in result.stdout, result.stdout
    assert f"connected to {MASKED_URL} [conn_id=7570123456789]" in result.stdout, result.stdout
