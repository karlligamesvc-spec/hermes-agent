# APEX Desktop Cron provider and outcome recovery

## Scope

hc-905 fixes two independently observed failures in an administrator's newly
created one-shot task: a named custom model was stored as the bare `custom`
interface class and could no longer resolve its configured endpoint; Desktop
displayed an exhausted schedule as successful despite a failed execution.

The fix applies to Desktop's local Hermes Agent Runtime and its projections.
It does not migrate existing user jobs, alter scheduling/claim/repeat rules,
change global model configuration, issue inference requests, or publish an
updater feed.

## Provider snapshots and adoption

An unpinned agent job captures its current provider/model at creation. The
snapshot remains its effective pin after later global changes. Explicit job
pins and `cron.model_provider` / `cron.model` fleet defaults retain their
precedence. A legacy job with no snapshot continues to use current global
configuration. A no-agent script job carries no inference snapshot.

The provider snapshot stores the named or alias identity that actually
resolved, including `custom:<name>` and custom aliases without that prefix.
`custom` alone is an interface/billing class and cannot identify one of several
named endpoints or credentials. `auto` and a missing requested identity fall
back to the concrete resolved provider, rather than following a future global
choice. Endpoint URL matching is insufficient: two saved providers can use the
same URL with different credentials.

Four writers use `_compute_provider_model_snapshots`:

1. `create_job` for unpinned axes.
2. `update_job` when inference axes change, including explicitly clearing a pin.
3. Explicit single-job `resnapshot_job` adoption.
4. Explicit bulk `resnapshot_all_unpinned` adoption.

CLI, tool, dashboard, and Desktop writers delegate to those existing paths.
An adoption captures the current resolution once; later changes do not silently
replace the new snapshot. An old bare-`custom` snapshot is not guessed from the
current global configuration. The user can explicitly edit/pin or resnapshot
that job; other jobs remain untouched. Profile-local config/credentials,
provider/model fallback pairing, and model-change impact inspection keep their
existing boundaries.

## Schedule lifecycle and actual outcomes

`jobState` retains the backend lifecycle and controls pause/resume. In
particular, a one-shot repeat budget can end with `state=completed`, disabled
dispatch, and no next schedule after an unsuccessful attempt. The lifecycle
label therefore says that the schedule ended.

The shared outcome projection reads `last_status` separately:

| Backend result                              | User-facing meaning                                         |
| ------------------------------------------- | ----------------------------------------------------------- |
| `ok`                                        | Latest execution succeeded                                  |
| `error`                                     | Latest execution failed                                     |
| `blocked_config`                            | Configuration prevented execution                           |
| `interrupted`                               | Execution was interrupted                                   |
| `delivery_failed`                           | Execution and result delivery are separate; delivery failed |
| `delivery_queued`                           | Delivery completion is unverified                           |
| Missing/unknown status on an ended schedule | Execution result is unverified                              |

An older payload with explicit lifecycle `error` still exposes its execution
failure and diagnostic. It cannot turn an ended schedule with absent outcome
into success. Execution diagnostics use `last_error`; delivery diagnostics use
`last_delivery_error`.

The same projection covers Cron list/detail, sidebar rows, one-shot Tasks
list/detail/buckets, and native task notifications. The Tasks ended bucket
includes failed and unverified results. Only an observed running-to-verified
success/failure transition sends a terminal notification; absent outcomes and
queued delivery do not produce success notifications. Running retries retain
their active pip and pause/resume continues to use lifecycle state. Added copy
is supplied in English, Simplified/Traditional Chinese, Japanese, and Arabic.

Delivery receipt/queue settlement currently updates its own ledger rather than
rewriting `job.last_status`. `delivery_queued` is therefore a recorded unverified
delivery outcome, not proof that Desktop follows a later settlement. This
change adds no fabricated delivery or execution ledger.

## Runtime capability and activation

The current fork already exposes additive `executions` alongside conversation
`runs` at `/api/cron/jobs/{id}/runs` (hc-889). Cron distinguishes that capability
from older engines that return conversations alone; script/failed-before-session
executions do not become invented navigable conversations. Sidebar quick
peek and Tasks history consume `SessionInfo` conversations only; Tasks labels
that history as conversations.

