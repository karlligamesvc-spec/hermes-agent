"""Real loopback HTTP + independent disk reads for Desktop owner-write fencing.

No GUI, gateway lifespan, live credentials, or external model requests. Pricing
barriers are explicit fixtures; all writes/journal/profile/auth behavior is real.
"""

from concurrent.futures import ThreadPoolExecutor
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import time
import uuid

import httpx
import pytest
import yaml

AUTHORITY = "90300000-0000-4000-8000-000000000001"
JOURNAL = ".desktop-model-mutations.sqlite3"
ROOT = Path(__file__).resolve().parents[2]
DRIVER = ROOT / "tests/fixtures/model_mutation_runtime.py"


def disk(home):
    return yaml.safe_load((home / "config.yaml").read_text())


def assignment(model, **kwargs):
    return {"scope": "main", "provider": "custom", "model": model,
            "base_url": "http://127.0.0.1:65500/v1", "api_key": "hc903-fixture-key", **kwargs}


def credential_fixture(home):
    key = "hc903-fixture-env-original"
    config = {"model": {"default": "original", "provider": "custom", "api_key": key},
              "auxiliary": {"title_generation": {"api_key": key}},
              "custom_providers": [{"name": "fixture", "base_url": "http://127.0.0.1:65500/v1", "api_key": key}],
              "providers": {"fixture-keyed": {"api": "http://127.0.0.1:65500/v1", "api_key": key}}}
    (home / "config.yaml").write_text(yaml.safe_dump(config))
    (home / ".env").write_text(f"ZAI_API_KEY={key}\n")
    (home / "auth.json").write_text(json.dumps({"credential_pool": {"zai": [
        {"id": "env", "label": "fixture env", "auth_type": "api_key", "source": "env:ZAI_API_KEY", "access_token": key, "priority": 0},
        {"id": "manual", "label": "fixture manual", "auth_type": "api_key", "source": "manual:api_key", "access_token": "hc903-fixture-manual", "priority": 1}]}}))
    (home / "provider_models_cache.json").write_text(json.dumps({"zai": {"models": ["fixture"], "ts": 0}}))


def credential_anchors(home):
    config = disk(home)
    return [config["model"], config["auxiliary"]["title_generation"], config["custom_providers"][0],
            config["providers"]["fixture-keyed"]]


class Runtime:
    def __init__(self, home, evidence, mode="plain"):
        self.home = home
        evidence.mkdir(parents=True)
        ready = evidence / "ready.json"
        self.log = (evidence / "server.log").open("w")
        env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "PYTHONUTF8", "HC903_FIXTURE_URL") if key in os.environ}
        env.update(PYTHONPATH=str(ROOT), HOME=str(home.parent), HERMES_HOME=str(home), HERMES_TEST_ISOLATION=str(home))
        self.process = subprocess.Popen([sys.executable, str(DRIVER), str(home), str(ready), mode],
                                        cwd=ROOT, env=env, stdout=self.log, stderr=self.log)
        self.client = None
        try:
            deadline = time.monotonic() + 10
            while not ready.exists():
                assert self.process.poll() is None, "Runtime fixture exited; inspect server.log"
                assert time.monotonic() < deadline, "Runtime did not publish listener"
                time.sleep(.01)
            self.url = f"http://127.0.0.1:{json.loads(ready.read_text())['port']}"
            self.client = httpx.Client(base_url=self.url, headers={"X-Hermes-Session-Token": "hc903-fixture-session"},
                                       timeout=10, trust_env=False, limits=httpx.Limits(max_keepalive_connections=0))
            # Listener is published just before uvicorn starts accepting.
            deadline = time.monotonic() + 10
            while True:
                try:
                    if self.client.get("/__fixture/state").status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                assert self.process.poll() is None
                assert time.monotonic() < deadline
                time.sleep(.01)
        except BaseException:
            self.close()
            raise

    def wait(self, key):
        deadline = time.monotonic() + 10
        while not self.client.get("/__fixture/state").json()[key]:
            assert time.monotonic() < deadline, f"Runtime never reached {key}"
            time.sleep(.01)

    def target(self, profile=None):
        response = self.client.get("/api/model/mutation", params={"profile": profile} if profile else {})
        assert response.status_code == 200, response.text
        assert response.json()["version"] == 1
        return response.json()["target_id"]

    def headers(self, revision, target=None):
        return {"X-Apex-Model-Authority": AUTHORITY, "X-Apex-Model-Revision": str(revision),
                "X-Apex-Model-Target": target or self.target()}

    def close(self):
        if self.log.closed:
            return
        if self.client is not None:
            with contextlib.suppress(httpx.HTTPError):
                self.client.post("/__fixture/release")
            self.client.close()
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.log.close()


@pytest.fixture
def runtimes(tmp_path, monkeypatch):
    home = tmp_path / "runtime"
    home.mkdir()
    (home / "config.yaml").write_text(yaml.safe_dump({"model": {"default": "original", "provider": "custom",
        "base_url": "http://127.0.0.1:65500/v1", "api_key": "hc903-fixture-original"}}))
    monkeypatch.setenv("HERMES_HOME", str(home))
    created = []

    def start(mode="plain", target_home=home):
        runtime = Runtime(target_home, tmp_path / f"server-{len(created)}", mode)
        created.append(runtime)
        return runtime

    yield home, start
    for runtime in reversed(created):
        runtime.close()


