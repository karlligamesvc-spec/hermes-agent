"""Actual credential/tool routes: preparation outside the owner-write boundary."""

from concurrent.futures import ThreadPoolExecutor
import contextlib
import hashlib
import json

import httpx
import pytest

from tests.hermes_cli.test_web_model_mutations import (
    assignment, credential_anchors, credential_fixture, disk, runtimes,
)


# hc-1203: v0.23.0 moved Copilot (and the token exchange this test also blocked) out of core into the
# github-copilot plugin; Z.AI's endpoint probe is the env preparation core still does over the network.
@pytest.mark.parametrize("provider,key", [("zai", "ZAI_API_KEY")])
@pytest.mark.parametrize("newer", ["assignment", "fence"])
def test_env_network_preparation_never_writes_after_new_owner(runtimes, provider, key, newer):
    home, start = runtimes
    credential_fixture(home)
    original = "hc903-fixture-env-original"
    (home / ".env").write_text(f"{key}={original}\n")
    runtime = start("env-preparation")
    target = runtime.target()
    before = {name: (home / name).read_bytes() for name in (".env", "config.yaml", "auth.json")}
    with ThreadPoolExecutor() as pool:
        old = pool.submit(runtime.client.put, "/api/env", json={"key": key, "value": "hc903-fixture-owner-a"}, headers=runtime.headers(1, target))
        runtime.wait("pricing_entered")
        assert all((home / name).read_bytes() == content for name, content in before.items())
        try:
            if newer == "assignment":
                response = runtime.client.put("/api/env", json={"key": key, "value": "hc903-fixture-owner-b"}, headers=runtime.headers(2, target))
                assert response.status_code == 200, response.text
                assert response.json()["model_mutation"] == {"target_id": target, "revision": 2}
            else:
                response = runtime.client.post("/api/model/mutation/fence", json={}, headers=runtime.headers(2, target))
                assert response.json() == {"ok": True, "revision": 2, "target_id": target}
            assert not old.done()
            settled = {name: (home / name).read_bytes() for name in before}
        finally:
            runtime.client.post("/__fixture/release")
        stale = old.result(timeout=10)
    assert stale.status_code == 409, stale.text
    assert stale.json() == {"detail": {"code": "model_mutation_superseded"}}
    assert all((home / name).read_bytes() == content for name, content in settled.items())
    if newer == "assignment":
        assert all(anchor["api_key"] == "hc903-fixture-owner-b" for anchor in credential_anchors(home))
        store = json.loads((home / "auth.json").read_text())
        entries = store["credential_pool"][provider]
        token = "hc903-fixture-owner-b"
        selected = [entry for entry in entries if entry["source"] == "env:" + key]
        assert len(selected) == 1
        assert selected[0]["secret_fingerprint"] == "sha256:" + hashlib.sha256(token.encode()).hexdigest()[:16]
        assert selected[0]["base_url"] == "https://fixture.zai.invalid/v4"
        assert "access_token" not in selected[0]


def test_env_pool_failure_keeps_pending_without_ack_then_explicit_retry_settles(runtimes):
    home, start = runtimes
    credential_fixture(home)
    runtime = start("env-persist")
    target = runtime.target()
    response = runtime.client.put("/api/env", json={"key": "ZAI_API_KEY", "value": "hc903-fixture-owner-b"}, headers=runtime.headers(1, target))
    assert response.status_code == 500, response.text
    assert "model_mutation" not in response.text
    # Existing multi-file lifecycle can partially replace .env/YAML before pool
    # failure. It cannot claim settlement; the explicit higher receipt repairs it.
    assert all(anchor["api_key"] == "hc903-fixture-owner-b" for anchor in credential_anchors(home))
    retried = runtime.client.put("/api/env", json={"key": "ZAI_API_KEY", "value": "hc903-fixture-owner-b"}, headers=runtime.headers(2, target))
    assert retried.status_code == 200, retried.text
    assert retried.json()["model_mutation"] == {"target_id": target, "revision": 2}
    selected = [entry for entry in json.loads((home / "auth.json").read_text())["credential_pool"]["zai"] if entry["source"] == "env:ZAI_API_KEY"]
    assert selected[0]["secret_fingerprint"] == "sha256:" + hashlib.sha256(b"hc903-fixture-owner-b").hexdigest()[:16]