Updating the Desktop shell can adopt an existing Runtime without replacing it.
An App version or install-stamp SHA does not prove that this producer or the
execution API is active. Existing opt-in Runtime check/apply resolves the admin
latest target through the official mechanism; source artifact registration and
authorized activation must establish the actual installed Runtime revision.
Do not patch a user's installed Python files, keys, jobs, or pin by hand.

Real acceptance requires reading the installed Runtime revision/capabilities,
explicitly repairing only the owned acceptance job, and allowing a future
scheduled execution to occur without a manual trigger. Preserve its original
failed execution record. A successful GUI run and independent read-only ledger
verification remain separate from these offline tests.

## Required CI recovery

The successful finished-task deep-link fixture supplies `last_status=ok` and
selects the **Ended** bucket, which also contains failed/unverified attempts.
The missing-outcome fixtures continue to require an unverified result.

Workflow refresh subscriptions retain their mounting realm's bound cleanup
methods. Delayed Nanostores deactivation still clears the interval and removes
focus, blur, visibility and channel listeners if globals change or the original
realm loses its methods during teardown. The teardown test removes methods on
the captured objects rather than substituting a different global window.

The subprocess environment composition test now completes a real session-kernel
cell, verifies success and a fresh process, and compares the child's reported
environment with the actual `Popen` environment. It keeps both controlled
same-environment classification branches, inherited path stripping, user-path
preservation and provider-key exclusion. Each test owns and disposes its kernel.
An obsolete stream mock could previously ignore a failed kernel response and
leave reader threads running until the file timeout. These controls do not
prove compatibility with a second physical Python interpreter.

## Smoke

Use the canonical runner with a complete fork development environment:

```bash
scripts/run_tests.sh -j 4 tests/cron/ \
  tests/hermes_cli/test_cron.py tests/hermes_cli/test_fallback_config.py -q -rs
scripts/run_tests.sh -j 4 tests/cron/test_cron_provider_snapshot_identity.py \
  tests/hermes_cli/test_web_server_cron_profiles.py \
  tests/hermes_cli/test_cron_model_impact.py -q
scripts/run_tests.sh -j 1 --files tests/tools/test_local_env_blocklist.py -q -rs
cd apps/desktop
npm run test:ui -- src/app/cron src/store/cron.test.ts \
  src/store/cron-model-impact.test.ts src/store/cron-model-impact-scope.test.ts \
  src/hermes-cron-scope.test.ts src/i18n/languages.test.ts src/i18n/runtime.test.ts
npm run test:ui -- src/app/business-workspace/api/read-revision.test.ts \
  src/app/business-workspace/hooks/workflow-read-refresh.test.tsx \
  src/app/business-workspace/business-workspace.test.tsx
npm run typecheck
```

Provider behavior tests use real job storage/config/resolver in a temporary
home with sockets denied and fake credentials. They cover all four writers,
two config formats, shared endpoints with different keys, `auto`, aliases,
profile-local credentials, old resolver dictionary shape, pins/fleet defaults,
legacy records, no-agent jobs, actual missing-OAuth fallback, and model impact.
UI tests render real Cron/sidebar/Tasks surfaces and exercise the real native
notifier subscriber. Existing API/history tests protect honest legacy fallback.

## Failure injection and limits

Each reverse mutation must assert its executable anchor occurs once, record
the source hash, require a specific behavioral test failure, and restore the
exact hash. Removing named snapshot preservation must break real producer and
resolver tests. Treating `error` as success must break visible failure and
notification tests. Treating absent outcome as done must break unverified Tasks
and no-success-notification tests. Removing the sidebar or Tasks result label
must break that surface's visible behavior assertion.

Replacing each captured window/document cleanup function with a later property
lookup must fail the same-object teardown behavior test. Retaining contaminated
inherited Python paths or leaking a fake provider key must fail the real
session-kernel environment test.

These smokes can catch provider identity loss and false UI success. They do
not prove external provider availability, an installed-runtime update, a real
timer claim/execution, delivery settlement, production deployment, or a Windows
machine run. Platform-specific Linux execution tests remain platform skips on
Mac; a skip is not acceptance evidence.
