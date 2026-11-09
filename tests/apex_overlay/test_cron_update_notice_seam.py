"""hc-1183: ``cronjob_manage`` ``update`` says a job delivers nowhere, the way ``create`` already does.

Every test drives the real tool entry (``tools.cronjob_tools.cronjob``) against a real job store in a temp
directory, with no session origin (a Desktop chat) and no IM home channel unless a test sets one. The seam is
installed through its own ``apply()`` and each test first checks that the dispatch table really holds it.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from apex_overlay import cron_update_notice
from cron.scheduler_delivery import _HOME_TARGET_ENV_VARS, _LEGACY_HOME_TARGET_ENV_VARS
from tools import cronjob_tools

NOTICE = "This is a local-only cron job"
REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def desktop_chat(tmp_path, monkeypatch):
    """A Desktop chat's view of cron: its own job store, no origin, no home channel; the seam installed."""
    monkeypatch.setattr("cron.jobs.CRON_DIR", tmp_path / "cron")
    monkeypatch.setattr("cron.jobs.JOBS_FILE", tmp_path / "cron" / "jobs.json")
    monkeypatch.setattr("cron.jobs.OUTPUT_DIR", tmp_path / "cron" / "output")
    for name in ("HERMES_SESSION_PLATFORM", "HERMES_SESSION_CHAT_ID", "HERMES_SESSION_THREAD_ID",
                 "HERMES_SESSION_CHAT_NAME", *_HOME_TARGET_ENV_VARS.values(), *_LEGACY_HOME_TARGET_ENV_VARS.values()):
        monkeypatch.delenv(name, raising=False)
    # Undone after the test: the original action goes back into the table and the module.
    monkeypatch.setitem(cronjob_tools._JOB_ACTIONS, "update", cronjob_tools._JOB_ACTIONS["update"])
    monkeypatch.setattr(cronjob_tools, "_action_update", cronjob_tools._action_update)
    from gateway.session_context import clear_session_vars, set_session_vars

    tokens = set_session_vars()
    assert cron_update_notice.apply() is True
    assert getattr(cronjob_tools._JOB_ACTIONS["update"], cron_update_notice._MARK, False), "seam not installed"
    yield
    clear_session_vars(tokens)


def _call(**kwargs) -> dict:
    return json.loads(cronjob_tools.cronjob(**kwargs))


def _local_job() -> str:
    created = _call(action="create", prompt="搜一条今天的财经新闻", schedule="in 30m", name="今日财经")
    assert created["success"] is True and created["deliver"] == "local"
    assert NOTICE in created["message"]  # what create already says, the baseline update must match
    return created["job_id"]


def test_setting_origin_from_a_desktop_chat_says_it_reaches_no_chat():
    updated = _call(action="update", job_id=_local_job(), deliver="origin")

    assert updated["success"] is True
    assert updated["job"]["deliver"] == "origin"
    assert NOTICE in updated["message"]


def test_create_and_update_give_the_same_notice_for_the_same_job():
    created = _call(action="create", prompt="x", schedule="in 30m", deliver="origin")
    updated = _call(action="update", job_id=created["job_id"], deliver="origin")
    notice = created["message"][created["message"].index(NOTICE):]
    assert updated["message"] == notice


@pytest.mark.parametrize("deliver", ["origin", "all", "origin,all", ["origin"]])
def test_every_target_that_resolves_to_nothing_gets_it(deliver):
    updated = _call(action="update", job_id=_local_job(), deliver=deliver)
    assert NOTICE in updated["message"]


def test_asking_for_local_is_not_warned_about():
    updated = _call(action="update", job_id=_local_job(), deliver="local")
    assert updated["success"] is True
    assert "message" not in updated


def test_an_update_that_leaves_delivery_alone_is_unchanged():
    updated = _call(action="update", job_id=_local_job(), name="改个名字")
    assert updated["success"] is True
    assert updated["job"]["name"] == "改个名字"
    assert "message" not in updated


@pytest.mark.parametrize(("platform", "chat_id"), [("feishu", "ou_owner"), ("weixin", "wx_owner")])
def test_a_bound_im_home_channel_is_a_real_target(monkeypatch, platform, chat_id):
    """APEX bound to Feishu or WeChat: deliver=origin falls back to that home channel, so nothing to warn about."""
    job_id = _local_job()
    monkeypatch.setenv(_HOME_TARGET_ENV_VARS[platform], chat_id)
    updated = _call(action="update", job_id=job_id, deliver="origin")
    assert updated["success"] is True
    assert "message" not in updated


def test_an_im_chats_job_has_its_origin_and_is_not_warned_about():
    from gateway.session_context import set_session_vars

    set_session_vars(platform="feishu", chat_id="oc_chat")
    created = _call(action="create", prompt="x", schedule="in 30m")
    assert created["deliver"] == "origin"
    updated = _call(action="update", job_id=created["job_id"], deliver="origin")
    assert "message" not in updated


def test_a_failed_update_comes_back_as_it_was():
    job_id = _local_job()
    updated = _call(action="update", job_id=job_id, deliver="bot-chat:no-such-profile")
    assert updated["success"] is False
    assert "message" not in updated


def test_applying_twice_wraps_once():
    first = cronjob_tools._JOB_ACTIONS["update"]
    assert cron_update_notice.apply() is True
    assert cronjob_tools._JOB_ACTIONS["update"] is first
    assert cronjob_tools._action_update is first


def test_the_registered_tool_handler_reaches_the_seam():
    """The model calls cronjob_manage through the registry handler, not cronjob() directly."""
    job_id = _local_job()
    updated = json.loads(cronjob_tools._cronjob_handler({"action": "update", "job_id": job_id, "deliver": "origin"}))
    assert NOTICE in updated["message"]


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    assert "cron_update_notice" in run_plugin_register_with_stubbed_seams("_apex_overlay_plugin_hc1183_update")


def test_apply_before_the_import_patches_it_when_it_loads():
    """Production order: plugin discovery arms the seam; the cronjob tool loads later, with the tool registry."""
    script = (
        "import sys\n"
        "from apex_overlay import cron_update_notice as seam\n"
        "assert 'tools.cronjob_tools' not in sys.modules\n"
        "assert seam.apply() is True\n"
        "assert 'tools.cronjob_tools' not in sys.modules\n"
        "import tools.cronjob_tools as tool\n"
        "patched = tool._JOB_ACTIONS['update']\n"
        "assert getattr(patched, seam._MARK, False) and tool._action_update is patched\n"
        "assert seam.apply() is True and tool._JOB_ACTIONS['update'] is patched\n"
        "print('ok')\n"
    )
    done = subprocess.run([sys.executable, "-c", script], cwd=REPO, capture_output=True, text=True, timeout=120, check=False)
    assert done.returncode == 0 and done.stdout.strip().endswith("ok"), done.stderr[-2000:]
