#!/usr/bin/env python3
"""register_runtime_bundle.py — register desktop runtime bundles with the cloud.

Path B of the bundle release wiring. The cloud endpoint
``POST /api/v1/admin/runtime-versions/bundles`` is admin-JWT-authed
(``require_admin_user``), so the fork's public-repo CI can NOT safely hold a
credential to call it — a full-admin session token in a GitHub Action would
over-scope massively and JWTs expire anyway. Instead ``desktop-bundle.yml``
publishes the bundles to COS + emits a ``*.register-payload.json`` per platform,
and this script — run once by the release engineer, who already holds an admin
session to flip ``is_default`` — turns those into the registration POSTs with a
single command.

Two input modes:

  * default (COS-derived): given the bundle ``--key`` (runtime sha12), fetch each
    platform's ``manifest.json`` off COS and build the request body (bundle_url +
    sha256 + manifest + min_desktop_version). One command, no artifact download.

  * ``--payload-dir``: POST the exact ``*.register-payload.json`` files the
    workflow already emitted (downloaded from the run's meta artifact) — no COS
    round-trip, the body is used verbatim.

``--dry-run`` builds the bodies and prints them, but posts nothing (and needs no
token) — the "fake dry-run" the tests exercise.

Usage:
  # derive from COS by key and register every published platform:
  python3 scripts/register_runtime_bundle.py \
      --key <sha12> --api-base https://apex-nodes.com --token "$ADMIN_JWT"

  # register the exact payloads the workflow emitted (meta artifact):
  python3 scripts/register_runtime_bundle.py \
      --payload-dir ./meta --api-base https://apex-nodes.com --token "$ADMIN_JWT"

  # preview only, no network POST:
  python3 scripts/register_runtime_bundle.py --key <sha12> --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Same public-read bucket the bundle build/publish + verify legs use
# (desktop-bundle.yml). Bundle objects live under the host ROOT, so this base has
# NO trailing /runtime prefix (that prefix is for the source tarball).
DEFAULT_COS_BASE = "https://apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com"
FRAMEWORK = "hermes-agent"
# Mirror app/models/runtime_version.py::RUNTIME_VERSION_BUNDLE_PLATFORMS.
DEFAULT_PLATFORMS = ("win-x64", "mac-arm64", "mac-x64")
VALID_PLATFORMS = frozenset(DEFAULT_PLATFORMS)
REGISTER_PATH = "/api/v1/admin/runtime-versions/bundles"


def _http_get(url, timeout=30):
    """(status, body_bytes). status 0 / body b'' on any transport error."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception:
        return 0, b""