@pytest.mark.parametrize("mode,newer,same_process", [
    ("pricing", "assignment", False), ("pricing", "fence", False),
    ("validation", "assignment", True), ("validation", "fence", True),
    ("gateway-preparation", "assignment", True), ("gateway-preparation", "fence", True),
])
def test_new_owner_finishes_while_old_pricing_pending_across_processes(runtimes, mode, newer, same_process):
    home, start = runtimes
    a = start(mode)
    b = a if same_process else start()
    target = a.target()
    assert b.target() == target
    with ThreadPoolExecutor() as pool:
        old = pool.submit(a.client.post, "/api/model/set", json=assignment("owner-a", api_key="hc903-fixture-owner-a",
                          provider="nous" if mode == "gateway-preparation" else "custom"), headers=a.headers(1, target))
        a.wait("pricing_entered")
        try:
            if newer == "assignment":
                response = b.client.post("/api/model/set", json=assignment("owner-b", api_key="hc903-fixture-owner-b", confirm_expensive_model=True), headers=b.headers(2, target))
                expected = "owner-b"
            else:
                response = b.client.post("/api/model/mutation/fence", json={}, headers=b.headers(2, target))
                assert response.json() == {"ok": True, "revision": 2, "target_id": target}
                expected = "original"
            assert response.status_code == 200, response.text
            if newer == "assignment":
                assert response.json()["model_mutation"] == {"target_id": target, "revision": 2}
            assert not old.done(), "New intent must settle before old pricing is released"
            assert disk(home)["model"]["default"] == expected
        finally:
            a.client.post("/__fixture/release")
        response = old.result(timeout=10)
    after = disk(home)
    assert (response.status_code, after["model"]["default"], after["model"]["api_key"]) == (
        409, expected, "hc903-fixture-owner-b" if newer == "assignment" else "hc903-fixture-original")
    assert response.json() == {"detail": {"code": "model_mutation_superseded"}}
    if newer == "assignment":
        assert disk(home)["model"]["api_key"] == "hc903-fixture-owner-b"
        assert disk(home)["custom_providers"][0]["model"] == "owner-b"
        assert disk(home)["custom_providers"][0]["api_key"] == "hc903-fixture-owner-b"


def test_cancelled_http_task_cannot_unlock_its_live_sync_writer(runtimes):
    home, start = runtimes
    a, b = start("write"), start()
    target = a.target()
    with ThreadPoolExecutor() as pool:
        old = pool.submit(a.client.post, "/api/model/set", json=assignment("owner-a", confirm_expensive_model=True), headers=a.headers(1, target))
        a.wait("write_entered")
        assert a.client.post("/__fixture/cancel").status_code == 200
        a.wait("task_cancelled")
        fence = pool.submit(b.client.post, "/api/model/mutation/fence", json={}, headers=b.headers(2, target))
        b.wait("admit_entered")
        # Synchronize on B's actual admission attempt and A's actual writer.
        # Successful fence before release would let credential B coexist with A's late write.
        try:
            with pytest.raises(TimeoutError):
                fence.result(timeout=2)
            assert disk(home)["model"]["default"] == "original"
        finally:
            a.client.post("/__fixture/release")
        a.wait("worker_finished")
        assert fence.result(timeout=10).json() == {"ok": True, "revision": 2, "target_id": target}
        with contextlib.suppress(httpx.HTTPError):
            assert old.result(timeout=10).status_code == 500
    # Fence acknowledges after all A writes, including secondary provider registration.
    before = (home / "config.yaml").read_bytes()
    assert disk(home)["model"]["default"] == "owner-a"
    assert disk(home)["custom_providers"][0]["model"] == "owner-a"
    assert b.client.post("/api/model/set", json=assignment("owner-b", confirm_expensive_model=True), headers=b.headers(3, target)).status_code == 200
    assert (home / "config.yaml").read_bytes() != before
    assert disk(home)["model"]["default"] == "owner-b"


def test_legacy_http_and_cli_do_not_create_journal(runtimes):
    from hermes_cli.config import save_config
    home, start = runtimes
    save_config({"model": {"default": "cli", "provider": "custom"}})
    assert not (home / JOURNAL).exists()
    runtime = start()
    response = runtime.client.post("/api/model/set", json=assignment("legacy", confirm_expensive_model=True))
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert "model_mutation" not in response.json()
    assert disk(home)["model"]["default"] == "legacy"
    assert not (home / JOURNAL).exists()
    assert runtime.client.post("/api/model/mutation/fence", json={}).status_code == 422
    assert not (home / JOURNAL).exists()


