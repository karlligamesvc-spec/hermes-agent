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

## Native and Runtime settlement

Native captures the initiating account, profile, connection and authenticated
transport before dialing. Email, browser, deep-link, boot, native catalog and
renderer recovery all use that receipt. A later login, logout or explicit main
model edit invalidates an older receipt. Same-owner JWT renewal retains its
credential lifetime; it cannot restore a superseded authentication intent.

Native success includes the actual Runtime assignment and local mirror
reconciliation. The renderer receives an opaque acknowledgement of that already
completed assignment, including the Runtime's canonical provider/model. Its
acknowledgement does not dispatch a second model write. Late replies cannot
reload another profile's environment, resend a turn or complete onboarding.

Native publishes the existing private `credentialRecovery` flag before sending
a Cloud issue/revoke request. A failed durable publication sends no request.
A known current-intent 401/403/409/422 restores the prior flag; unknown or
malformed outcomes keep it. A late old grant cannot clear a newer intent's
state. This also covers an old grant dispatched before a newer login fails
without admitting a higher Cloud revision: the preserved local credential is
explicitly pending across restart until a confirmed mutation and persistence
settle it.

The v1 Runtime exposes `GET /api/model/mutation` and the authenticated
`POST /api/model/mutation/fence`. Tagged requests carry the installation UUID,
a durable positive safe-integer revision and the actual target UUID in
`X-Apex-Model-Authority`, `X-Apex-Model-Revision` and `X-Apex-Model-Target`.
Each canonical profile home owns its target UUID and private SQLite journal.
Admission publishes a revision in a short transaction, slow credential/model
preparation runs outside that transaction, and actual synchronous config writes
recheck the revision under the commit transaction. Cancelling the awaiting
task does not release a still-running writer's protection.

Only `model_mutation:{target_id,revision}` from the actual completed outer
transaction settles a tagged write. A timeout, 500, malformed response or missing
acknowledgement keeps its captured target pending across Native restarts. A
higher acknowledged fence supersedes it. Actual exit of a verified Native-owned
Runtime child is also sufficient; a disconnected socket, newly healthy child,
reused PID or changed route is insufficient. Failure to load the established
counter, obtain its publication lock or persist its metadata fails closed.
Fresh installs may initialize a new counter normally.

An established deleted/corrupt counter is not reset, synchronized from Cloud,
or assigned a new authority automatically. Recovery requires restoring the
owned private metadata/marker from a controlled backup or support intervention;
ordinary login retry or Runtime update cannot reconstruct it. The App can be
closed, but online logout remains blocked while its old writes cannot be fenced.
A separate installation must not be used to bypass unresolved work against the
same profile. This release does not claim automatic recovery from every
filesystem corruption or external deletion.

Native metadata contains only installation UUIDs, monotonic revisions, profile
and connection IDs, target UUIDs, verified owned PIDs and irreversible transport
identity digests. URL userinfo/path/query, Runtime authentication identity and
custom headers participate in those digests without plaintext persistence.
Cloud JWT renewal is separate from that Runtime identity. The Runtime journal
is excluded from cloned/exported profiles. The normal App single-instance gate
prevents two Native processes from sharing the same auth store; isolated Node
counter tests exercise durable publication rather than claiming that product
path is reachable.

## Legacy Runtime compatibility and actual credential binding

A precise capability 404 distinguishes a released legacy Runtime from an
unreachable or malformed v1 implementation. First login with no previous key
and no unresolved owned request remains compatible. Subsequent local recovery
requires verified ownership of the actual child or a durable settlement proof
bound to the captured transport/profile/connection. A remote legacy Runtime can
reuse an exact persisted successful receipt after Native restart. An old key
with no such evidence requires updating the Runtime on the current connection
before cloud key rotation. Unknown legacy workers require their actual owned
child's exit or a supported fence; a changed port or healthy replacement cannot
erase their pending state. Independent profiles remain independent.

