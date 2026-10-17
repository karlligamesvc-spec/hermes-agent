# hc-906: Hypit 0.3.1 compatibility

## Problem and result

The APEX 0.2 wrapper sent `--workspace` and generated legacy local provider names. Hypit 0.3.1 uses `--project`, `@hypit/media-local` and `@hypit/provider-html-local`. Capture is an independent CLI in both tested versions and accepts neither project selector. The launcher now adapts those boundaries without rewriting upstream packages or customer projects.

## Covered exits

| Exit | Behavior |
| --- | --- |
| Normal CLI (`runtime`, `programs`, `check`, `plan`, `build`, `get`) | Choose project-local executable before bundled; map project selector by actual version. |
| `version` / `--version` / `-v` | Select project executable but do not forward the selector to this standalone parser; verified native 0.2.17 and 0.3.1 discovery. |
| Capture screenshot/run | Consume explicit selector into working directory; preserve script arguments after `--`; retain managed browser injection. |
| `apex-prepare` / Python `prepare-hypit` | Version-specific profile for new projects, add 0.3 project marker while preserving other package fields. |
| Existing profiles | Preserve explicit `.hypit/runtime` selection and existing APEX profile. Old endpoints cannot silently use a new bundled runtime. |
| npm project pin | Reject installed-vs-lock mismatch or missing locked environment; do not install or alter locks. Yarn/pnpm locks are not parsed; installed project-local executable is honored, no lock is rewritten. |
| Candidate dependency source | 0.3.1 exact npm source/SRI and transitive package lock; no direct HyperFrames dependency is needed by the new HTML renderer. |
| Desktop release consumer | Candidate `desktop-lock.json` consumes the verified 0.3.1 COS slice, with Windows native acceptance explicitly pending and overall renderVerified=false. Production activation is separate. |
| Skills (companion cloud PR) | One version dispatcher; full original old and 0.3.1 guides/references remain available with pinned provenance and licenses. |

## Validation

On Mac arm64 with Node 22.23.1 and managed COS browser/FFmpeg:

- 0.3.1: APEX wrapper prepare → runtime use/up → check → plan → build → get → full video decode → frame extraction → screenshot → browser click/script arguments → runtime/program shutdown passed.
- Output: 5 seconds, 720×1280, 150 frames, H.264 + AAC; decoded mono audio RMS 2041.159, not silent.
- 0.3.1 video SHA256: `9f71e9dec3e1793f41ac559c144f36dff3bde9b17decb9b28697ad38dd9daa54`.
- 0.2.17: same wrapper lifecycle and browser interaction passed using an isolated staging root pointing read-only at the installed dependency package. Real customer settings were not changed.
- 0.2.17 video SHA256: `c80dea078e8b39184b6262cd38ef7d2f3f627237f201b223dfab6720e88751fd`.
- Unit regression: 2 Node tests, 14 Python tests passed; one Windows-only test skipped on Mac.
- Reverse validation in isolated copies: restoring old selector forwarding, forwarding selectors into capture, and disabling the lock mismatch check each make the Node regression fail. Each mutation asserts a unique matching anchor before it is applied.

Reproduction:

```sh
node --test scripts/media-tools/hypit-project.test.mjs
HERMES_PYTHON=/path/to/python3.12 scripts/run_tests.sh tests/apex_overlay/test_hypit_profile.py tests/apex_overlay/test_media_tools.py tests/scripts/test_media_tools_mirror.py -q
node scripts/media-tools/hypit-lifecycle-smoke.mjs RUNTIME_ROOT NEW_WORKSPACE
```

The lifecycle command writes `proof.json`, `smoke.log`, rendered MP4 and screenshots to a new workspace. It deliberately refuses to overwrite an existing workspace. Local proof roots were `hypit031-apex-compat-mac-arm64-r6` and `hypit031-legacy-acceptance-r4` under the task artifact directory.

## Release preparation follow-up (2026-10-12 Pacific)