@pytest.mark.parametrize("headers", [
    {"X-Apex-Model-Authority": AUTHORITY},
    {"X-Apex-Model-Revision": "1"},
    {"X-Apex-Model-Target": AUTHORITY},
    {"X-Apex-Model-Authority": "wrong", "X-Apex-Model-Revision": "1", "X-Apex-Model-Target": AUTHORITY},
    {"X-Apex-Model-Authority": AUTHORITY, "X-Apex-Model-Revision": "0", "X-Apex-Model-Target": AUTHORITY},
    {"X-Apex-Model-Authority": AUTHORITY, "X-Apex-Model-Revision": str(2**53), "X-Apex-Model-Target": AUTHORITY},
    {"X-Apex-Model-Authority": AUTHORITY, "X-Apex-Model-Revision": "-1", "X-Apex-Model-Target": AUTHORITY},
])
def test_invalid_receipts_fail_before_disk_mutation(runtimes, headers):
    home, start = runtimes
    runtime = start()
    before = (home / "config.yaml").read_bytes()
    response = runtime.client.post("/api/model/set", json=assignment("bad", confirm_expensive_model=True), headers=headers)
    assert response.status_code == 422
    assert (home / "config.yaml").read_bytes() == before
    assert not (home / JOURNAL).exists()


def test_capability_and_fence_keep_existing_session_auth(runtimes):
    home, start = runtimes
    runtime = start()
    with httpx.Client(base_url=runtime.url, trust_env=False) as unauthenticated:
        assert unauthenticated.get("/api/model/mutation").status_code == 401
        assert unauthenticated.post("/api/model/mutation/fence", json={}, headers={
            "X-Apex-Model-Authority": AUTHORITY, "X-Apex-Model-Revision": "1", "X-Apex-Model-Target": AUTHORITY}).status_code == 401
    assert not (home / JOURNAL).exists()


def test_target_binding_and_revision_survive_process_restart(runtimes):
    home, start = runtimes
    a = start()
    target = a.target()
    assert a.client.post("/api/model/mutation/fence", json={}, headers=a.headers(5, target)).status_code == 200
    a.close()
    b = start()
    assert b.target() == target
    before = (home / "config.yaml").read_bytes()
    stale = b.client.post("/api/model/set", json=assignment("stale", confirm_expensive_model=True), headers=b.headers(4, target))
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "model_mutation_superseded"
    changed = b.client.post("/api/model/set", json=assignment("wrong-target", confirm_expensive_model=True), headers=b.headers(6, str(uuid.uuid4())))
    assert changed.status_code == 409
    assert changed.json()["detail"]["code"] == "model_mutation_target_changed"
    assert (home / "config.yaml").read_bytes() == before


@pytest.mark.parametrize("fault", ["bytes", "identity", "revision"])
def test_corrupt_journal_fails_closed_without_replacing_identity(runtimes, fault):
    home, start = runtimes
    runtime = start()
    target = runtime.target()
    if fault == "bytes":
        (home / JOURNAL).write_bytes(b"not sqlite")
    else:
        with sqlite3.connect(home / JOURNAL) as connection:
            if fault == "identity":
                connection.execute("DELETE FROM identity")
            else:
                connection.execute("INSERT INTO revisions VALUES (?, ?)", (AUTHORITY, -4))
    before = (home / "config.yaml").read_bytes()
    response = runtime.client.post("/api/model/set", json=assignment("bad", confirm_expensive_model=True), headers=runtime.headers(2, target))
    assert response.status_code == 503
    assert (home / "config.yaml").read_bytes() == before


def test_clone_export_import_get_new_target_without_changing_source(runtimes, tmp_path):
    from hermes_cli import profiles
    home, start = runtimes
    runtime = start()
    target = runtime.target()
    journal = (home / JOURNAL).read_bytes()
    # Real clone-all excludes even SQLite sidecar artifacts.
    for suffix in ("-wal", "-shm", "-journal"):
        (home / (JOURNAL + suffix)).write_text("fixture")
    clone = profiles.create_profile("cloned", clone_from="default", clone_all=True, no_alias=True)
    assert not any(path.name.startswith(JOURNAL) for path in clone.iterdir())
    clone_target = runtime.target("cloned")
    assert clone_target != target
    archive = profiles.export_profile("cloned", str(tmp_path / "clone.tar.gz"))
    with tarfile.open(archive) as bundle:
        assert not any(JOURNAL in member.name for member in bundle.getmembers())
    imported = profiles.import_profile(str(archive), name="imported")
    assert not (imported / JOURNAL).exists()
    assert runtime.target("imported") not in {target, clone_target}
    assert (home / JOURNAL).read_bytes() == journal


def test_aliases_share_target_and_distinct_profile_has_independent_counter(runtimes):
    from hermes_cli import profiles
    home, start = runtimes
    runtime = start()
    target = runtime.target()
    assert runtime.target("current") == target
    assert runtime.target("default") == target
    other = profiles.create_profile("other", no_alias=True, no_skills=True)
    other_target = runtime.target("other")
    assert other_target != target
    assert runtime.client.post("/api/model/mutation/fence", json={}, headers=runtime.headers(8, target)).status_code == 200
    response = runtime.client.post("/api/model/set", json=assignment("other-owner", profile="other", confirm_expensive_model=True), headers=runtime.headers(1, other_target))
    assert response.status_code == 200, response.text
    assert disk(other)["model"]["default"] == "other-owner"
    assert disk(home)["model"]["default"] == "original"


