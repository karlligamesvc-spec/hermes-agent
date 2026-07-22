"""Prebuilt bundle release wiring — workflow gate + registration path B.

Two concerns, both deterministic and network-free:

* the `desktop-bundle.yml` workflow is wired into the engine release-tag chain,
  emits a per-platform registration payload, and re-verifies every published
  object per the hc-568 gate (HTTP 200 + positive Content-Length) — and stays a
  SEPARATE workflow from the source-tarball train so a bundle failure can't block
  the main release;
* `scripts/register_runtime_bundle.py` (path B, because the cloud endpoint is
  admin-JWT-authed) builds the right request body off COS and POSTs it to the
  right URL with the admin bearer, skipping unpublished platforms and propagating
  POST failures. Exercised with fake HTTP callables — the "fake dry-run" style.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
WORKFLOWS = REPO / ".github" / "workflows"
BUNDLE_WF = WORKFLOWS / "desktop-bundle.yml"
TARBALL_WF = WORKFLOWS / "publish-runtime-tarball.yml"


def _load_module(name, rel):
    spec = importlib.util.spec_from_file_location(name, REPO / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rb = _load_module("register_runtime_bundle", "scripts/register_runtime_bundle.py")


# ── workflow wiring ─────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def bundle_wf_text():
    return BUNDLE_WF.read_text(encoding="utf-8")


def test_bundle_workflow_fires_on_release_tag(bundle_wf_text):
    # The engine release ritual tags runtime-<sha8>; pushing that tag must fire
    # the per-OS bundle matrix (the "挂进发版流程" wiring).
    assert "tags:" in bundle_wf_text
    assert '"runtime-*"' in bundle_wf_text


def test_bundle_workflow_dropped_dead_branch_trigger(bundle_wf_text):
    # The pre-merge branch trigger is dead; it must not linger as a phantom.
    assert "codex/hc472-p1-bundle-build" not in bundle_wf_text


def test_final_verify_asserts_content_length_per_object(bundle_wf_text):
    # hc-568 gate applied per object: HEAD 200 + a positive Content-Length, so a
    # zero-byte publish (green coscli, empty object) reds the run.
    assert 'tolower($1)=="content-length:"' in bundle_wf_text
    assert "no positive Content-Length" in bundle_wf_text
    # curl -f + the explicit length check both propagate as a hard failure.
    assert "curl -fsSI --retry 3" in bundle_wf_text
    assert "exit 1" in bundle_wf_text


def test_workflow_emits_registration_payload(bundle_wf_text):
    # Path B: CI emits the request body and ships it in the meta artifact.
    assert "Emit registration payload" in bundle_wf_text
    # Referenced by the emit step AND the uploaded artifact path list.
    assert bundle_wf_text.count("register-payload.json") >= 2


def test_win_is_gate_mac_is_experimental(bundle_wf_text):
    # win-x64 is the acceptance gate (fails the workflow); mac legs are
    # experimental (their failure does not).
    assert "os: win, arch: x64, experimental: false" in bundle_wf_text
    assert "experimental: true" in bundle_wf_text


def test_bundle_leg_is_independent_of_tarball_train():
    # Structural independence: the bundle build/publish is NOT folded into the
    # source-tarball workflow, so a bundle failure reds only its own run.
    assert BUNDLE_WF.exists() and TARBALL_WF.exists()
    tarball = TARBALL_WF.read_text(encoding="utf-8")
    for marker in ("build-runtime-bundle", "register-payload", "desktop-bundle"):
        assert marker not in tarball


def test_release_runbook_documents_registration_and_gray_toggle():
    doc = (REPO / "docs" / "runtime-bundle-release.md").read_text(encoding="utf-8")
    assert "HERMES_BUNDLE_MODE" in doc  # gray-release toggle
    assert "register_runtime_bundle.py" in doc  # one-command registration
    assert "/api/v1/admin/runtime-versions/bundles" in doc  # the admin endpoint


# ── registration script ─────────────────────────────────────────────────────


def _manifest(os_name="win", arch="x64", commit="abc123def4567890"):
    key = commit[:12]
    base = f"runtime-bundle-{key}-{os_name}-{arch}"
    return {
        "schema": 1,
        "kind": "apexnodes-runtime-bundle",
        "framework": "hermes-agent",
        "key": key,
        "runtime_commit": commit,
        "os": os_name,
        "arch": arch,
        "min_desktop_version": "0.17.0",
        "archive": {"name": f"{base}.tar.gz", "sha256": "d" * 64, "size": 4096},
    }


def _fake_get(routes):
    """routes: {url: (status, body_bytes)}; anything else → 404."""

    def get(url, timeout=30):
        return routes.get(url, (404, b""))

    return get


def _manifest_url(platform, key, cos_base=rb.DEFAULT_COS_BASE):
    return f"{cos_base}/bundle/{rb.FRAMEWORK}/{key}/{platform}/manifest.json"


def test_platform_set_matches_cloud_model():
    # Guard: parity with app/models/runtime_version.py RUNTIME_VERSION_BUNDLE_PLATFORMS.
    assert rb.DEFAULT_PLATFORMS == ("win-x64", "mac-arm64", "mac-x64")


def test_bundle_prefix_matches_cos_convention():
    # Same path apexnodes-environment.yaml + desktop-bundle.yml publish to.
    assert rb.bundle_prefix("abc123def456", "win-x64") == "bundle/hermes-agent/abc123def456/win-x64"


def test_derive_payload_from_cos_builds_expected_body():
    man = _manifest("win", "x64")
    key = man["key"]
    url = _manifest_url("win-x64", key)
    get = _fake_get({url: (200, json.dumps(man).encode())})

    payload = rb.derive_payload_from_cos(rb.DEFAULT_COS_BASE, key, "win-x64", http_get=get)

    assert payload["platform"] == "win-x64"
    assert payload["runtime_key"] == man["runtime_commit"]
    assert payload["sha256"] == man["archive"]["sha256"]
    assert payload["bundle_url"] == (
        f"{rb.DEFAULT_COS_BASE}/bundle/hermes-agent/{key}/win-x64/{man['archive']['name']}"
    )
    assert payload["min_desktop_version"] == "0.17.0"
    assert payload["schema_version"] == "1"
    assert payload["manifest"] == man


def test_derive_returns_none_when_platform_not_published():
    # A P2 leg that never uploaded a manifest → skipped, not an error.
    get = _fake_get({})  # everything 404s
    assert rb.derive_payload_from_cos(rb.DEFAULT_COS_BASE, "abc123def456", "mac-x64", http_get=get) is None


def test_derive_rejects_invalid_platform():
    with pytest.raises(ValueError):
        rb.derive_payload_from_cos(rb.DEFAULT_COS_BASE, "abc123def456", "linux-x64", http_get=_fake_get({}))


def test_derive_raises_on_manifest_missing_archive():
    man = _manifest()
    del man["archive"]
    key = man["key"]
    get = _fake_get({_manifest_url("win-x64", key): (200, json.dumps(man).encode())})
    with pytest.raises(RuntimeError):
        rb.derive_payload_from_cos(rb.DEFAULT_COS_BASE, key, "win-x64", http_get=get)


def test_derive_runtime_key_override_wins():
    man = _manifest()
    key = man["key"]
    get = _fake_get({_manifest_url("win-x64", key): (200, json.dumps(man).encode())})
    payload = rb.derive_payload_from_cos(
        rb.DEFAULT_COS_BASE, key, "win-x64", runtime_key="v2026.7.19-fork.abc12345", http_get=get
    )
    assert payload["runtime_key"] == "v2026.7.19-fork.abc12345"


def test_post_registration_targets_admin_endpoint_with_bearer():
    seen = {}

    def post(url, body, token, timeout=30):
        seen["url"] = url
        seen["body"] = body
        seen["token"] = token
        return 201, "{}"

    status, _ = rb.post_registration("https://apex-nodes.com/", "JWT123", {"platform": "win-x64"}, http_post=post)
    assert status == 201
    assert seen["url"] == "https://apex-nodes.com/api/v1/admin/runtime-versions/bundles"
    assert seen["token"] == "JWT123"
    assert seen["body"] == {"platform": "win-x64"}


def test_main_dry_run_posts_nothing():
    man = _manifest()
    key = man["key"]
    get = _fake_get({_manifest_url("win-x64", key): (200, json.dumps(man).encode())})

    def boom(*a, **k):  # POST must not be reached in a dry run
        raise AssertionError("dry-run must not POST")

    rc = rb.main(["--key", key, "--platforms", "win-x64", "--dry-run"], http_get=get, http_post=boom)
    assert rc == 0


def test_main_registers_published_and_skips_unpublished():
    win = _manifest("win", "x64")
    mac = _manifest("mac", "arm64")
    key = win["key"]
    routes = {
        _manifest_url("win-x64", key): (200, json.dumps(win).encode()),
        _manifest_url("mac-arm64", key): (200, json.dumps(mac).encode()),
        # mac-x64 intentionally absent → 404 → skipped
    }
    posted = []

    def post(url, body, token, timeout=30):
        posted.append(body["platform"])
        return 201, "{}"

    rc = rb.main(
        ["--key", key, "--api-base", "https://apex-nodes.com", "--token", "JWT"],
        http_get=_fake_get(routes),
        http_post=post,
    )
    assert rc == 0
    assert sorted(posted) == ["mac-arm64", "win-x64"]


def test_main_propagates_post_failure():
    man = _manifest()
    key = man["key"]
    get = _fake_get({_manifest_url("win-x64", key): (200, json.dumps(man).encode())})

    def post(url, body, token, timeout=30):
        return 500, "boom"

    rc = rb.main(
        ["--key", key, "--platforms", "win-x64", "--api-base", "https://apex-nodes.com", "--token", "JWT"],
        http_get=get,
        http_post=post,
    )
    assert rc == 1


def test_main_requires_token_unless_dry_run():
    rc = rb.main(["--key", "abc123def456", "--platforms", "win-x64"], http_get=_fake_get({}), http_post=None)
    assert rc == 2


def test_main_requires_key_or_payload_dir():
    rc = rb.main([], http_get=_fake_get({}), http_post=None)
    assert rc == 2


def test_main_no_published_platforms_is_error():
    # key given, but nothing on COS for any platform → nonzero (nothing to do).
    rc = rb.main(
        ["--key", "abc123def456", "--api-base", "https://apex-nodes.com", "--token", "JWT"],
        http_get=_fake_get({}),
        http_post=lambda *a, **k: (201, "{}"),
    )
    assert rc == 1


def test_payload_dir_roundtrip_and_post(tmp_path):
    win = {"runtime_key": "c" * 40, "platform": "win-x64", "bundle_url": "https://x/win", "sha256": "d" * 64}
    mac = {"runtime_key": "c" * 40, "platform": "mac-arm64", "bundle_url": "https://x/mac", "sha256": "e" * 64}
    (tmp_path / "runtime-bundle-win.tar.gz.register-payload.json").write_text(json.dumps(win))
    (tmp_path / "runtime-bundle-mac.tar.gz.register-payload.json").write_text(json.dumps(mac))

    loaded = rb.load_payloads_from_dir(str(tmp_path))
    assert {p["platform"] for p in loaded} == {"win-x64", "mac-arm64"}

    posted = []

    def post(url, body, token, timeout=30):
        posted.append(body["platform"])
        return 201, "{}"

    rc = rb.main(
        ["--payload-dir", str(tmp_path), "--api-base", "https://apex-nodes.com", "--token", "JWT"],
        http_post=post,
    )
    assert rc == 0
    assert sorted(posted) == ["mac-arm64", "win-x64"]