- Companion cloud PR1000 now has successful backend and web CI (run38208344840, retried cancelled web job).
- The immutable npm candidate was prepared: 231 unique versions, 203 package names, 237 original lock entries independently rechecked against npm SRI. Lock SHA256: `3e2755518ddb4448e9303383fb0d969d52a20e9694e5f102e4343f291dd90bdd`. Preparation is local; COS publication/readback has not run.
- Mac x64 0.3.1 installed from the verified cache with `npm ci --offline`, then passed the full APEX lifecycle using x64 Node, Python, FFmpeg and managed COS Chrome. Execution was under Rosetta on Apple hardware, not physical Intel acceptance.
- x64 output: 5s, 720×1280, 150 frames, H.264/AAC, audio RMS 2043.816. Video SHA256: `f4c842e3f53deddd202863e16a9b278903c6ce321b02ce9950784b6f8743b557`.
- The user explicitly approved production publication and MacBook/RTX4060Ti acceptance. Both canonical devices were resolved. Windows responds via the registered read-only preflight, but the returned candidate metadata belongs to another commit and is not acceptance of this branch.
- Fork synchronized release dispatch still returns HTTP422 `Actions has been disabled for this repository`, although workflow/repository switches read enabled. Home Fleet still exposes only two fixed APEX preflight suites and explicitly refuses installer execution. No arbitrary remote shell was used to bypass that restriction.
- User approval is recorded; further approval is not needed. A registered build/install acceptance workflow or restored fork Actions is required to complete the paired release. Local status/proofs reside in the task's `hypit031-release` artifacts.

## Empty-cache registry consumption (2026-10-12 Pacific)

`scripts/media-tools/registry-install-smoke.mjs` exercises the runtime builder's
actual `npm install --ignore-scripts --registry … @hypit/hypit@0.3.1` path, using
a new HOME, empty npm cache and no inherited npm configuration. A loopback-only
registry serves the prepared mirror's independently SHA256/SRI-checked bytes;
the temporary response origin is rewritten without modifying mirror files.
Caller input cannot add commands or serve files outside that inventory.

- Native Mac arm64 and Rosetta x64 both installed successfully and ran the CLI.
  There were 339 and 338 registry requests respectively. Thirteen missing
  metadata probes are explicitly declared optional peers (Puppeteer's proxy/zip
  adapters, optional Vite plugins and optional WebSocket native addons), not
  missing locked tarballs. Unknown or required-package misses fail the check.
- Both freshly installed dependency trees then passed the complete APEX wrapper
  lifecycle, including audio/video rendering, decoding, screenshot, browser
  interaction and shutdown. Their rendered hashes match the previous arm64/x64
  outputs recorded above, with non-silent audio.
- Five registry regression tests plus two project-routing tests passed. Removing
  independent npm SRI validation or required-dependency precedence each makes
  exactly one regression fail; both fault injections assert unique anchors and
  landed bytes before execution.
- These checks verify prepared-registry consumption, not public COS upload,
  Windows native execution, physical Intel hardware or installed-app acceptance.
  The Home Fleet APEX registration remains preflight-only; no configuration,
  registered guard or service was altered to execute an unregistered build.

```sh
node --test scripts/media-tools/registry-install-smoke.test.mjs scripts/media-tools/hypit-project.test.mjs
node scripts/media-tools/registry-install-smoke.mjs PREPARED_MIRROR NEW_WORKSPACE
```

## Limits and release gate

This change adapts APEX's managed entry points, not every optional upstream command, SDK or third-party provider. Existing TypeScript components need the official SDK migration if the customer explicitly upgrades them. Studio UI, Windows native, physical Intel hardware and installed-client acceptance are not certified by these runs. Do not advertise CLI checks as complete provider/render acceptance.

Before default activation: retain license/source/provenance, finish Windows native lifecycle and paired installer/installed-client validation, and promote the candidate lock only against that evidence. No updater feed, default engine, production default media manifest or customer project pin is changed here.

## Local Desktop 0.17.57 build candidate

Owner authorized local MacBook builds as an alternative to waiting for the Mac Studio build environment. Both signed native runtime archives at `f043a490e0f8895425a20a69063cf56b2d7247d2` passed Apple notarization with zero issues, architecture/signature checks, offline backend boot, relocation, fresh/legacy install, data-preserving reopen and injected rollback. Both actual archived runtimes produced the same verified five-second H.264/AAC clip and browser interaction output as the earlier COS proofs. x64 runs under Rosetta, not physical Intel hardware.