def test_journal_connection_is_closed_after_commit(runtimes):
    from hermes_cli.web_model_mutations import _journal
    home, _ = runtimes
    with _journal(home) as connection:
        assert connection.execute("SELECT target_id FROM identity").fetchone()
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        connection.execute("SELECT 1")


@pytest.mark.parametrize("schema,initial", [("legacy", "literal"), ("legacy", "env-reference"),
                                           ("providers", "literal"), ("providers", "env-reference"),
                                           ("providers", "api_key_env")])
def test_explicit_key_rotation_updates_main_and_existing_catalog_entry(runtimes, schema, initial):
    home, start = runtimes
    cfg = disk(home)
    catalog = {"name": "fixture", "base_url": "http://127.0.0.1:65500/v1", "model": "original"}
    if initial == "literal":
        catalog["api_key"] = "hc903-fixture-old"
    else:
        (home / ".env").write_text("HC903_FIXTURE_KEY=hc903-fixture-old\n")
        catalog["api_key_env" if initial == "api_key_env" else "key_env"] = "HC903_FIXTURE_KEY"
    if schema == "legacy":
        cfg["custom_providers"] = [catalog]
    else:
        cfg["providers"] = {"fixture-stable": catalog}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg))
    runtime = start()
    target = runtime.target()
    response = runtime.client.post("/api/model/set", json=assignment("rotated", api_key="hc903-fixture-new", confirm_expensive_model=True), headers=runtime.headers(1, target))
    assert response.status_code == 200, response.text
    assert response.json()["model_mutation"] == {"target_id": target, "revision": 1}
    after = disk(home)
    assert after["model"]["api_key"] == "hc903-fixture-new"
    saved = after["custom_providers"][0] if schema == "legacy" else after["providers"]["fixture-stable"]
    assert saved["api_key"] == "hc903-fixture-new"
    assert "key_env" not in saved
    assert "api_key_env" not in saved
    if schema == "providers":
        assert not after.get("custom_providers")  # keep the canonical identity, not a shadow list entry
    from hermes_cli.runtime_provider import resolve_runtime_provider
    resolved = resolve_runtime_provider(requested=after["model"]["provider"], target_model="rotated")
    assert resolved["api_key"] == "hc903-fixture-new"
    assert resolved["requested_provider"] == response.json()["provider"] == after["model"]["provider"]
    # Omitting a key changes the model without erasing the saved credential.
    payload = assignment("omitted", confirm_expensive_model=True)
    payload.pop("api_key")
    assert runtime.client.post("/api/model/set", json=payload, headers=runtime.headers(2, target)).status_code == 200
    after = disk(home)
    saved = after["custom_providers"][0] if schema == "legacy" else after["providers"]["fixture-stable"]
    assert saved["api_key"] == "hc903-fixture-new"


@pytest.mark.parametrize("method,path,payload", [
    ("POST", "/api/model/set", {"scope": "auxiliary", "task": "title_generation", "provider": "custom", "model": "stale", "confirm_expensive_model": True}),
    ("PUT", "/api/model/moa", {"reference_models": [{"provider": "custom", "model": "stale"}], "aggregator": {"provider": "custom", "model": "stale"}}),
    ("PUT", "/api/config", {"config": {"model": "stale"}}),
    ("PUT", "/api/config/raw", {"yaml_text": "model:\n  default: stale\n  provider: custom\n"}),
    ("POST", "/api/providers/custom-endpoints", {"id": "fixture", "name": "fixture", "base_url": "http://127.0.0.1:65500/v1", "model": "stale", "api_key": "hc903-fixture-replace", "make_default": True}),
    ("POST", "/api/providers/custom-endpoints/fixture/activate", {}),
    ("DELETE", "/api/providers/custom-endpoints/fixture", None),
    ("PUT", "/api/env", {"key": "CUSTOM_FIXTURE_API_KEY", "value": "hc903-fixture-replace"}),
    ("DELETE", "/api/env", {"key": "CUSTOM_FIXTURE_API_KEY"}),
])
def test_all_tagged_write_exits_recheck_after_admission(runtimes, method, path, payload):
    home, start = runtimes
    cfg = disk(home)
    cfg["providers"] = {"fixture": {"name": "fixture", "base_url": "http://127.0.0.1:65500/v1", "model": "original",
                                    "api_key": "hc903-fixture-original"}}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg))
    (home / ".env").write_text("CUSTOM_FIXTURE_API_KEY=hc903-fixture-original\n")
    a, b = start("admission"), start()
    target = a.target()
    before, env_before = (home / "config.yaml").read_bytes(), (home / ".env").read_bytes()
    with ThreadPoolExecutor() as pool:
        old = pool.submit(a.client.request, method, path, json=payload, headers=a.headers(1, target))
        a.wait("pricing_entered")  # This mode pauses immediately after real admission.
        try:
            assert b.client.post("/api/model/mutation/fence", json={}, headers=b.headers(2, target)).status_code == 200
        finally:
            a.client.post("/__fixture/release")
        response = old.result(timeout=10)
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "model_mutation_superseded"
    assert (home / "config.yaml").read_bytes() == before
    assert (home / ".env").read_bytes() == env_before
    retry = a.client.request(method, path, json=payload, headers=a.headers(3, target))
    assert retry.status_code == 200, retry.text
    assert retry.json()["model_mutation"] == {"target_id": target, "revision": 3}
    assert (home / "config.yaml").read_bytes() != before