def _http_post_json(url, body, token, timeout=30):
    """(status, response_text). Raises nothing — transport errors surface as
    status 0 so the caller reports them uniformly with HTTP errors."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001 — surface as a non-2xx for the caller
        return 0, str(e)


def bundle_prefix(key, platform):
    return f"bundle/{FRAMEWORK}/{key}/{platform}"


def derive_payload_from_cos(cos_base, key, platform, runtime_key=None, *, http_get=_http_get):
    """Build the registration body for one platform from its COS manifest.json.

    Returns the dict, or ``None`` when the platform's manifest is not on COS
    (e.g. a P2 leg that was never published) — the caller skips it. Raises on a
    manifest that is present but unreadable/misshapen (a real error, not a
    not-published skip).
    """
    if platform not in VALID_PLATFORMS:
        raise ValueError(f"invalid platform {platform!r}: expected one of {sorted(VALID_PLATFORMS)}")
    base = cos_base.rstrip("/")
    prefix = bundle_prefix(key, platform)
    man_url = f"{base}/{prefix}/manifest.json"
    status, body = http_get(man_url)
    if status == 404:
        return None
    if not (200 <= status < 300) or not body:
        raise RuntimeError(f"manifest fetch failed for {platform}: HTTP {status} at {man_url}")
    manifest = json.loads(body.decode("utf-8"))
    archive = manifest.get("archive") or {}
    archive_name = archive.get("name")
    sha256 = archive.get("sha256")
    if not archive_name or not sha256:
        raise RuntimeError(f"manifest for {platform} missing archive.name/archive.sha256 ({man_url})")

    payload = {
        # runtime_key resolves the RuntimeVersion cloud-side (commit-prefix match
        # in get_runtime_version_by_key); default to the manifest's own commit.
        "runtime_key": runtime_key or manifest.get("runtime_commit") or key,
        "platform": platform,
        "bundle_url": f"{base}/{prefix}/{archive_name}",
        "sha256": sha256,
        "manifest": manifest,
    }
    mdv = manifest.get("min_desktop_version")
    if mdv:
        payload["min_desktop_version"] = mdv
    schema = manifest.get("schema")
    if schema not in (None, ""):
        payload["schema_version"] = str(schema)
    return payload


def load_payloads_from_dir(directory):
    """Load the ``*.register-payload.json`` bodies the workflow emitted."""
    paths = sorted(Path(directory).glob("*.register-payload.json"))
    if not paths:
        raise FileNotFoundError(f"no *.register-payload.json under {directory}")
    return [json.loads(p.read_text(encoding="utf-8")) for p in paths]


def post_registration(api_base, token, payload, *, http_post=_http_post_json):
    """POST one payload; returns (status, response_text). 201 = registered."""
    url = api_base.rstrip("/") + REGISTER_PATH
    return http_post(url, payload, token)


def gather_payloads(args, *, http_get=_http_get):
    """Resolve the list of registration bodies from whichever input mode is set."""
    if args.payload_dir:
        return load_payloads_from_dir(args.payload_dir)
    platforms = [p.strip() for p in args.platforms.split(",") if p.strip()]
    payloads = []
    for platform in platforms:
        payload = derive_payload_from_cos(
            args.cos_base, args.key, platform, runtime_key=args.runtime_key, http_get=http_get
        )
        if payload is None:
            print(f"  skip {platform}: no manifest on COS (not published for this key)")
            continue
        payloads.append(payload)
    return payloads


def build_arg_parser():
    ap = argparse.ArgumentParser(description="Register desktop runtime bundles with the cloud (path B).")
    ap.add_argument("--key", help="bundle key = runtime sha12 (COS-derive mode)")
    ap.add_argument("--runtime-key", help="override the RuntimeVersion key sent to cloud (default: manifest runtime_commit)")
    ap.add_argument("--payload-dir", help="register the workflow's emitted *.register-payload.json files instead of deriving from COS")
    ap.add_argument("--platforms", default=",".join(DEFAULT_PLATFORMS), help=f"comma-separated (default: {','.join(DEFAULT_PLATFORMS)})")
    ap.add_argument("--cos-base", default=DEFAULT_COS_BASE, help="COS host base for manifest lookup")
    ap.add_argument("--api-base", default="https://apex-nodes.com", help="cloud API base (default: https://apex-nodes.com)")
    ap.add_argument("--token", help="admin JWT bearer token (required unless --dry-run)")
    ap.add_argument("--dry-run", action="store_true", help="print the registration bodies; POST nothing")
    return ap


def main(argv=None, *, http_get=_http_get, http_post=_http_post_json):
    args = build_arg_parser().parse_args(argv)
    if not args.key and not args.payload_dir:
        print("register_runtime_bundle: need --key (COS-derive) or --payload-dir", file=sys.stderr)
        return 2
    if not args.dry_run and not args.token:
        print("register_runtime_bundle: --token is required (or use --dry-run to preview)", file=sys.stderr)
        return 2

    try:
        payloads = gather_payloads(args, http_get=http_get)
    except (RuntimeError, ValueError, FileNotFoundError, json.JSONDecodeError) as e:
        print(f"register_runtime_bundle: {e}", file=sys.stderr)
        return 1

    if not payloads:
        print("register_runtime_bundle: no bundles to register (nothing published for this key)", file=sys.stderr)
        return 1

    if args.dry_run:
        print(f"=== DRY RUN — {len(payloads)} registration body(ies), POST skipped ===")
        for payload in payloads:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    failures = []
    for payload in payloads:
        status, text = post_registration(args.api_base, args.token, payload, http_post=http_post)
        platform = payload.get("platform", "?")
        if status == 201 or 200 <= status < 300:
            print(f"  registered {platform}: HTTP {status}")
        else:
            print(f"  FAILED {platform}: HTTP {status} {text[:300]}", file=sys.stderr)
            failures.append(platform)

    if failures:
        print(f"register_runtime_bundle: {len(failures)} platform(s) failed: {', '.join(failures)}", file=sys.stderr)
        return 1
    print(f"register_runtime_bundle: registered {len(payloads)} platform(s) OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
