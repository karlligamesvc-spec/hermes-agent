# APEX Desktop update entry contract

Ticket: hc-901 / hc-906

## Behavior and exits

- The statusbar app version opens the command center's System section, where
  “Check for APEX updates” checks the native installer feed and managed engine.
  A packaged install does not need a Git checkout to use this entry.
- This action always targets the local app, including while connected to a
  remote agent. The separately named remote backend version retains its
  backend update entry.
- Native macOS/Windows update menus, the command palette and Settings already
  use the same supported update center/orchestrator; they were inspected and
  retain their existing paths. Both renderer shells retain the native menu
  integration.
- Automatic checks remain silent: first check after 60 seconds, then every
  six hours. Downloaded updates offer an explicit install/restart action.

## Regression smoke

```bash
cd apps/desktop
npx vitest run --project ui src/app/shell/hooks/use-statusbar-items.update.test.tsx src/store/desktop-update.test.ts src/store/updates.test.ts src/app/contrib/hooks/use-desktop-integrations.test.tsx
npm run pack
npx playwright test e2e/update-entry-packaged.spec.ts --workers=1
```

The hook regression executes the actual version item's callback in local and
remote modes and verifies callback replacement after rerender. Replacing the
unique client callback with `openUpdateOverlayFor('client')` makes both cases
fail. The packaged smoke clicks the rendered version, then checks a local HTTP
feed through real renderer IPC and the packaged `electron-updater`, redirecting
only manifest requests at Electron's HTTP layer. It does not mock the updater's
methods/events or update the user's app/home. Without a built package, this
packaged-only spec skips; the smoke must report one pass to count as evidence.

These smokes cover entry routing and feed checks, not the full download,
signature validation, installation and restart transaction or Windows signing.

## Occupancy and automatic continuation (hc-906)

A requested install waits while the engine has active work or foreign owners.
The existing engine remains available, the exact requested target stays frozen,
and occupancy is not reported as `runtime_target_not_active`. The native shell
install checks again every 15 seconds; packaged-engine boot recovery also retries
natively. Runtime-only renderer plans persist across reload and recheck every
30 seconds. Successful activation still requires actual source/marker proof.

Tracked Desktop workers can be stopped only after preflight; messaging gateways
must acknowledge drain with no active agents. Another live Desktop/CLI owner is
preserved until it exits. The final idle scan has no PID exemptions. Ordinary
app quit cannot install implicitly around the gate. Duplicate install requests
coalesce; failed native handoff releases its process-start fence.

Additional smoke: `electron/deferred-runtime-update.test.ts`,
`electron/runtime-gateway-retirement.test.ts`, `electron/packaged-runtime.test.ts`,
`electron/shell-updater.test.ts` and `src/store/desktop-update.test.ts`.
Real temporary workers and fixture archives exercise ownership and switching on
Mac and Windows. This does not replace signed installer/update end-to-end release
acceptance. Detailed exit inventory and negative tests are recorded in
`docs/desktop/hc906-engine-update-recovery.md`.
