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
- Bootstrap IPC types now live in an Electron-safe module and are re-exported from the renderer's existing public type module. Runtime payloads are unchanged.

## Verification

- Bundled runtime suite: 28 passed, including native archive/fixup/activation fixtures.
- Gateway and installer UI suites: 66 passed. The long-boot test drives the actual packaged gate and renderer hook across 45 seconds; the overlay test consumes actual gate events, including failure and retry.
- Entire platform overlay suite: 396 passed; focused model catalog suites: 116 passed.
- Desktop TypeScript check, renderer Vite production build and Electron main/preload bundle passed. Changed-file ESLint has no errors (existing style warnings remain).
- Reverse checks use unique-anchor assertions: remove the manifest emission -> gate ownership regression fails; revert the platform minimum to 1.5 seconds -> cold catalog behavior test fails. Both faults were restored.
- Native device acceptance uses the public Windows executable and unchanged public bundled engine payload, with candidate Electron JS installed only on the authorized test machine. This is a diagnostic build, not a published release. A final engine containing the overlay seam must be bundled for customer delivery.

## Boundaries

No public update feed, runtime default, account entitlement or production service is changed by this fix. Mac arm64, Mac x64 and Windows x64 must ship together from the synchronized release workflow. Unit tests do not certify physical antivirus performance, current provider availability or a final signed installer. The observed long per-file verification remains a performance limitation; integrity gates are not skipped.