Actual packaged App startup exposed a separate updater regression: a bundled `v2026.10.13` runtime offered the older public default `v2026.10.9` because discovery treated any changed source/version as an upgrade. The central discovery consumer now rejects a numerically older engine before compatibility prompts, while retaining same-day source updates and unknown-version behavior. Its new behavior test fails on the unfixed code; 94 relevant discovery/apply/runtime tests pass after the fix. Initial App builds from the earlier producer are superseded and cannot be released.

The runtime pin is unchanged by this Electron-only correction. Desktop App/DMG/ZIP must be rebuilt from the corrected producer and pass final App notarization, signature, packaged GUI startup/reopen and artifact readback gates. Windows native and server skill deployment remain required before paired public publication.

Smoke boundary: `npx vitest run --project electron electron/apex-runtime-latest.test.ts electron/runtime-update-apply.test.ts electron/runtime-version.test.ts electron/packaged-runtime.test.ts` protects older-default discovery, same-day updates, authoritative marker rereads and apply/compatibility behavior. It does not certify Windows installation, Apple signing/notarization, customer-account login or native rendering; those require actual produced artifacts.

Final package architecture inspection also found host arm64 node-pty files under the x64 App's extraResources fallback, even though the dist fallback was correctly staged as x64. The target staging owner now replaces both exits from the same validated package. A fixture switches arm64 to x64 and asserts both copied bytes and removal of the old architecture. Removing only the resource mirror in an isolated source copy (unique anchor and landed-byte assertions) leaves dist correct but makes the resource assertion fail. Native staging/before/after-pack tests pass 46 checks, and release gates pass. Both App packages must be rebuilt after this packaging correction; earlier x64 artifacts are not release-ready despite Apple acceptance.

## Actual COS publication and consumption (2026-10-13 Pacific)

The dependency candidate is now published to the immutable registry recorded in
`hypit031-cos-acceptance.json`: 231 package versions across 203 names, 435 objects.
Every object was anonymously read back in full and SHA256-checked after upload.
The publisher is the unchanged reviewed script, SHA256
`28dddcac27f14f76b4f4721aee38c9e6b3d718e6e442bb26aa2821d7e6e70b75`.
The existing default `media-tools/stable.json` remained byte-identical.

Mac arm64 and Rosetta x64 then installed 0.3.1 using that real public COS registry,
new HOME and empty npm caches. All 205 generated lock entries per target match
the fixed source version/SRI and resolve exclusively to the immutable COS slice.
Both COS-installed trees passed the complete wrapper lifecycle, including
non-silent audio/video rendering, full decode, frame extraction, screenshot,
browser interaction and shutdown. Their hashes match the prior outputs above.
This extends the earlier loopback-only proof; it does not convert it into a
Windows, physical Intel or installed-client claim.

Companion cloud PR1000 is merged as
`7dc1284c9a4d1ed19e32b27bbf2a9dee7598ade9`. The merged skill/contract/test files
match the validated source branch. Production deployment/resync has not run.
Fork PR389 remains a candidate. Current source still has Desktop0.17.56 and the
previous runtime pin, so it cannot be published as a new installer unchanged.

The full remaining sequence and structured receipts are retained under the
task artifact root in `RELEASE-TRACKING.md` and `release-status.json`. User release
authorization remains valid. Home Fleet exposes no registration/deployment
operation for APEX native build/install; enablement requires the control-plane
owner, and cannot be replaced by arbitrary SSH, repurposed tests or a new generic
remote executor.

## Synced onto the Hermes v0.22.2 base (2026-10-16)

`origin/main` at `e9f2351168` (hc-911: upstream v0.22.2 plus its follow-ups) was merged into this
branch as `a34113d12e`. There were no textual conflicts. Files changed on both sides were checked by hand:
`apex_overlay/media_tools.py` (v0.22's `pm.lazy_installs_allowed` and `stdin=DEVNULL` vs this
branch's `prepare_hypit`, in disjoint functions), `apps/desktop/package.json` (js-yaml 4.3.2 from
main, version 0.17.57 from here), `use-gateway-boot.test.tsx` and `package-lock.json`.

