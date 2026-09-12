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
- Runtime uninstall probes/actions and bootstrap repair: disabled
- Runtime source: an exact 40-character Git HEAD embedded by the build; tracked
  state must be clean and the only permitted untracked entry is the Runtime's
  own root `.bytecode-fingerprint` cache
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
four explicit absolute paths: app, diagnostic root, verified Runtime worktree,
and Python interpreter. Python may be shared outside the Runtime checkout. The
launcher and app both use `importlib.util.find_spec()` in a separate Python
process to verify that the interpreter resolves `hermes_cli.main` from the exact
pinned Runtime. They do not import the Runtime module during this preflight:
importing it creates HERMES_HOME directories and an upstream default SOUL before
the APEX first-run seed owns that state.

The launcher creates only these writable paths beneath the diagnostic root:

- `user-data`
- `hermes-home`
- `workspace`
- `.apex-diagnostic-trial.json`

Both layers resolve symlinks through the nearest existing parent. The
diagnostic root and its derived paths may not equal or sit beneath formal APEX
userData, `~/.apexnodes`, `~/.hermes`, the Windows `%LOCALAPPDATA%\apexnodes`
root, or a configured production `HERMES_HOME`.

The build and launcher reject every tracked change (including a tracked change
to `.bytecode-fingerprint`) and every untracked path except the exact root
`?? .bytecode-fingerprint` entry. That path must also be a regular non-symlink
file, remain explicitly untracked, and contain the Runtime's `git:<ref>:<sha>`
(or unresolved-ref) fingerprint shape. A directory, symlink, tracked file, or
arbitrary same-name content is rejected before Runtime startup. Hermes Runtime
owns the file: every real CLI launch runs its stale-bytecode sweep and records
only the checkout's Git ref/commit fingerprint. This narrow allowlist lets the
same pinned Runtime pass a second diagnostic launch; it is not a general dirty
worktree bypass.

The app main process independently rejects incomplete embedded policy, a
missing marker, a wrong Runtime HEAD, a wrong module resolution, a protected
path overlap, or a Finder/Explorer launch without launcher context before its
first userData write. The main process does not duplicate the launcher's Git
status/content check, so a dirty same-HEAD Runtime is an official launcher/build
refusal rather than a main-process refusal. There is no fallback to a global
Runtime and no bootstrap.

## Build and audit commands

Run from `apps/desktop` in a clean source worktree. The Runtime root must satisfy
the exact clean-state rule above; its exact HEAD is embedded into `app.asar`.

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
- Maintenance exits: Runtime uninstall summary/run and bootstrap repair refuse
  before probe spawn, marker removal, backend teardown, detached cleanup, or App
  quit; formal APEX continues through the existing implementations
- Runtime resolution: exact root/interpreter only, bootstrap false
- macOS/Windows package identity: package config, macOS plist audit, Windows PE
  product-name override while formal APEX defaults remain unchanged
- Operator launcher and artifact audit:
  `scripts/launch-diagnostic-trial.mjs`,
  `scripts/assert-diagnostic-trial-package.mjs`
- Runtime source-state gate shared by build and launcher:
  `scripts/diagnostic-trial-runtime-clean.cjs`

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
- Replace the exact generated-cache rule with a broad untracked allow: the
  first-launch/second-launch Runtime test accepts `.bytecode-fingerprint` but
  fails on the injected unknown path.
- Replace `find_spec()` with `import_module()`: the no-import source guard fails;
  the real Python regression also proves the target module stays absent from
  `sys.modules` and the probe HERMES_HOME stays empty.
- Run diagnostic maintenance callbacks: the behavior test fails unless
  uninstall summary/run and bootstrap repair return before spawn, unlink,
  Runtime writes, or quit.

The behavior test also rejects a policy deletion based on the remaining
diagnostic package identity, a Runtime SHA mismatch, a module resolved outside
the Runtime, a symlink-resolved path inside production APEX data, tracked
Runtime drift, nested/lookalike fingerprint paths, and all other untracked
Runtime files. A real Git fixture additionally rejects a symlinked fingerprint
and a tracked modification at that same path while accepting the normal cache
on two consecutive validations.

## Remaining platform evidence

The source and macOS arm64 static-directory package are the delivery target of
this PR. Windows executable identity is covered by pure/package tests here;
Windows static-directory packaging and interactive launching remain separate
QA evidence and must not be described as completed by this macOS build.
