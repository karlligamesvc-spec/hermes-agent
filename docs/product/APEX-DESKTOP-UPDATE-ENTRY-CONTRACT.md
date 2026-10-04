# APEX Desktop update entry contract

Ticket: hc-901

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
