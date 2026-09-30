# APEX Desktop account recovery contract

## Scope

hc-722 covers an already identified managed account whose relay credential has
expired. It keeps the existing soft-degrade behavior: the local workspace stays
usable, the account card states that login expired, and the hard auth gate does
not replace the whole window.

hc-903 separates a rejected relay key from an expired account: cooldown,
persistence errors and temporary provision/network failures retain the account;
missing login credentials or a confirmed provision 401 require re-sign-in.
A successful live relay probe lifts an old soft expiry. Merely finding a key
on disk, a disabled managed mode or a failed probe does not prove recovery.

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

- Clicking the expired account card makes managed sign-in visible even with a
  ready Gateway or a previously skipped first run. Explicit intent wins over
  both new and already pending local runtime readiness checks.
- Boot, native catalog and renderer self-heal share one recovery attempt per
  native credential lifetime. A later account login/logout prevents an older
  recovery from writing its credentials, applying a key or returning an assignment.
- Renderer recovery replies belong to their account lifetime: a late reply
  cannot undo a hard 401/403 gate or mutate another owner's state.
- Only a confirmed successful relay probe or verified healing clears soft expiry.
- Cooldown, local persistence failure, ordinary provision 403, 503 and network
  failures do not report expired login or open re-sign-in. Generic failure UI
  remains available for an interactive send.
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
  src/store/managed-recovery.test.ts \
  src/store/managed-catalog-recovery.test.ts \
  src/store/onboarding.test.ts
npx vitest run --project electron \
  electron/apex-managed-recovery.test.ts \
  electron/apex-managed.test.ts \
  electron/apex-managed-key-rotation.test.ts \
  electron/apex-relay-key-anchors.test.ts
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

For hc-903, independently remove the explicit-request readiness guards, the
`needsSignIn` gate, positive-probe expiry clearing, native single-flight joining,
and the post-provision current-owner check. Each mutation must change its exact
intended executable anchor and make the corresponding behavior assertion fail;
restore the fixed source bytes before the next mutation. The unit suite verifies
recovery receipts, real config writes, state transitions and the actual login UI.
It does not prove external credential issuance, a particular production race,
provider quality, packaging, signing or release acceptance. Packaged and real
account acceptance remain separate checks.

Renderer guards prevent stale UI transitions and resends before/after runtime
assignment. They do not cancel an already dispatched `/api/model/set` request;
this unit contract does not claim transactional owner isolation inside that
runtime endpoint. Native credential/config settlement is separately guarded.