def test_cancelled_env_http_keeps_worker_guard_through_all_credential_writes(runtimes):
    home, start = runtimes
    credential_fixture(home)
    a, b = start("env-write"), start()
    target = a.target()
    with ThreadPoolExecutor() as pool:
        old = pool.submit(a.client.put, "/api/env", json={"key": "ZAI_API_KEY", "value": "hc903-fixture-owner-a"}, headers=a.headers(1, target))
        a.wait("write_entered")
        assert a.client.post("/__fixture/cancel").status_code == 200
        a.wait("task_cancelled")
        fence = pool.submit(b.client.post, "/api/model/mutation/fence", json={}, headers=b.headers(2, target))
        b.wait("admit_entered")
        try:
            with pytest.raises(TimeoutError):
                fence.result(timeout=2)
        finally:
            a.client.post("/__fixture/release")
        assert fence.result(timeout=10).json() == {"ok": True, "revision": 2, "target_id": target}
        a.wait("worker_finished")
        with contextlib.suppress(httpx.HTTPError):
            assert old.result(timeout=10).status_code == 500
    assert all(anchor["api_key"] == "hc903-fixture-owner-a" for anchor in credential_anchors(home))
    entries = json.loads((home / "auth.json").read_text())["credential_pool"]["zai"]
    assert [entry["secret_fingerprint"] for entry in entries if entry["source"] == "env:ZAI_API_KEY"] == ["sha256:" + hashlib.sha256(b"hc903-fixture-owner-a").hexdigest()[:16]]


@pytest.mark.parametrize("kind", ["model", "provider"])
def test_slow_tool_catalog_selection_cannot_restore_previous_owner_model(runtimes, kind):
    home, start = runtimes
    runtime = start("tool-" + kind + "-preparation")
    target = runtime.target()
    if kind == "model":
        catalog = runtime.client.get("/api/tools/toolsets/image_gen/models", params={"provider": "OpenAI"})
        assert catalog.status_code == 200, catalog.text
        payload = {"provider": "OpenAI", "model": catalog.json()["models"][0]["id"]}
    else:
        payload = {"provider": "OpenAI"}
    with ThreadPoolExecutor() as pool:
        old = pool.submit(runtime.client.put, "/api/tools/toolsets/image_gen/" + kind, json=payload, headers=runtime.headers(1, target))
        runtime.wait("pricing_entered")
        try:
            newer = runtime.client.post("/api/model/set", json=assignment("owner-b", confirm_expensive_model=True), headers=runtime.headers(2, target))
            assert newer.status_code == 200, newer.text
            assert not old.done()
        finally:
            runtime.client.post("/__fixture/release")
        stale = old.result(timeout=10)
    assert stale.status_code == 409, stale.text
    assert disk(home)["model"]["default"] == "owner-b"
    assert disk(home)["custom_providers"][0]["model"] == "owner-b"
    retried = runtime.client.put("/api/tools/toolsets/image_gen/" + kind, json=payload, headers=runtime.headers(3, target))
    assert retried.status_code == 200, retried.text
    assert retried.json()["model_mutation"] == {"target_id": target, "revision": 3}
    assert disk(home)["model"]["default"] == "owner-b"
    assert disk(home)["image_gen"][kind] == (payload[kind] if kind == "model" else "openai")


