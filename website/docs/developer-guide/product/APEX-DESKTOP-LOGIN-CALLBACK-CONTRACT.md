# APEX Desktop browser-login callback contract

Ticket: hc-835

## Product behavior

- Managed and Google browser-login flows finish on the Desktop-owned loopback
  callback, not on a public web route.
- A successful callback displays the APEX-branded dark completion page with
  “登录已完成”, synchronization guidance, and an “打开 APEX” action.
- The action uses `apexnodes://open?source=login-complete`. It focuses the
  installed app without replaying the one-time `login` deep-link route.
- Invalid state, missing token, and explicit provider errors use the same APEX
  visual shell with a failure status and recovery guidance.
- No callback surface may display ZCode, Hermes, or another product identity.

## Security and lifecycle

- The listener binds only to `127.0.0.1`, validates the per-flow random state,
  and resolves a token only on the exact callback path.
- The listener closes immediately after success or the first callback failure;
  favicon and unrelated requests do not settle the flow.
- Result pages load no remote resources and return `no-store`, `no-referrer`,
  `nosniff`, and a restrictive content-security policy.
- The page embeds only the pinned Tabler status/action icon assets already used
  by Desktop. User/provider text is HTML-escaped before rendering.

## Exit inventory

1. Successful callback with matching state and token.
2. State mismatch.
3. Matching state without a token.
4. Explicit provider error.
5. Non-callback browser requests such as `/favicon.ico`.
6. User abort, listener error, and watchdog timeout.

## Verification

```bash
cd apps/desktop
npx vitest run --project electron electron/apex-loopback.test.ts electron/desktop-deep-link.test.ts
npm run typecheck
npm run lint
npm run build
```

The visual gate compares the real callback response with the selected 856×638
reference at the same viewport. Its latest evidence and comparison history live
in the repository-root `design-qa.md`.

## Failure injection

- Restore “ZCode” or remove “APEX” from the successful HTML: the callback
  identity assertions fail.
- Change the CTA to `apexnodes://login`: the exact safe-open deep-link assertion
  fails.
- Remove a response hardening header: the header contract assertion fails.
- Remove `fastapi` from a synthetic Desktop Python while leaving source and the
  interpreter present: the runtime-integrity test must reject it and choose
  repair rather than allowing this completion page to hand back to a dead app.
