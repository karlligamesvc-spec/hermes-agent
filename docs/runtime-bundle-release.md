# Runtime bundle release runbook

## Engines embedded in Desktop installers

The Desktop release (`desktop-release.yml`) builds a complete native engine for
Mac arm64 before packaging the shell. Mac x64 stopped after 0.17.63 and Windows
x64 is paused after 0.17.66; `desktop-windows.yml` still builds a Windows engine
and installer when dispatched directly, as diagnostic artifacts only. The engine
source is pinned by `apps/desktop/bundled-runtime.json`; it can intentionally
differ from the Desktop shell's source commit. Every installer must carry the
pinned full engine commit and release label. Changing the pin does not change
the Cloud default runtime.

The pin's `supersedes` map (full commit -> release label) lists engines the pin
descends from. On start, the shell replaces an installed engine whose source
stamp is on that list even when its version marker is missing or names another
engine (hc-1033: a deleted marker otherwise kept a machine on its old engine
for good). When a bump moves the pin, add the outgoing pin and any other
engine a published Desktop or the runtime-update channel shipped since, but
only commits that are git ancestors of the new pin: an engine built from a
side branch is not proven older. `readBundledRuntimePin` rejects a row whose
label names another commit or a later day than the pin, and
`npm run test:release-gates` checks ancestry in a full clone (CI checkouts are
shallow and skip that step).

`Resources/bundled-runtime/` contains the compressed native archive,
`manifest.json` and `release.json`. The archive includes CPython, its locked
Python dependencies, portable Node, uv, ripgrep, and on Windows PortableGit
including Bash. Chromium and optional browser downloads retain their existing
first-use behavior; embedding the engine does not make every browser tool
available offline.

The archive leaves out what no installed engine reads: the pytest suite,
contributor metadata, docs-site images, Desktop QA evidence, Node's C headers,
agent-browser builds no launcher on the target can select, and the repo's npm
build trees (the TUI ships compiled in `hermes_cli/tui_dist`, and every other
frontend build refuses inside an installed engine).
`BUNDLE_EXCLUDED_PATHS` in `scripts/build-runtime-bundle.mjs` is the list, and
`apps/desktop/scripts/runtime-bundle-slim.node-test.mjs` keeps every path a
runtime reader needs out of it.

The native build runs extraction, fixup, per-file verification, real imports,
CLI/tool probes, relocation and the probes again. Windows Bash is executed with
a PATH containing only its bundled directories. Mac Mach-O executables and
libraries are signed before the files index is generated; the signed payload
ZIP must receive an Accepted notarization result with no issues. The resulting
tar is not a stapled artifact. The outer App still follows its own notarization
and Gatekeeper gates.

`beforePack`, `afterPack` and the native workflows independently check the actual
resource archive's size, SHA256, native target, full source stamp and required
executables. Missing, unlocked, wrong-source or wrong-architecture payloads
reject packaging. The release's final job also compares the embedded engine
commit and label with the pin.

An installed engine is never a frontend build tree: Desktop keeps the previous one
for rollback, and reinstalling a version already on disk re-verifies every file
and rejects a changed tree. (Desktop also starts a verify at every launch, but
through the engine link the builder's main-module check fails, so that verify
exits without hashing anything; fixing it is a separate decision.) The archive
carries the compiled TUI at `hermes_cli/tui_dist` (built from the pinned source
in a scratch copy with the bundled Node; upstream's sealed payloads use the same
layout), and `hermes --tui` runs it on `.runtime/node`. Every other frontend build
(`hermes dashboard`, `hermes --tui --dev`, `hermes desktop`, an update's product
builds) refuses inside an installed engine before it downloads anything
(`apex_overlay/packaged_engine.py`). The native smoke checks at both locations
that the TUI resolves to the shipped build and loads on the bundled Node.

Native build command (the Mac invocation requires the existing signing
certificate and Apple API key file variables):

```bash
node apps/desktop/scripts/bundled-runtime-package.mjs build /private/tmp/apex-engine --notarize
```

On Windows omit `--notarize`. Small manifest, signature/notary and package
verification receipts are uploaded alongside each workflow run; the large
archive travels inside the installer rather than as a separate GitHub artifact.

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
