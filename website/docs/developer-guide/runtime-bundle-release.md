# Runtime bundle release runbook

How the prebuilt, self-contained desktop runtime bundles get built, published,
registered, and rolled out. Companion to the source-tarball train
(`scripts/publish-runtime-tarball.sh` / `publish-runtime-tarball.yml`), which is
unchanged and independent.

Design background: hermes-cloud `docs/work-notes/DESIGN-hc472-runtime-bundle.md`.

## 1. Build + publish (automated)

Workflow: `.github/workflows/desktop-bundle.yml`. Per-OS matrix — one job each
for `win-x64` (acceptance gate), `mac-arm64`, `mac-x64` (both experimental for
now; their failure does not fail the workflow).

Job graph (per OS, all on the native runner):

```
build (build-runtime-bundle.mjs)
  → smoke (extract → fixup → verify → probe → MOVE → re-probe)
  → emit register-payload.json
  → publish tarball + .sha256 + manifest.json to COS
       bundle/hermes-agent/<key>/<os>-<arch>/
  → final-verify each object: HEAD 200 + positive Content-Length + sha match
```

The final-verify step is the hc-568 gate applied per object: a green `coscli cp`
is not proof the object is publicly downloadable, so each object is re-fetched
from its public URL and must return HTTP 200 with a positive `Content-Length`
(catches the zero-byte publish), and the tarball's remote `.sha256` must equal
the locally built hash. Any miss exits 1 and reds that bundle run.

### Triggers

* **Release tag** — pushing `runtime-<sha8>` (the tag the engine train already
  creates before flipping default) auto-fires the matrix on that commit.
* **Manual** — `workflow_dispatch` with an optional `ref` / `min_desktop_version`
  / `uv_version`, to rebuild a bundle for any commit without re-tagging.

`desktop-bundle.yml` is a **separate workflow** from `publish-runtime-tarball.yml`.
A bundle failure reds only the bundle run; it never blocks the source-tarball
release or the default flip.

## 2. Register with the cloud (one command)

The cloud endpoint `POST /api/v1/admin/runtime-versions/bundles` is
**admin-JWT-authed**, so CI does not hold a credential for it (a full-admin
session token in a public-repo Action would over-scope, and JWTs expire). CI
instead publishes to COS and emits a `*.register-payload.json` per platform (in
the run's `runtime-bundle-meta-*` artifact). The release engineer — who already
holds an admin session to flip `is_default` — registers them:

```bash
# Preview first (no token, no POST): derive each published platform's body
# straight off COS by bundle key (runtime sha12).
python3 scripts/register_runtime_bundle.py --key <sha12> --dry-run

# Register (win-x64 + whichever mac legs published):
python3 scripts/register_runtime_bundle.py \
    --key <sha12> \
    --api-base https://apex-nodes.com \
    --token "$ADMIN_JWT"
```

`--token` is an admin JWT (the same bearer used to flip default). A platform with
no manifest on COS (e.g. an unshipped mac leg) is skipped, not failed. A re-run
is safe — the endpoint upserts on `(runtime_version, platform)`.

Alternative input, if you prefer the bytes captured at build time over a COS
round-trip: download the run's `runtime-bundle-meta-*` artifact and point the
script at the folder — it POSTs the emitted payloads verbatim.

```bash
python3 scripts/register_runtime_bundle.py \
    --payload-dir ./meta --api-base https://apex-nodes.com --token "$ADMIN_JWT"
```

Registration is additive: `GET /api/v1/runtime/latest` only starts carrying a
`bundles` key once a platform is registered, and pre-bundle-mode desktop clients
see no shape change.

## 3. Gray release (opt-in, default off)

The desktop consumer path is gated behind `HERMES_BUNDLE_MODE` and is a strict
no-op when unset (the default). Nothing about the default install/update path
changes until an operator opts a machine in.

Enable on one machine:

| OS | how |
|---|---|
| macOS / Linux | launch the app with `HERMES_BUNDLE_MODE=1` in the environment (e.g. `HERMES_BUNDLE_MODE=1 open -a ApexNodes`, or export it in the launching shell / a LaunchAgent) |
| Windows | set the user env var `HERMES_BUNDLE_MODE=1` (`setx HERMES_BUNDLE_MODE 1`, then relaunch) |

Accepted truthy values: `1`, `true`, `on`, `yes` (case-insensitive). Anything
else — including unset — is off.

When on, the app uses the versioned-catalog bundle path (download-resume →
never-extract-in-place stage → fixup/verify → atomic pointer switch, with
rollback + startup GC). Any bundle-path failure falls back cleanly to the
existing install chain, so a bundle attempt can never brick a working install.

To turn it back off, clear the variable (`unset HERMES_BUNDLE_MODE` /
`setx HERMES_BUNDLE_MODE ""`) and relaunch.

### Pre-flip environment gate

Before flipping `is_default` to a version, confirm every acceptance-leg bundle is
publicly intact (hc-448-class guard, independent of the publish run):

```bash
python3 scripts/verify-environment.py --check-bundles --bundle-key <sha12> --bundle-os win
```