def test_tool_env_shared_llm_key_is_fenced_after_category_preparation(runtimes):
    home, start = runtimes
    credential_fixture(home)
    (home / ".env").write_text("OPENAI_API_KEY=hc903-fixture-env-original\n")
    runtime = start("tool-env-preparation")
    target = runtime.target()
    with ThreadPoolExecutor() as pool:
        old = pool.submit(runtime.client.put, "/api/tools/toolsets/image_gen/env", json={"env": {"OPENAI_API_KEY": "hc903-fixture-owner-a"}}, headers=runtime.headers(1, target))
        runtime.wait("pricing_entered")
        try:
            newer = runtime.client.put("/api/env", json={"key": "OPENAI_API_KEY", "value": "hc903-fixture-owner-b"}, headers=runtime.headers(2, target))
            assert newer.status_code == 200, newer.text
            assert not old.done()
            before = {name: (home / name).read_bytes() for name in (".env", "config.yaml", "auth.json")}
        finally:
            runtime.client.post("/__fixture/release")
        stale = old.result(timeout=10)
    assert stale.status_code == 409, stale.text
    assert all((home / name).read_bytes() == content for name, content in before.items())
    retried = runtime.client.put("/api/tools/toolsets/image_gen/env", json={"env": {"OPENAI_API_KEY": "hc903-fixture-owner-c"}}, headers=runtime.headers(3, target))
    assert retried.status_code == 200, retried.text
    assert retried.json()["model_mutation"] == {"target_id": target, "revision": 3}
    assert all(anchor["api_key"] == "hc903-fixture-owner-c" for anchor in credential_anchors(home))
    entries = json.loads((home / "auth.json").read_text())["credential_pool"]["openai-api"]
    assert [entry["secret_fingerprint"] for entry in entries if entry["source"] == "env:OPENAI_API_KEY"] == ["sha256:" + hashlib.sha256(b"hc903-fixture-owner-c").hexdigest()[:16]]
    before = {name: (home / name).read_bytes() for name in (".env", "config.yaml", "auth.json")}
    rejected = runtime.client.put("/api/tools/toolsets/image_gen/env", json={"env": {"OPENAI_API_KEY": "bad", "PATH": "bad"}}, headers=runtime.headers(4, target))
    assert rejected.status_code == 400, rejected.text
    blank = runtime.client.put("/api/tools/toolsets/image_gen/env", json={"env": {"OPENAI_API_KEY": " "}}, headers=runtime.headers(5, target))
    assert blank.status_code == 200, blank.text
    assert blank.json()["saved"] == [] and blank.json()["skipped"] == ["OPENAI_API_KEY"]
    assert "model_mutation" not in blank.json()
    assert all((home / name).read_bytes() == content for name, content in before.items())


@pytest.mark.parametrize("value,override,expected", [
    ("sk-kimi-fixture", None, "https://api.kimi.com/coding"),
    ("fixture-legacy", None, "https://api.moonshot.ai/v1"),
    ("sk-kimi-fixture", "https://fixture.kimi.invalid/v1", "https://fixture.kimi.invalid/v1"),
])
def test_tagged_kimi_env_uses_real_prefix_and_explicit_url_precedence(runtimes, value, override, expected):
    home, start = runtimes
    env = "" if override is None else "KIMI_BASE_URL=" + override + "\n"
    (home / ".env").write_text(env)
    runtime = start()
    target = runtime.target()
    response = runtime.client.put("/api/env", json={"key": "KIMI_API_KEY", "value": value}, headers=runtime.headers(1, target))
    assert response.status_code == 200, response.text
    assert response.json()["model_mutation"] == {"target_id": target, "revision": 1}
    entry = json.loads((home / "auth.json").read_text())["credential_pool"]["kimi-coding"][0]
    assert entry["source"] == "env:KIMI_API_KEY" and entry["base_url"] == expected


@pytest.mark.parametrize("kind", ["model", "provider"])
def test_untagged_slow_tool_selection_merges_only_its_fields_into_latest_model(runtimes, kind):
    home, start = runtimes
    if kind == "model":
        catalog_reader = start()
        catalog = catalog_reader.client.get("/api/tools/toolsets/image_gen/models", params={"provider": "OpenAI"})
        assert catalog.status_code == 200, catalog.text
        payload = {"provider": "OpenAI", "model": catalog.json()["models"][0]["id"]}
    else:
        payload = {"provider": "OpenAI"}
    runtime = start("legacy-tool-" + kind + "-preparation")
    target = runtime.target()
    with ThreadPoolExecutor() as pool:
        old = pool.submit(runtime.client.put, "/api/tools/toolsets/image_gen/" + kind, json=payload)
        runtime.wait("pricing_entered")
        try:
            newer = runtime.client.post("/api/model/set", json=assignment("owner-b", confirm_expensive_model=True), headers=runtime.headers(1, target))
            assert newer.status_code == 200, newer.text
            assert not old.done()
            model = disk(home)["model"]
            providers = disk(home)["custom_providers"]
        finally:
            runtime.client.post("/__fixture/release")
        response = old.result(timeout=10)
    assert response.status_code == 200, response.text
    assert "model_mutation" not in response.json()
    assert disk(home)["model"] == model
    assert disk(home)["custom_providers"] == providers
    assert disk(home)["image_gen"][kind] == (payload[kind] if kind == "model" else "openai")


