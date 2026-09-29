"""hc-889: real script executions must be visible without inventing chat sessions."""

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient


def test_script_execution_history_survives_failure_recovery_and_profile_switch(tmp_path, monkeypatch):
    from hermes_cli import profiles
    from hermes_cli.web_routers.cron import router

    home = tmp_path / ".hermes"
    worker = home / "profiles" / "worker"
    for directory in (home, worker):
        (directory / "scripts").mkdir(parents=True)
        (directory / "config.yaml").write_text("cron:\n  execution_mode: in_process\n")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: home / "profiles")
    script = worker / "scripts" / "probe.py"
    marker = worker / "executed.txt"
    script.write_text(f"from pathlib import Path\nPath({str(marker)!r}).write_text('executed')\nprint('local proof')\n")
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        created = client.post("/api/cron/jobs?profile=worker", json={
            "name": "Script history proof", "schedule": "every 1h", "script": "probe.py",
            "no_agent": True, "deliver": "local",
        })
        assert created.status_code == 200, created.text
        job_id = created.json()["id"]
        url = f"/api/cron/jobs/{job_id}"
        success = client.post(f"{url}/trigger?profile=worker")
        assert success.status_code == 200, success.text
        assert marker.read_text() == "executed"
        history = client.get(f"{url}/runs?profile=worker").json()
        assert history["runs"] == []  # no Agent was instantiated
        assert history["executions"][0]["status"] == "completed"
        assert history["executions"][0]["finished_at"]
        first_id = history["executions"][0]["id"]
        assert client.get(f"{url}/runs?profile=default").json()["executions"] == []

        script.write_text("raise SystemExit('intentional local failure')\n")
        failed = client.post(f"{url}/trigger?profile=worker")
        assert failed.status_code == 200, failed.text
        history = client.get(f"{url}/runs?profile=worker").json()
        assert [row["status"] for row in history["executions"]] == ["failed", "completed"]
        assert history["executions"][1]["id"] == first_id
        assert history["runs"] == []
        assert set(history["executions"][0]) == {"id", "status", "claimed_at", "started_at", "finished_at"}
        assert "intentional local failure" not in json.dumps(history)

        assert client.post(f"{url}/pause?profile=worker").json()["enabled"] is False
        assert client.post(f"{url}/resume?profile=worker").json()["enabled"] is True
        assert client.get(f"{url}/runs?profile=worker&limit=1").json()["executions"] == history["executions"][:1]
        assert client.delete(f"{url}?profile=worker").status_code == 200
        assert client.get(f"{url}/runs?profile=worker").json()["executions"] == history["executions"]
