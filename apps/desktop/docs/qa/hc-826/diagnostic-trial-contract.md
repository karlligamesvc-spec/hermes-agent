# hc-826 Desktop isolated diagnostic trial contract

## Scope

This package is a non-publishing QA artifact. It uses the existing Desktop
renderer and Runtime behavior, but it is not the formal APEX application and
must not claim or mutate the formal application's OS identity, protocol,
updater, user data, Runtime home, or workspace.

The build is source-only infrastructure. It does not change the Desktop
version, Runtime dependencies, renderer, API, public release workflow, or
updater feed.

## Frozen identity and policy

- Package name: `apex-diagnostic-trial`
- Product/executable name: `APEX Diagnostic Trial`
- App ID: `com.apexnodes.desktop.diagnostic-trial`
- Output directory: `release-diagnostic-trial`
- OS protocol registration: disabled
- Shell updater: disabled
- Runtime updater and bootstrap fallback: disabled
- Runtime source: an exact clean 40-character Git HEAD embedded by the build
- Version: inherited unchanged from `apps/desktop/package.json`
- macOS signing: local ad-hoc identity only; no distribution certificate or
  notarization

Formal APEX remains `com.apexnodes.desktop`, product/executable `APEX`, and
continues to own `apexnodes://`. The diagnostic package declares no protocol on
macOS or Windows and the main process skips the only registration call before
the Electron registrar is invoked. It may parse a link already delivered to
its process, but it never registers or takes ownership of a system scheme.

## Launch contract

The package is launched only through `scripts/launch-diagnostic-trial.mjs` with
four explicit absolute paths: app, diagnostic root, clean Runtime worktree, and
Python interpreter. Python may be shared outside the Runtime checkout. The
launcher and app both verify that the interpreter actually imports
`hermes_cli.main` from the exact pinned Runtime.

The launcher creates only these writable paths beneath the diagnostic root:

- `user-data`
- `hermes-home`
- `workspace`
- `.apex-diagnostic-trial.json`

Both layers resolve symlinks through the nearest existing parent. The
diagnostic root and its derived paths may not equal or sit beneath formal APEX
userData, `~/.apexnodes`, `~/.hermes`, the Windows `%LOCALAPPDATA%\apexnodes`
root, or a configured production `HERMES_HOME`.

The embedded diagnostic identity without a complete policy, a missing marker,
a dirty/wrong Runtime, a wrong module binding, a protected path overlap, or a
Finder/Explorer launch without launcher context refuses before the app's first
userData write. There is no fallback to a global Runtime and no bootstrap.

## Build and audit commands

Run from `apps/desktop` in a clean source worktree. The Runtime root must also
be a clean Git worktree; its exact HEAD is embedded into `app.asar`.

```sh
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false \
  APEX_DESKTOP_DIAGNOSTIC_BUILD_RUNTIME_ROOT=/absolute/clean/runtime/worktree \
  npm run builder -- --dir --mac --arm64 --publish never \
  --config electron-builder.diagnostic-trial.cjs
node scripts/assert-diagnostic-trial-package.mjs \
  "/absolute/release-diagnostic-trial/mac-arm64/APEX Diagnostic Trial.app" \
  arm64 SOURCE_HEAD
```

Check or launch with an isolated root outside production locations:

```sh
node scripts/launch-diagnostic-trial.mjs \
  --app "/absolute/APEX Diagnostic Trial.app" \
  --root /absolute/apex-diagnostic-trial-root \
  --runtime /absolute/clean/runtime/worktree \
  --python /absolute/python

# Add --launch only for an authorized interactive QA run.
```

No command in this contract publishes, signs for distribution, installs a
formal application, or updates an updater feed.

## Outlet inventory

- Build identity/policy: `diagnostic-trial-policy.json`,
  `electron-builder.diagnostic-trial.cjs`,
  `scripts/diagnostic-trial-build-config.cjs`
- Pre-write runtime gate: `electron/desktop-diagnostic-trial.ts`, wired at the
  beginning of `electron/main.ts`
- OS protocol ownership: the sole main-process
  `registerApexDesktopProtocol()` call is wrapped by the embedded policy
- Shell/runtime update exits: shell updater initialization, update-plan writes,
  shell apply, Runtime check/apply
- Runtime resolution: exact root/interpreter only, bootstrap false
- macOS/Windows package identity: package config, macOS plist audit, Windows PE
  product-name override while formal APEX defaults remain unchanged
- Operator launcher and artifact audit:
  `scripts/launch-diagnostic-trial.mjs`,
  `scripts/assert-diagnostic-trial-package.mjs`

## Verification and reverse checks

Positive gates:

- `npm run typecheck`
- `npm run lint -- --quiet`
- `vitest run --project electron electron/desktop-diagnostic-trial.test.ts`
- `node --test scripts/diagnostic-trial-package.node-test.mjs scripts/windows-exe-identity.node-test.mjs`
- `npm run test:release-gates`
- `npm run build`
- `git diff --check`

The following one-at-a-time injections were performed with exact patch anchors
and then reverted with patches:

- Delete `extraMetadata.apexnodes.desktopTrial`: package test fails.
- Restore `apexnodes://` in the diagnostic builder: no-protocol test fails.
- Replace the diagnostic App ID with `com.apexnodes.desktop`: identity test
  fails.
- Bypass `registerOsLoginProtocolForPolicy()`: main-process source guard fails.
- Put `RESOLVED_USER_DATA_DIR` before the launch gate: early-order source guard
  fails.

The behavior test also rejects a policy deletion based on the remaining
diagnostic package identity, a Runtime SHA mismatch, a module loaded outside
the Runtime, and a symlink-resolved path inside production APEX data.

## Remaining platform evidence

The source and macOS arm64 static-directory package are the delivery target of
this PR. Windows executable identity is covered by pure/package tests here;
Windows static-directory packaging and interactive launching remain separate
QA evidence and must not be described as completed by this macOS build.
