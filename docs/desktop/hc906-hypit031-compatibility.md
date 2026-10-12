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
| Desktop release consumer | **Unchanged** verified `desktop-lock.json` 0.2.17/COS slice. Candidate lock is not a production activation. |
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

## Limits and release gate

This change adapts APEX's managed entry points, not every optional upstream command, SDK or third-party provider. Existing TypeScript components need the official SDK migration if the customer explicitly upgrades them. Studio UI, Windows native and Mac x64 lifecycle are not certified by this run. Do not advertise CLI checks as complete provider/render acceptance.

Before default activation: mirror/read back the new transitive dependency slice, retain license/source/provenance, run the lifecycle natively on all three targets, and update the desktop lock only against that evidence. No updater feed, default engine, production COS manifest or customer project pin is changed here.