Validation on the merged tree (Mac arm64):

- A runtime bundle built from `a34113d12e` (`runtime-bundle-a34113d12ed3-mac-arm64.tar.gz`, 463.5
  MiB, CPython 3.14.7, Hypit 0.3.1 from the COS npm mirror) passed the relocation smoke at both
  locations, including an offline backend boot.
- The full `hypit-lifecycle-smoke.mjs` passed on that runtime. It covered APEX prepare, runtime
  use/up, check, plan, build, get, decode, frame, screenshot and browser interaction. The output was
  5 s, 720×1280, 150 frames, H.264/AAC, with audio RMS 2041.159 (the same as the earlier
  0.3.1 run on the old base). The video SHA256 `3b77dc8c…` differs, as earlier re-encoded runs also did.
- 7 Node Hypit tests passed. Python: `tests/apex_overlay/`, `tests/scripts/test_media_tools_mirror.py`
  and `tests/ci/` gave 1036 passed and 1 failed. The failure, `test_prompt_surface`, needs a
  Linux sysconfig module; it fails the same way on fork main on macOS and passes in Linux CI.
- Desktop: typecheck passed; lint had 0 errors; vitest electron 3231 and UI 9120 passed;
  release gates gave 100 passed and 1 skipped; build passed. All 11 lint-lane guards passed, and code health had 0 blocking.

Still open before a release from this base:

- `bundled-runtime.json` still names the v0.21-era `f043a490` runtime. A signed and notarized
  v0.22.2 runtime must be published for Mac arm64, Mac x64 and Windows x64, and the pin updated.
- 0.17.57 is already public, so the next release must be 0.17.58 or later.
- Windows native acceptance and the paired release through `desktop-release.yml` remain pending.

## Desktop 0.17.58 candidate and Windows native acceptance (2026-10-17)