@pytest.mark.parametrize("schema,key_style", [("legacy", "key_env"), ("legacy", "template"), ("providers", "key_env"), ("providers", "template")])
def test_cli_named_reselection_keeps_credential_pointers_and_real_resolution(runtimes, monkeypatch, schema, key_style):
    from hermes_cli.config import load_config
    from hermes_cli.main_provider_setup import _named_custom_provider_map
    from hermes_cli import model_setup_flows_custom
    from hermes_cli.runtime_provider import resolve_runtime_provider
    home, _ = runtimes
    cfg = disk(home)
    entry = {"name": "fixture", "base_url": "http://127.0.0.1:65500/v1", "model": "original",
             "discover_models": False, "models": ["original", "next"]}
    entry["key_env" if key_style == "key_env" else "api_key"] = "HC903_FIXTURE_KEY" if key_style == "key_env" else "${HC903_FIXTURE_KEY}"
    if schema == "legacy":
        cfg["custom_providers"] = [entry]
    else:
        cfg["providers"] = {"fixture-stable": entry}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg))
    (home / ".env").write_text("HC903_FIXTURE_KEY=hc903-fixture-kept\n")
    monkeypatch.setenv("HC903_FIXTURE_KEY", "hc903-fixture-kept")
    info = next(iter(_named_custom_provider_map(load_config()).values()))
    monkeypatch.setattr(model_setup_flows_custom, "_pick_named_custom_model", lambda *args: "next")
    model_setup_flows_custom._model_flow_named_custom(load_config(), info)
    after = disk(home)
    saved = after["custom_providers"][0] if schema == "legacy" else after["providers"]["fixture-stable"]
    if key_style == "key_env":
        assert saved["key_env"] == "HC903_FIXTURE_KEY"
        assert "api_key" not in saved
    else:
        assert saved["api_key"] == "${HC903_FIXTURE_KEY}"
    assert "hc903-fixture-kept" not in (home / "config.yaml").read_text()
    resolved = resolve_runtime_provider(requested=after["model"]["provider"], target_model="next")
    assert resolved["api_key"] == "hc903-fixture-kept"
    assert not (home / JOURNAL).exists()


@pytest.mark.parametrize("schema,auto_present", [("legacy", False), ("legacy", True),
                                               ("providers", False), ("providers", True)])
def test_explicit_endpoint_key_never_rotates_another_named_identity(runtimes, schema, auto_present):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    home, start = runtimes
    cfg = disk(home)
    entries = [{"name": name, "base_url": "http://127.0.0.1:65500/v1", "model": "original", "api_key": key}
               for name, key in [("first", "hc903-fixture-first"), ("second", "hc903-fixture-second")]]
    if auto_present:
        entries.append({"name": "Local (127.0.0.1:65500)", "base_url": "http://127.0.0.1:65500/v1", "model": "original", "api_key": "hc903-fixture-auto"})
    if schema == "legacy":
        cfg["custom_providers"] = entries
    else:
        cfg["providers"] = {("custom:local-(127.0.0.1:65500)" if index == 2 else entry["name"]): entry
                            for index, entry in enumerate(entries)}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg))
    runtime = start()
    response = runtime.client.post("/api/model/set", json=assignment("new", api_key="hc903-fixture-new", confirm_expensive_model=True), headers=runtime.headers(1))
    assert response.status_code == 200, response.text
    after = disk(home)
    if schema == "legacy":
        assert after["custom_providers"][:2] == entries[:2]
        assert len(after["custom_providers"]) == 3
        assert after["custom_providers"][2]["api_key"] == "hc903-fixture-new"
    else:
        assert after["providers"]["first"] == entries[0]
        assert after["providers"]["second"] == entries[1]
        if auto_present:
            assert after["providers"]["custom:local-(127.0.0.1:65500)"]["api_key"] == "hc903-fixture-new"
            assert not after.get("custom_providers")
        else:
            assert after["custom_providers"][0]["api_key"] == "hc903-fixture-new"
    assert after["model"]["provider"] == response.json()["provider"]
    assert resolve_runtime_provider(requested=response.json()["provider"], target_model="new")["api_key"] == "hc903-fixture-new"
    assert resolve_runtime_provider(requested="custom:first", target_model="original")["api_key"] == "hc903-fixture-first"
    assert resolve_runtime_provider(requested="custom:second", target_model="original")["api_key"] == "hc903-fixture-second"


