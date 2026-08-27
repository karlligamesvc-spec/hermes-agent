# APEX cross-client experience contract

## Scope

hc-697 connects the Desktop vNext business-workspace skeleton to state that
already exists in Hermes v0.20. It does not introduce Project, Workflow, or
Review records and does not change the updater, installer, model, MCP, or Skill
surfaces.

## Authoritative data mapping

| Workspace presentation          | Existing authority                                                        | Mapping rule                                                                                                                                                                               | Canonical fallback              |
| ------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| Recent conversations            | `$sessions`, the active-profile recents slice populated by the controller | Non-empty, non-cron sessions ordered by `last_active`; open the projected `session.id`, exactly like sidebar/search/command center                                                         | History / original conversation |
| Conversation state              | `$sessionStates`                                                          | Match the listed tip or its lineage root to live `busy` / `needsInput`; state is never inferred from copy                                                                                  | Original conversation           |
| Tool activity / status          | `SessionInfo.tool_call_count` + `$sessionStates`                          | Show the stored call count as activity only; running / needs-input are live session status. Tool-level status and structured evidence are explicitly deferred to the original conversation | Original conversation           |
| Recent tasks                    | `$tasks` (one-shot cron jobs)                                             | Order by parsed `last_run_at`, then `next_run_at`, then id; lifecycle uses `taskPhase`; a summary-row action carries the real job id through `taskDetailRoute`                              | Selected Tasks detail           |
| Task progress and latest output | `getCronJobRuns` + run transcript                                         | Pick `primaryRun`; derive todo progress and latest assistant output with `deriveProgress`                                                                                                  | Tasks detail                    |
| Evidence and deliverables       | all-profile recent session list + stored transcripts                      | Same bounded 30-session source window and `collectArtifactsForSession` parser as Artifacts; cron run sessions remain included; row actions reuse the canonical local/remote open seam         | Artifacts / source conversation |

Start and Projects consume this table through the same bounded evidence hook.
Start limits the projection to two active one-shot tasks and two recent
deliverables; it does not run a second mapping algorithm or advertise platform
capabilities that the runtime has not reported.

The workspace is a recent-work summary, not a new project domain. It never
creates grouping, ownership, approval, progress, evidence, or deliverable data.

## Read and recovery exits

1. Sessions: active-profile recents cache (`$sessions`) and the canonical History
   page; restore through `openSession(session.id)`.
2. Tasks: `$tasks` projection, `getCronJobRuns`, run transcript, and the Tasks
   page. A row opens `/tasks?task=<real job id>` and the Tasks surface selects
   the matching running or finished detail. The recent-work summary does not
   claim a direct run-conversation link.
3. Artifacts: all-profile session list, transcript reads, Artifacts page, source
   conversation, and native/remote file-open behavior owned by Artifacts. A
   concrete summary row uses that same open behavior; only the section-level
   action opens the aggregate Artifacts page.
4. Live session state: `$sessionStates` runtime-to-stored-id mapping; the
   workspace only reads `busy` and `needsInput`.
5. Platform output: macOS and Windows consume the same renderer route and
   stores. There is no OS-specific information architecture branch.

## Empty, degraded, and missing-capability behavior

- A pristine profile still lands on the real composer and can chat immediately.
- Start shows live one-shot tasks and recent transcript-derived deliverables
  when present. A read failure is labelled as unavailable and never collapsed
  into a false zero-result state.
- No history shows a start-chat action and a direct link to Tasks. It does not
  show sample projects, fake percentages, fake evidence, or sample files.
- A task without a run, todo plan, or assistant output says that progress has
  not been recorded and keeps the Tasks link available.
- Tool-call count is labelled as recorded activity, never as current tool
  status. The summary states that tool-level status and structured evidence
  remain authoritative in the original conversation.
- A partial transcript/profile/task-read failure leaves successful rows visible,
  reports that some evidence is unavailable, and keeps History, Tasks, and
  Artifacts reachable.
- An older backend or a total evidence-list failure keeps the existing cached
  summary when present and shows the limitation. There is no empty shell button.

## Refresh and race contract

- Evidence refresh is keyed to bounded session/task identity and scheduler
  timestamps, not token-stream deltas.
- A refresh keeps the previous successful snapshot on screen; it does not blank
  the workspace while reads are in flight. If a later top-level refresh fails
  after an empty snapshot, failure takes priority over the old empty state.
- Late results from a superseded render are discarded.
- One refresh reads at most four task run lists and thirty session transcripts.
  A transcript shared by task progress and artifact discovery is read once.

## Rollback

`apex.desktop.feature.business-workspace=0` retains hc-685's exact legacy
sidebar contract. No history is migrated or deleted. Data that cannot be
mapped remains available through its original conversation, Tasks, or Artifacts
surface.

## Verification

```bash
cd apps/desktop
npx vitest run src/app/business-workspace/workspace-model.test.ts \
  src/app/business-workspace/business-workspace.test.tsx
npm run typecheck
npm run lint
npm run build
npx playwright test e2e/business-workspace-history.spec.ts
npm run pack
npx playwright test e2e/business-workspace-packaged.spec.ts
```

The dev-Electron history E2E creates a durable session through the real TUI
gateway, first proves that Start projects it, then opens Projects and proves
that the projected row restores the current stored session tip with its
transcript intact. The packaged smoke separately covers a pristine isolated
macOS profile, the shared renderer identity, and screenshots at 1440×900,
1280×800, and 900×720; its fake boot cannot seed backend history and is not
evidence for historical-data mapping. A real Windows machine and Windows
package remain a release gate; a macOS host must not claim Windows hands-on
validation.

## Failure injection

- Change `RecentConversation.id` back to `_lineage_root_id || id`: the compressed
  lineage mapping test fails because visible restore exits must use the current
  projected tip.
- Remove `last_run_at` sorting: the shuffled scheduler-order test fails.
- Exclude cron sessions or remove transcript deduplication: the task-deliverable
  test fails or observes two reads for the same run.
- Make task or transcript readers reject: the partial-data test requires explicit
  failure counts and no synthetic replacement rows.
- Replace `taskDetailRoute(task.id)` with the bare Tasks route: the business
  workspace interaction test fails because the selected task id disappears.
- Replace the concrete artifact row action with aggregate Artifacts navigation:
  the interaction test fails because the desktop open seam is never called.