Reviewed legacy routes return success only after their writer finishes. The
precise model pricing confirmation ends before its writer starts and remains
actionable without creating a successful settlement proof. The exact all-blank
tool environment response likewise remains actionable; a tagged no-write reply
still has no commit acknowledgement and retains its pending fence. Other
`ok:false` or incomplete responses are not generalized into settlement.

A settlement receipt proves the writer ended; it does not prove credential
binding. Legacy managed recovery first checks raw config and chooses its own
stable named endpoint through the released custom-endpoint API. It refuses
unowned IDs, commands, unknown credential pointers and references from unrelated
main/catalog/auxiliary/fallback consumers to the proposed managed environment
key. It refuses a pre-existing nonempty environment value without ownership
evidence. All those checks precede provision. It then verifies actual returned
provider/model/base URL, reads raw config independently of the YAML patcher,
audits both managed anchors and reads its own named environment key. An
unrelated BYOK endpoint is not overwritten.

The capability-404 fallback selects a matching named entry from either the
keyed or legacy catalog, using the actual normalized identity. It rejects a
bare fallback when only unrelated entries exist. Keyed endpoint matching and
key reconciliation follow the consumer's `api`, then `url`, then `base_url`
priority; the legacy list consumes `base_url`. Valid `custom:` provider IDs
remain addressable in block YAML. Independent production resolver controls
verify the new key and the unrelated endpoint's unchanged routing and key.

Relay acceptance and Runtime recovery are separate facts. A healthy Native key
may repair the captured main model only when the selected actual endpoint is
the managed Relay and recovery was not explicitly opted out. Selected named
providers are inspected even when the main block has no URL. Their selected
catalog takes precedence over a conflicting inline main URL. Keyed entries use
`api`, then `url`, then `base_url`; legacy entries use their formal `base_url`.
A bare `custom` main can resolve an explicit literal `custom` catalog identity;
it does not guess another entry from its position or managed URL. Native-created
raw endpoint IDs require the exact private authority ID and a durable ownership
receipt bound to the captured profile and transport. Ambiguous aliases, even at
the same URL, fail closed. Environment pointers are resolved instead of accepting
a stale inline mirror. `runtimeRestored` reports that existing-key operation
without claiming a new cloud key was minted. Independent fresh production
resolver checks verify the consumed key and endpoint.

| Saved main choice | Healthy-key recovery decision |
| --- | --- |
| Explicit `custom:<id>` or matched literal `custom` | Inspect the unique selected catalog before any inline mirror. |
| Native-created raw endpoint ID | Inspect only with exact durable ownership for this target. |
| Multiple matching aliases or mixed-schema collision | Refuse automatic repair without writing. |
| Unmatched custom name or unproven bare inline endpoint | Preserve the choice; use explicit re-sign-in to recover. |
| Built-in provider, other raw alias, `auto` or absent provider | Preserve the choice; a URL alone does not establish managed ownership. |

The production Gateway, interactive CLI use-time and default oneshot consumers
were compared across 34 isolated configurations. A real CLI URL argument is an
explicit override; a saved inline URL does not become one for named providers.
`CUSTOM_BASE_URL` can override bare inline routing, and built-in providers can
use their own environment/OAuth credentials at a configured URL. The healthy
path deliberately does not infer those dynamic choices from raw YAML. It does
not claim that reading `/api/env/reveal` proves the process environment absent.
Explicit managed login remains available and records a named binding.

The login gate retains retry. A local Runtime failure can open the existing
formal update confirmation; a remote failure refers to the current connection
and never offers this machine's updater as its repair. Explicit BYOK cancels
managed recovery and preserves that choice. A failed credential file write or
removal is not reported as a successful login/logout.

## Mutation exit inventory

The Native selector wraps writes to model assignment, MoA, structured/raw
config, custom-endpoint create/update/delete/activate, `PUT`/`DELETE /api/env`,
and the exact toolset `PUT .../model`, `.../provider`, `.../env` paths. Body profile
takes precedence over query profile, then captured routing; Runtime aliases use
canonical profile names. Model/config/provider reads, env reveal and credential
validation remain reads. Direct Native seed/key sync, arrival/watch guards and
platform config application defer while a Runtime write is pending. A successful
managed completion fences older work before synchronizing existing local
mirrors; a remote login does not create an unrelated local BYOK anchor.

