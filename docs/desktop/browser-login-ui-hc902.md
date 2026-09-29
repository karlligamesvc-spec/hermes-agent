# hc-902 browser authorization result

The shared Electron loopback success and failure responses now use the compact APEX browser-authorization layout: real navy/white wordmark, quiet surface, readable status and one primary Open APEX action. Wordmarks are 224px derivatives of the existing ApexNodes `web/public/brand/apex-logo-navy.png` and `apex-logo-white.png`; they are embedded so the page works without a network request.

No state/token parsing, listener lifecycle or OS protocol handling changed. The action still uses `apexnodes://open?source=login-complete` without login credentials. The result page confirms browser callback receipt while downstream desktop account synchronization may still fail. Mac and Windows share this module; no version bump or release is part of this change.

## Verification

- `npm run typecheck` from `apps/desktop`: passed.
- `../../node_modules/.bin/eslint electron/apex-loopback.ts electron/apex-loopback.test.ts electron/apex-login-brand.ts`: passed.
- `../../node_modules/.bin/vitest run --project electron electron/apex-loopback.test.ts electron/apex-managed.test.ts`: 120 tests passed.
- Reverse validation: the unique `res.end(SUCCESS_HTML)` executable anchor was changed to append `outcome.token`. The real HTTP test failed on `assert.ok(!res.body.includes('jwt.success'))`. The injection verified one match and restored the source in `finally` before rerunning successfully.
- The compiled module was served through real loopback HTTP, and its HTML was viewed in an isolated Chrome 154 profile in light/dark appearance. Success/failure CTA and absence of credentials were checked. Full browser replay, screenshots and the product contract live in the paired ApexNodes hc-902 PR under `docs/audits/hc-902/`.

No packaged-app OS focus, Windows device acceptance or public updater release is claimed. Those remain part of the existing paired Mac/Windows release process.