@pytest.mark.parametrize("collision", ["canonical-key", "display-alias"])
def test_explicit_key_rotation_rejects_cross_schema_identity_shadow_before_write(runtimes, collision):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    home, start = runtimes
    cfg = disk(home)
    auto_name, auto_slug = "Local (127.0.0.1:65500)", "custom:local-(127.0.0.1:65500)"
    cfg["custom_providers"] = [{"name": auto_name, "base_url": "http://127.0.0.1:65500/v1",
                                "model": "original", "api_key": "hc903-fixture-selected"}]
    cfg["providers"] = {auto_slug if collision == "canonical-key" else "foreign": {
        "name": "Different endpoint" if collision == "canonical-key" else auto_name,
        "base_url": "http://127.0.0.1:65501/v1", "model": "original", "api_key": "hc903-fixture-shadow"}}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg))
    runtime = start()
    before = (home / "config.yaml").read_bytes()
    # The independent production resolver actually routes to the keyed shadow;
    # a successful ACK for rotating just the legacy entry would be false.
    resolved = resolve_runtime_provider(requested=auto_slug, target_model="original")
    assert resolved["base_url"] == "http://127.0.0.1:65501/v1"
    response = runtime.client.post("/api/model/set", json=assignment("new", api_key="hc903-fixture-new", confirm_expensive_model=True), headers=runtime.headers(1))
    assert response.status_code == 500
    assert response.json() == {"detail": "Failed to save model assignment"}
    assert (home / "config.yaml").read_bytes() == before
    assert resolve_runtime_provider(requested=auto_slug, target_model="original")["base_url"] == "http://127.0.0.1:65501/v1"


@pytest.mark.parametrize("url_field,url_style", [("api", "literal"), ("url", "literal"), ("api", "template")])
def test_v12_canonical_url_and_transport_keep_identity_during_rotation(runtimes, monkeypatch, url_field, url_style):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    home, start = runtimes
    cfg = disk(home)
    provider_key = "custom:local-(127.0.0.1:65500)"
    url = "http://127.0.0.1:65500/v1"
    monkeypatch.setenv("HC903_FIXTURE_URL", url)  # default-profile startup's explicit fixture environment
    cfg["providers"] = {provider_key: {"name": "Stable configured endpoint", url_field: "${HC903_FIXTURE_URL}" if url_style == "template" else url,
        "default_model": "original", "transport": "codex_responses", "api_key": "hc903-fixture-old"}}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg))
    (home / ".env").write_text(f"HC903_FIXTURE_URL={url}\n")
    runtime = start()
    target = runtime.target()
    before_env = (home / ".env").read_bytes()
    response = runtime.client.post("/api/model/set", json=assignment("new", api_key="hc903-fixture-new", confirm_expensive_model=True), headers=runtime.headers(1, target))
    assert response.status_code == 200, response.text
    assert response.json()["model_mutation"] == {"target_id": target, "revision": 1}
    after = disk(home)
    assert not after.get("custom_providers")
    assert after["model"]["provider"] == response.json()["provider"] == provider_key
    saved = after["providers"][provider_key]
    assert saved == {**cfg["providers"][provider_key], "default_model": "new", "api_key": "hc903-fixture-new"}
    assert (home / ".env").read_bytes() == before_env
    resolved = resolve_runtime_provider(requested=provider_key, target_model="new")
    assert (resolved["api_key"], resolved["base_url"], resolved["api_mode"]) == ("hc903-fixture-new", url, "codex_responses")


@pytest.mark.parametrize("pointer", ["key_env", "api_key_env"])
def test_explicit_key_rotation_replaces_both_main_and_canonical_provider_pointers(runtimes, pointer):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    home, start = runtimes
    cfg = disk(home)
    provider_key = "custom:fixture"
    cfg["model"].pop("api_key")
    cfg["model"].update(provider=provider_key, **{pointer: "HC903_FIXTURE_OLD_KEY"})
    cfg["providers"] = {provider_key: {"name": "fixture", "api": "http://127.0.0.1:65500/v1",
        "default_model": "original", pointer: "HC903_FIXTURE_OLD_KEY"}}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg))
    (home / ".env").write_text("HC903_FIXTURE_OLD_KEY=hc903-fixture-old\n")
    runtime = start()
    response = runtime.client.post("/api/model/set", json=assignment("new", api_key="hc903-fixture-new", confirm_expensive_model=True), headers=runtime.headers(1))
    assert response.status_code == 200, response.text
    after = disk(home)
    for anchor in (after["model"], after["providers"][provider_key]):
        assert anchor["api_key"] == "hc903-fixture-new"
        assert pointer not in anchor
    assert after["model"]["provider"] == response.json()["provider"] == provider_key
    assert resolve_runtime_provider(requested=provider_key, target_model="new")["api_key"] == "hc903-fixture-new"


@pytest.mark.parametrize("url_field", ["api", "url", "base_url"])
def test_keyed_provider_without_display_name_keeps_durable_identity_on_rotation(runtimes, url_field):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    home, start = runtimes
    provider_key = "custom:managed"
    url = "http://127.0.0.1:65500/v1"
    cfg = {"model": {"provider": provider_key, "default": "original"},
           "providers": {provider_key: {url_field: url, "api_key": "hc903-fixture-old", "default_model": "original"}}}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg))
    assert resolve_runtime_provider(requested=provider_key, target_model="original")["api_key"] == "hc903-fixture-old"
    runtime = start()
    target = runtime.target()
    response = runtime.client.post("/api/model/set", json=assignment("new", api_key="hc903-fixture-new", confirm_expensive_model=True), headers=runtime.headers(1, target))
    assert response.status_code == 200, response.text
    assert response.json()["model_mutation"] == {"target_id": target, "revision": 1}
    after = disk(home)
    assert after["model"]["provider"] == response.json()["provider"] == provider_key
    assert after["model"]["api_key"] == "hc903-fixture-new"
    assert after["providers"] == {provider_key: {**cfg["providers"][provider_key], "default_model": "new", "api_key": "hc903-fixture-new"}}
    assert not after.get("custom_providers")
    resolved = resolve_runtime_provider(requested=provider_key, target_model="new")
    assert (resolved["api_key"], resolved["base_url"]) == ("hc903-fixture-new", url)