@pytest.mark.parametrize("corrupt", [b"{broken-json", b"\xffinvalid-utf8"])
def test_zai_prepare_never_quarantines_bad_auth_cache_before_owner_commit(runtimes, monkeypatch, corrupt):
    from agent.credential_pool import prepare_env_credential_pool_entries
    from hermes_cli import auth
    home, _ = runtimes
    (home / "auth.json").write_bytes(corrupt)
    before = {path.name: path.read_bytes() for path in home.iterdir() if path.is_file()}
    probes = []

    def probe(value):
        probes.append(value)
        return {"base_url": "https://fixture.zai.invalid/v4", "id": "fixture"}

    monkeypatch.setattr(auth, "detect_zai_endpoint", probe)
    result = prepare_env_credential_pool_entries("ZAI_API_KEY", "hc903-fixture-owner-a", ["zai"])
    assert probes == ["hc903-fixture-owner-a"]
    assert result[0]["payload"]["base_url"] == "https://fixture.zai.invalid/v4"
    assert {path.name: path.read_bytes() for path in home.iterdir() if path.is_file()} == before
    # Existing ordinary recovery still preserves the broken source. The new
    # prepare path neither changes that CLI behavior nor mocks copy2 away.
    assert auth._load_auth_store() == {"version": auth.AUTH_STORE_VERSION, "providers": {}}
    assert (home / "auth.json.corrupt").read_bytes() == corrupt
    assert (home / "auth.json").read_bytes() == corrupt


def test_a_plugin_registered_copilot_row_is_prepared_like_any_api_key_row(request, monkeypatch):
    """hc-1203: v0.23.0 deleted hermes_cli.copilot_auth, and the github-copilot plugin's provider joins
    PROVIDER_REGISTRY (hermes_cli/auth_plugin_providers.py). The hc-903 preparer kept a core-exchange branch
    that imported the deleted module: with the plugin installed, a Desktop write of COPILOT_GITHUB_TOKEN
    raised ModuleNotFoundError. Now the row is prepared with the raw token, as upstream's load_pool seeds it,
    and nothing is written before the owner's commit."""
    from agent import credential_pool
    from hermes_cli.auth import ProviderConfig
    home, _ = request.getfixturevalue("runtimes")  # by name: a `runtimes` parameter shadows the import (F811)
    row = ProviderConfig("copilot", "GitHub Copilot", "api_key", inference_base_url="https://fixture.copilot.invalid",
                         api_key_env_vars=("COPILOT_GITHUB_TOKEN",))
    monkeypatch.setitem(credential_pool.PROVIDER_REGISTRY, "copilot", row)
    before = {path.name: path.read_bytes() for path in home.iterdir() if path.is_file()}

    prepared = credential_pool.prepare_env_credential_pool_entries(
        "COPILOT_GITHUB_TOKEN", "ghu_hc903-fixture-owner-a", ["copilot"])

    assert [(p["provider"], p["source"], p["endpoint_state"]) for p in prepared] == [
        ("copilot", "env:COPILOT_GITHUB_TOKEN", None)]
    assert prepared[0]["payload"]["access_token"] == "ghu_hc903-fixture-owner-a"
    assert prepared[0]["payload"]["base_url"] == "https://fixture.copilot.invalid"
    assert {path.name: path.read_bytes() for path in home.iterdir() if path.is_file()} == before
