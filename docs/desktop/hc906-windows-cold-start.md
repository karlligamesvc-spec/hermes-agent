# hc-906: Windows cold startup and managed catalog discovery

## Reproduction

On the authorized RTX 4060 Ti test machine, a genuinely clean installation of the public 0.17.55 Windows package timed out in the renderer after 45 seconds. The engine was still verifying 59,735 indexed files. It completed installation and reached `HERMES_BACKEND_READY` roughly 15 minutes after app launch. The ordinary connection timeout did not recognize bundled preparation as an active installer.

The first attempted clean test was invalid: an old Hermes CLI remained on the user's PATH. It was preserved and removed from the test PATH before repeating. Original user data, login data and programs were backed up, not deleted. No WSL runner or unrelated service was stopped.

An authenticated cold picker probe on Windows reproduced the separate catalog problem: both 1.5-second endpoint attempts failed, leaving the configured DeepSeek Pro sentinel. The same credentials returned nine live models with a longer timeout. A read-only Mac probe also returned nine models; its bundled discovery code shares the 1.5-second picker timeout. This establishes cross-platform risk, not a reproduced Mac first-launch UI failure.

## Change and exits

- Shared bundled preparation gate: publish the bootstrap manifest and running stage before extraction/verification, then success or actionable failure. Primary, background-profile, managed-messaging and explicit local-job callers already join this gate.
- Renderer: retain its existing bounded installer wait rather than the ordinary 45-second timeout; show bundled engine copy and a stage timer. Do not offer the legacy source installer's unsupported cancellation action for atomic bundle preparation. Failed attempts remain retryable.
- Platform overlay: raise only the known HTTPS Relay model-probe budget to at least 15 seconds. All CLI/REST/Desktop callers use this same probe. Keep live results, account-scoped cache, unauthorized behavior, entitlement filtering and unrelated endpoint budgets unchanged.
- Remote/custom runtime exclusions, package integrity, activation fence, rollback and source installer behavior remain covered by the existing tests.
- Bootstrap IPC types now live in an Electron-safe module and are re-exported from the renderer's existing public type module. The setup/model changes above did not change payload bytes; the performance follow-up below requires a newly built engine.

## Verification

- Bundled runtime suite: 28 passed, including native archive/fixup/activation fixtures.
- Gateway and installer UI suites: 66 passed. The long-boot test drives the actual packaged gate and renderer hook across 45 seconds; the overlay test consumes actual gate events, including failure and retry.
- Entire platform overlay suite: 396 passed; focused model catalog suites: 116 passed.
- Desktop TypeScript check, renderer Vite production build and Electron main/preload bundle passed. Changed-file ESLint has no errors (existing style warnings remain).
- Reverse checks use unique-anchor assertions: remove the manifest emission -> gate ownership regression fails; revert the platform minimum to 1.5 seconds -> cold catalog behavior test fails. Both faults were restored.
- Native device acceptance uses the public Windows executable and unchanged public bundled engine payload, with candidate Electron JS installed only on the authorized test machine. The complete clean-device run reached backend readiness at 04:28:16 UTC after starting at 04:12:59 UTC, then automatically showed the account sign-in screen without a retry. Progress at 50 seconds and 600 seconds stayed active. A live native Windows picker probe with the candidate seam took 9.38 seconds and returned all nine Relay models with a 15-second request budget. This is a diagnostic build, not a published release. A final engine containing the overlay seam must be bundled for customer delivery.

## Boundaries

No public update feed, runtime default, account entitlement or production service is changed by this fix. Mac arm64, Mac x64 and Windows x64 must ship together from the synchronized release workflow. Unit tests do not certify physical antivirus performance, current provider availability or a final signed installer. The optimized verifier must ship inside a newly built engine; changing only Electron leaves the old bundled verifier in use. Integrity gates are not skipped.


## Verification performance follow-up (2026-10-08 Pacific)

The earlier device log breaks down as follows: extraction 21.1s; staged verification
729.2s; final-location verification 61.8s; activation/probes including a redundant
third scan about 81.6s. App launch to backend readiness was 917s. The verifier
processed 59,731 immutable entries (59,735 index rows including mutable entries),
serially allocating and zeroing a new 4 MiB read buffer for every file.