Runtime commit protection includes model/MoA/config/raw/custom-endpoint writes,
provider environment lifecycle mirrors and toolset model/provider/environment
writers. Other reviewed short config writers update the latest config under the
existing lock rather than saving a pre-network full snapshot. Untagged CLI and
released clients retain their existing API behavior; this contract does not
promise owner isolation against an independent unfenced writer.

## Additional executable smoke

```bash
cd apps/desktop
npx vitest run --project electron \
  electron/desktop-model-mutations.test.ts \
  electron/desktop-managed-provision.test.ts \
  electron/desktop-device-key.test.ts \
  electron/native-access-token.test.ts
npx vitest run --project ui \
  src/components/desktop-login-recovery.test.tsx \
  src/app/chat/sidebar/account-panel.test.tsx \
  src/store/auth.test.ts \
  src/store/managed-recovery.test.ts \
  src/store/onboarding.test.ts
HC903_MODEL_RUNTIME_PYTHON=/absolute/path/to/complete/runtime/venv/bin/python \
  npx vitest run --project electron \
  electron/desktop-model-mutations.integration.test.ts
```

The opt-in HTTP smoke spawns only private temporary homes and an isolated
loopback Runtime. It proves pricing-timeout/restart fencing, cancellation with
a real active write after HTTP500, remote legacy proof reuse, canonical named
provider binding and independent profile/resolver readback. It does not use a
production key or externally provision a credential. Runtime consumer reverse
tests separately remove the actual commit recheck, credential replacement,
acknowledgement gate and slow preparation guards, require each intended
executable anchor to be unique, observe the corresponding failure, and restore
the exact original source bytes.

The restored Native candidate passed 230 focused tests in eight files, 91 UI
tests in five files, and 19 real loopback HTTP cases. The latter include both
directions of conflicting selected-catalog/inline URLs, alias collisions with
no writes, Native-owned raw identities after restart, legal Unicode provider
keys and an independently decoded consumer that still holds an old key. Native
reverse verification removed 17 unique executable guards or consumer behaviors;
each produced the intended assertion failure before exact source restoration.
The original renderer recovery reverses remain separate evidence. Type checking
and scoped ESLint also passed. These results describe the candidate's executable
scope; they do not substitute for installed application or production acceptance.

Cloud issue/revoke, signed and notarized paired artifacts, installed Runtime
identity/upgrade, real account replay and user acceptance remain separate gates.
No test fixture or code review proves those external results.

## Cloud device-key ordering

Login and logout first verify authenticated
`GET /api/v1/desktop/provision-key/capabilities` returns version 1. They obtain a
new durable revision from the same Native counter without creating a Runtime
worker receipt, and send `provision_revision` together with the stable device
UUID. Only the exact echoed revision is accepted. Capability 404, outage or
malformed version prevents a rotating request. Unknown POST outcomes retain
credential recovery and require an explicit higher-revision retry instead of
claiming the previous key remains usable or the login expired.

The companion control-plane contract uses a `(user_id,device_hash)` revision
ledger for both issue and revoke. Higher admission supersedes late issue/revoke
work before its actual key mutation. A tagged latest logout can remove an
already-minted current device key whose response was lost, and an inactive held
key still supplies identity-repair proof. Old untagged callers retain their
existing response shape and exact held-key revocation semantics. This contract
does not claim that an independent untagged consumer participates in ordering.

Explicit logout suppresses background managed recovery before awaiting its
Runtime/cloud fences. A failed response or credential removal keeps retry
state instead of permitting self-heal to undo that intent. An existing captured
JWT can publish device-only logout even if its key is unreadable. The first
login screen has no logout action before a grant; choosing BYOK cancels the
local flow and does not claim successful cloud logout or persist a new JWT.
