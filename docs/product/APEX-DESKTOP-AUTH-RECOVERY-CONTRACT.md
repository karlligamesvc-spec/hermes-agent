# APEX Desktop account recovery contract

## Scope

hc-722 covers an already identified managed account whose relay credential has
expired. It keeps the existing soft-degrade behavior: the local workspace stays
usable, the account card states that login expired, and the hard auth gate does
not replace the whole window.

## Recovery exits

There are two callers of managed re-sign-in state:

1. The user clicks the expired account card in the lower-left sidebar.
2. An interactive send fails relay recovery and routes directly to re-sign-in.

Both renderer shells mount overlays independently: the contribution shell and
the legacy desktop controller. Both keep the onboarding surface mounted for
managed-disabled and signed-in states. An expired account mounts it only after
`requestManagedReSignIn` records an explicit request, so background degradation
leaves the card as the sole guide and a click (or interactive send recovery)
reveals managed sign-in.

## Invariants

- Clicking the expired account card makes managed sign-in visible.
- Merely entering `expired` does not open or refresh onboarding.
- `expired` remains a soft degrade in `DesktopAuthGate`; it must not produce a
  second full-window login screen beneath or above onboarding.
- Signed-out, checking, and disabled managed accounts do not mount onboarding;
  the hard auth gate remains their only login authority.
- Managed-disabled/BYOK and normal signed-in onboarding behavior is unchanged.
- The contribution and legacy renderer shells use the same mount decision.

## Verification

```bash
cd apps/desktop
npx vitest run --project ui \
  src/app/chat/sidebar/account-panel.test.tsx \
  src/first-run-managed-route.test.tsx \
  src/identity-layer.test.tsx \
  src/store/auth.test.ts \
  src/store/managed-recovery.test.ts
npm run typecheck
npm run lint
npm run build
```

The focused account-panel test performs the real button click and requires the
real managed sign-in UI to appear. It does not attempt an external login or
prove server credential issuance.

## Failure injection

Remove the requested-expired clause from `canMountDesktopOnboarding`. First
assert the mutation changed exactly one helper expression; then the account-panel
behavior test must fail because the click updates onboarding state while no
recovery UI is mounted.