@pytest.mark.parametrize("mode", ["persist", "registration"])
def test_real_write_failure_has_no_success_receipt_and_new_revision_can_retry(runtimes, mode):
    home, start = runtimes
    runtime = start(mode)
    target = runtime.target()
    before = (home / "config.yaml").read_bytes()
    payload = assignment("fault", confirm_expensive_model=True)
    if mode == "registration":
        payload.pop("api_key")  # exercises the existing secondary-registration exit
    failed = runtime.client.post("/api/model/set", json=payload, headers=runtime.headers(1, target))
    assert failed.status_code == 500
    assert failed.json() == {"detail": "Failed to save model assignment"}
    if mode == "persist":
        assert (home / "config.yaml").read_bytes() == before  # candidate validates before any write
    else:
        assert disk(home)["model"]["default"] == "fault"  # legacy two-write branch is explicitly partial
        assert not disk(home).get("custom_providers")
    retry = runtime.client.post("/api/model/set", json=payload, headers=runtime.headers(2, target))
    assert retry.status_code == 200, retry.text
    assert retry.json()["model_mutation"] == {"target_id": target, "revision": 2}
    assert disk(home)["model"]["default"] == "fault"
    assert disk(home)["custom_providers"][0]["model"] == "fault"


@pytest.mark.parametrize("preferred,lower", [("api", "url"), ("api", "base_url"), ("url", "base_url")])
@pytest.mark.parametrize("consumer_managed", [True, False])
def test_keyed_rotation_follows_actual_consumer_url_priority(runtimes, preferred, lower, consumer_managed):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    home, start = runtimes
    managed = "http://127.0.0.1:65500/v1"
    unrelated = "http://127.0.0.1:65501/v1"
    key = "custom:managed"
    selected_url = managed if consumer_managed else unrelated
    catalog = {preferred: selected_url, lower: unrelated if consumer_managed else managed,
               "api_key": "hc903-fixture-old", "default_model": "original"}
    cfg = {"model": {"provider": key, "default": "original"}, "providers": {key: catalog}}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg))
    assert resolve_runtime_provider(requested=key, target_model="original")["base_url"] == selected_url
    runtime = start()
    target = runtime.target()
    response = runtime.client.post("/api/model/set", json=assignment("new", api_key="hc903-fixture-new", confirm_expensive_model=True), headers=runtime.headers(1, target))
    assert response.status_code == 200, response.text
    assert response.json()["model_mutation"] == {"target_id": target, "revision": 1}
    saved = disk(home)
    if consumer_managed:
        assert saved["model"]["provider"] == response.json()["provider"] == key
        assert saved["providers"][key] == {**catalog, "default_model": "new", "api_key": "hc903-fixture-new"}
        assert not saved.get("custom_providers")
    else:
        assert saved["providers"][key] == catalog  # a lower-priority managed URL cannot authorize rotating BYOK
        original = resolve_runtime_provider(requested=key, target_model="original")
        assert (original["base_url"], original["api_key"]) == (unrelated, "hc903-fixture-old")
        assert saved["model"]["provider"] != key
    actual = resolve_runtime_provider(requested=saved["model"]["provider"], target_model="new")
    assert (actual["base_url"], actual["api_key"]) == (managed, "hc903-fixture-new")


def test_replaced_profile_rejects_captured_target_and_alias_home_is_canonical(runtimes, tmp_path):
    from hermes_cli import profiles
    home, start = runtimes
    runtime = start()
    target = runtime.target()
    alias = tmp_path / "alias"
    alias.symlink_to(home, target_is_directory=True)
    assert start(target_home=alias).target() == target
    other = profiles.create_profile("replaceable", no_alias=True, no_skills=True)
    old_target = runtime.target("replaceable")
    (other / JOURNAL).unlink()
    before = (other / "config.yaml").read_bytes()
    response = runtime.client.post("/api/model/set", json=assignment("wrong", profile="replaceable", confirm_expensive_model=True), headers=runtime.headers(1, old_target))
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "model_mutation_target_changed"
    assert runtime.target("replaceable") != old_target
    assert (other / "config.yaml").read_bytes() == before