The verifier now reuses eight 256 KiB buffers with bounded concurrent reads. It
continues checking the authenticated index, sizes, SHA-256 content and links,
including complete tails and empty files. Staging and final relocation each retain
one full verification. Fresh/just-repaired installs no longer perform a redundant
third scan; existing committed trees still revalidate before activation. The shared
bundle script covers native build smoke, CLI/COS consumers and packaged Desktop;
the duplicate-scan change applies only to the packaged consumer. No antivirus
configuration, archive identity, source pin or user data policy changes.

On the same RTX 4060 Ti, the unchanged public archive was freshly extracted to two
separate private directories; the candidate verifier ran externally against its
original index so no installed verified bundle was modified. Standalone first
verification: 140.08s. Full real packaged-consumer diagnostic: extraction 32.07s,
staged verification 141.96s, final verification 3.17s, and actual isolated HTTP
backend readiness 3.97s; total including hashing, fixup, probes and activation
193.11s. The backend returned healthy and its owned process was closed afterward.
The normal logged-in client and user data remained untouched. These are fresh-path
measurements on a running Windows host, not rebooted cache-cold measurements or a
newly signed production installer/GUI acceptance.

Validation: 61 focused native/installer/verifier tests passed; TypeScript and
Electron main/preload build passed; changed-file lint has zero errors. Native
Windows CLI accepted valid bytes and rejected same-size tampering and a forged
index with nonzero exits. Unique-anchor reverse injections also fail as expected:
replace digest comparison with success -> corruption test fails; restore the
unconditional third scan -> fresh-scan/reuse regression fails. Faults restored.
Evidence is retained under the private `hc906-win-first-install/perf` diagnostic
artifact directory. No public feed or runtime default changed.

## LAN release candidate and Mac evidence

GitHub rejected workflow dispatch with `Actions has been disabled for this
repository`. The owner explicitly authorized replacing Actions with LAN RTX 4060 Ti
builds. Mac arm64/x64 still require the same source and version, Developer ID
signing/notarization and package/feed readback; this exception does not waive those
gates. The local candidate is 0.17.56, not yet published.

### Native media lifecycle gate

The first complete macOS x64 Hypit lifecycle test exposed a native Koffi
`flock` crash after the upstream TypeScript/package-resolution hooks loaded it.
The managed wrapper now preloads the same unchanged Koffi module in the child
process before those hooks. A file URL is required for Windows drive paths.
No upstream Hypit files or original Workbuddy skill bodies are rewritten.

`node scripts/media-tools/hypit-lifecycle-smoke.mjs RUNTIME_ROOT NEW_WORKSPACE`
prepares the managed runtime, starts both providers, renders the upstream media
fixture, exports the video, independently checks H.264/AAC, 720×1280, 150 frames
and exactly five seconds with ffprobe, then stops its own runtime/programs.
Native Windows and Mac arm64 passed; Mac x64 passed under Rosetta on both local
Macs (not physical Intel hardware). Removing only the child `--import` argument
with a unique-anchor assertion makes the same x64 lifecycle gate fail; restoring
it passes. CLI version and browser screenshots alone cannot catch this fault.

The earlier full 0.17.56 candidate reached first-login readiness from an empty
home in 29.9 seconds on Mac Studio and 433.8 seconds on 4060 Ti. These are packaged
app launches, not rebooted cold-cache measurements. Windows first verification
remains the dominant cost; the 193-second diagnostic consumer measurement above
must not be presented as this final packaged application's measured startup.

On Mac Studio, a newly extracted public engine exercised the real packaged
consumer with candidate verification: extraction 4.628s, fixup 3.889s, first verify
1.323s, final verify 1.303s and isolated backend readiness 2.963s, total 19.102s.
This fresh-directory diagnostic preserves the existing app and is not a rebooted
cold-cache or final installer measurement.

The corrected native Windows live model probe returned the full entitled catalog
in 0.7s with a 15s budget. The public Relay model ID for the requested default is
`deepseek-flash`; direct BYOK uses the provider's separate model identifier.
Fresh managed provisioning selects Flash. Existing explicit Pro/other choices
are preserved. Cloud provisioning/config regressions passed 41 tests on the
WSL PostgreSQL test host; no local missing-PostgreSQL result was called a pass.