- Merged `origin/main` at `324a5a3caa` (#393 pool-limits IPC, #394–#396 group chat) as `145bc76984`, with no
  conflicts, and pinned the runtime to that commit in `eb28eb528f`: version 0.17.58 (0.17.57 is already
  public), `runtime_version v2026.10.17-fork.145bc769`, `uv_version 0.12.3` (pm/lock.json),
  `min_desktop_version 0.17.58`. Release gates: 100 passed, 1 skipped.
- **Windows x64 native (win-5090, Windows 11 23H2)**, from a fresh checkout of `eb28eb528f`:
  - The runtime bundle `runtime-bundle-145bc76984eb-win-x64.tar.gz` was built natively from the pin.
    The relocation smoke passed.
  - Extract, fixup and verify passed.
  - The full `hypit-lifecycle-smoke.mjs` passed on the installed runtime: win32 x64, Hypit 0.3.1,
    CPython 3.14.7. The output was 5 s, 720×1280, 150 frames, H.264/AAC, with audio RMS 2041.245.
    Capture and browser interaction also passed.
  - The unpacked `APEX.exe` (identity 0.17.58.0, clean tree) was launched in the console session with a
    fresh home and a mock LLM:
    - First-run engine setup took about 3m45s, almost all of it the cold Defender scan during the first verify.
    - It committed `versions/145bc76984eb` and activated `v2026.10.17-fork.145bc769`. The older public
      `f043a490` default did not replace it.
    - The backend was ready 5.7 s after activation.
    - The APEX sign-in screen, the own-key flow and a Chinese chat to the mock all worked. The status bar showed `v0.17.58`.
    - `errors.log` had one expected warning.
    - `[pool-limits] … using defaults` was logged with 0 "No handler registered" errors (#393 confirmed on a real machine).
- **nix flake check**: the earlier failure was a single bad download of the fixed-output
  `node-gyp-11.4.0-npm-deps`, whose hash came back as `ZLXOnh…`. The next run rebuilt the same derivation from
  scratch and matched the pinned upstream hash `P25m02…`, and nix passed. The pin is correct and unchanged.
  Rewriting it to the bad value would have broken nix.
- Still open for the release: Mac signing and notarization and the paired publish through `desktop-release.yml`
  (currently disabled), the Windows NSIS installer/uninstall (only `--dir` was exercised), an upgrade from 0.17.57 with
  existing data, and real-account/real-model runs.

## Release gate: legacy-upgrade proof on a genuine F8 runtime (2026-10-17)

The first paired `publish=false` build of 0.17.58 (run 39012714346) failed on both Mac arches at
"Prove fresh offline install, real legacy upgrade, reopen and rollback" with `engine Python version
mismatch`. Both Mac runtimes had already been built, signed and notarized, and had passed relocation.
Windows never reached that step; it failed earlier on a transient npm `ECONNRESET` to COS.

- **Cause**: the consumer smoke faked the F8 (Desktop 0.17.31-era) legacy install from F8's source plus
  the *new* bundle's dependencies. That worked while both were CPython 3.11. v0.22's dependencies are
  CPython 3.14 without PyYAML, and F8 declares `requires-python <3.14` and pins `pyyaml`, so the fake
  tree could not run its own code. Real F8 users run F8's own 3.11 runtime, so the product probe is
  right; the fixture was not.
- **Fix**: `apps/desktop/scripts/legacy-runtime-fixture.mjs` builds F8's own runtime, using F8's own
  builder in an F8 worktree, with uv pinned to 0.11.28 because F8's builder would otherwise fetch the
  latest. It then installs the result the way a user machine has it:
  - fixed up for its path;
  - no bundle manifest;
  - a `.hermes-source-commit` marker;
  - checked to run Python 3.11 with PyYAML.

  Both `desktop-macos.yml` (arm64, x64) and `desktop-windows.yml` (x64) build it before the smoke,
  cache the archive by its immutable inputs, and pass the tree via the smoke's existing `--legacy-source`.
  The probe is unchanged.
- **Guard**: `desktop-macos-workflow.test.cjs` checks that both workflows build F8 before the smoke,
  fetch F8, and pass `--legacy-source`. It also checks that the fixture and the smoke name the same F8
  and that uv is pinned. All four reverse checks (no `--legacy-source`, no fixture build, a different
  F8, uv left to latest) turn it red.
- **Local proof, Mac arm64**:
  - The F8 fixture built with uv 0.11.28 and runs Python 3.11.15 with PyYAML 6.0.3.
  - The full consumer smoke passed against the `d3353487` runtime with `--legacy-source`.
  - Legacy section: before = genuine F8 `v2026.9.22-fork.f8d9cbeb` with actual imports; after =
    `installed`; reopen = `current`; 7 user files and the SQLite bytes unchanged; the old rollback
    tree preserved; an injected post-switch failure restored a usable F8.
- **Windows promote retry**: with the genuine fixture, the Windows smoke ran past the legacy probe for the
  first time on v0.22. On a GitHub runner, the promote of `versions/<key>.tmp` was then refused once with
  `EPERM`. The same promote passed earlier in that run and in the full smoke on win-5090, so the cause is
  a transient handle (an antivirus scan of freshly extracted files). `promoteStagingDir` now retries only
  on win32 and only for EPERM/EBUSY/EACCES, with up to 10 attempts and backoff from 250 ms to 4 s (about
  24 s in all). POSIX and other errors fail at once. Its three tests were red before the fix.
- **Windows local proof (win-5090)**: the F8 fixture built natively; the full consumer smoke passed against
  the `d3353487` runtime with `--legacy-source`.
- **Paired candidate (run 39026303436, `publish=false`, `39d2040445`)**: all jobs green, including the
  parity check `paired release identity OK: version=0.17.58 sha=39d2040445`.
  - Artifacts: Mac arm64 (signed and notarized), Mac x64 (signed and notarized) and Windows x64
    (unsigned NSIS).
  - Nothing was published; all three feeds read back 0.17.57.
  - Mac x64 needed two reruns for unrelated flakes. The first was an `npm ci` network timeout. The second
    was Apple ticket propagation: the submission was Accepted, but three online `--check-notarization`
    assessments 5 s and 15 s apart still failed. Per Kael's 2026-10-17 decision 6, a notarization
    timeout is rerun rather than the upstream notarize retry being ported in 0.17.58.