def test_confirmation_response_never_acknowledges_an_unwritten_assignment(runtimes):
    home, start = runtimes
    runtime = start("confirmation")
    target = runtime.target()
    before = (home / "config.yaml").read_bytes()
    response = runtime.client.post("/api/model/set", json=assignment("needs-confirmation"), headers=runtime.headers(1, target))
    assert response.status_code == 200
    assert response.json() == {"ok": False, "scope": "main", "provider": "custom", "model": "needs-confirmation",
                               "confirm_required": True, "confirm_message": "Fixture requires explicit confirmation"}
    assert (home / "config.yaml").read_bytes() == before
    confirmed = runtime.client.post("/api/model/set", json=assignment("confirmed", confirm_expensive_model=True), headers=runtime.headers(2, target))
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["model_mutation"] == {"target_id": target, "revision": 2}


def test_commit_ack_requires_real_write_and_completed_outer_transaction(runtimes):
    from hermes_cli import web_model_mutations as mutations
    from hermes_cli.config import save_config
    home, _ = runtimes
    target = mutations.mutation_capabilities(None)["target_id"]
    receipt = mutations.MutationContext(home, AUTHORITY, 1, target)
    mutations._admit(receipt)
    token = mutations._context.set(receipt)
    try:
        with mutations.model_mutation_commit():
            assert mutations.model_mutation_ack() == {}
        assert mutations.model_mutation_ack() == {}  # a lock/no-op is not a saved assignment
        with mutations.model_mutation_commit():
            save_config({"model": {"default": "committed", "provider": "custom"}})
            assert mutations.model_mutation_ack() == {}  # outer transaction still owns the write
        assert disk(home)["model"]["default"] == "committed"
        assert mutations.model_mutation_ack() == {"model_mutation": {"target_id": target, "revision": 1}}
    finally:
        mutations._context.reset(token)
    assert mutations.model_mutation_ack() == {}


@pytest.mark.parametrize("method,payload", [("PUT", {"key": "ZAI_API_KEY", "value": "hc903-fixture-owner-a"}),
                                           ("DELETE", {"key": "ZAI_API_KEY"})])
def test_env_late_writer_cannot_replace_new_owner_credential_mirrors_or_pool(runtimes, method, payload):
    home, start = runtimes
    credential_fixture(home)
    runtime = start("admission")
    target = runtime.target()
    with ThreadPoolExecutor() as pool:
        old = pool.submit(runtime.client.request, method, "/api/env", json=payload, headers=runtime.headers(1, target))
        runtime.wait("pricing_entered")
        try:
            newer = runtime.client.put("/api/env", json={"key": "ZAI_API_KEY", "value": "hc903-fixture-owner-b"}, headers=runtime.headers(2, target))
            assert newer.status_code == 200, (newer.text, Path(runtime.log.name).read_text())
            assert newer.json()["model_mutation"] == {"target_id": target, "revision": 2}
            assert not old.done()
        finally:
            runtime.client.post("/__fixture/release")
        response = old.result(timeout=10)
    assert response.status_code == 409, response.text
    assert response.json() == {"detail": {"code": "model_mutation_superseded"}}
    assert (home / ".env").read_text() == "ZAI_API_KEY=hc903-fixture-owner-b\n"
    assert all(anchor["api_key"] == "hc903-fixture-owner-b" for anchor in credential_anchors(home))
    entries = json.loads((home / "auth.json").read_text())["credential_pool"]["zai"]
    assert [entry["secret_fingerprint"] for entry in entries if entry["source"] == "env:ZAI_API_KEY"] == ["sha256:" + hashlib.sha256(b"hc903-fixture-owner-b").hexdigest()[:16]]
    assert all("access_token" not in entry for entry in entries if entry["source"] == "env:ZAI_API_KEY")
    assert [entry["access_token"] for entry in entries if entry["source"] == "manual:api_key"] == ["hc903-fixture-manual"]
    removed = runtime.client.request("DELETE", "/api/env", json={"key": "ZAI_API_KEY"}, headers=runtime.headers(3, target))
    assert removed.status_code == 200, removed.text
    assert removed.json()["found"] is True
    assert removed.json()["model_mutation"] == {"target_id": target, "revision": 3}
    assert "ZAI_API_KEY" not in (home / ".env").read_text()
    assert all("api_key" not in anchor for anchor in credential_anchors(home))
    entries = json.loads((home / "auth.json").read_text())["credential_pool"]["zai"]
    assert [entry["source"] for entry in entries] == ["manual:api_key"]
    assert "zai" not in json.loads((home / "provider_models_cache.json").read_text())


def test_env_receipt_and_worker_use_same_body_profile(runtimes):
    from hermes_cli import profiles
    home, start = runtimes
    credential_fixture(home)
    other = profiles.create_profile("env-other", no_alias=True, no_skills=True)
    credential_fixture(other)
    runtime = start()
    target = runtime.target("env-other")
    before = {name: (home / name).read_bytes() for name in (".env", "config.yaml", "auth.json")}
    response = runtime.client.put("/api/env?profile=default", json={"profile": "env-other", "key": "ZAI_API_KEY", "value": "hc903-fixture-other"}, headers=runtime.headers(1, target))
    assert response.status_code == 200, response.text
    assert response.json()["model_mutation"] == {"target_id": target, "revision": 1}
    assert all((home / name).read_bytes() == content for name, content in before.items())
    assert all(anchor["api_key"] == "hc903-fixture-other" for anchor in credential_anchors(other))
