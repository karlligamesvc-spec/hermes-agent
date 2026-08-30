# hc-803 Design QA — Desktop home persisted-width recovery

- User-approved prototype capture: `/Users/karl/.codex/visualizations/2026/08/30/hc803-home-fidelity/reference-prototype-1223x865@2x.png`
- Reported drift capture: `/Users/karl/.codex/visualizations/2026/08/30/hc803-home-fidelity/reported-stale-1512x865@2x.png`
- Final signed-package captures: `signed-packaged-1223x865@2x.png` and `signed-packaged-1512x865@2x.png` in the same evidence directory
- Same-canvas comparisons: `reference-vs-fixed-1223x865@2x.png` and `stale-vs-fixed-1512x865@2x.png`
- State: Simplified Chinese, light theme, Start route. The reference/report captures use the signed-in production account; isolated package captures use the real shared renderer and mock inference backend, with no fabricated business rows.

## Finding and fix

The Start implementation had not lost the approved typography, 48rem goal
surface, workflow row, evidence grid, or bottom Composer. The visual drift came
from `hermes.desktop.paneStates.v1`: a 360px drag-resize override survived app
updates and overruled the declared 237px rail, pushing the whole home to the
right. Earlier packaged QA used a fresh profile, so it structurally could not
exercise this upgrade state.

hc-803 retains the approved 237px default, introduces an explicit 180–280px
resize contract, and clears only persisted overrides outside that range on the
next renderer boot. Valid user choices remain intact. No conversation, project,
open-state, account, or channel data is migrated or deleted.

## Required fidelity surfaces

1. **Typography and hierarchy** — Existing APEX heading, supporting copy,
   workflow labels, real-data rows, and Composer typography are unchanged.
2. **Spacing and geometry** — The 237px rail, 48rem goal launcher, workflow
   dividers, evidence grid, and bottom Composer match the approved Desktop
   prototype at the same 1223×865 window. The reported 1512×865 window no
   longer carries a 360px rail.
3. **Colors and assets** — Existing APEX tokens, Codicons, background texture,
   borders, radii, and shadows are reused without new palette or fake assets.
4. **Content and state** — No copy, locale key, workflow definition, session,
   task, deliverable, channel, model, or account mapping changed.
5. **Interaction** — Sidebar resizing still works in the new bounded range;
   Start workflow staging and the canonical goal/Run submission path remain
   intact.

## Responsive and platform verification

- Packaged Start is captured and checked at 1223×865, 1440×900, 1512×865,
  1280×800, and 900×720 with no horizontal document overflow.
- The wide packaged geometry asserts a 237px rendered rail, 48rem (816px at the
  packaged root scale) goal launcher, and the existing 34px intro inset.
- The 900×720 evidence region remains reachable by scrolling.
- macOS and Windows consume the same renderer constants and migration. This QA
  does not claim Windows signing or hardware execution; paired Windows release
  remains governed by the shared Desktop release workflow.

## Source, consumer, and recovery inventory

1. Geometry authority: `SIDEBAR_DEFAULT_WIDTH`, `SIDEBAR_MIN_WIDTH`, and
   `SIDEBAR_MAX_WIDTH` in `src/store/layout.ts`.
2. Persisted source: `chat-sidebar.widthOverride` in
   `hermes.desktop.paneStates.v1`, owned by `src/store/panes.ts`.
3. Consumers: contribution-tree `sessions` pane, legacy `chat-sidebar` pane,
   `$sidebarWidth`, and `setSidebarWidth`.
4. Recovery: `reconcileSidebarWidthOverride()` runs after pane registration;
   only out-of-contract width overrides are cleared.
5. Rollback: business-workspace feature rollback keeps the same corrected rail
   contract; no parallel shell-specific constants were introduced.

## Reverse validation and automated evidence

- Unit injection writes a 360px override and proves it is live before recovery;
  `reconcileSidebarWidthOverride()` must clear it and restore 237px. Removing
  the reconcile call leaves the injected width at 360px and fails the exact
  expectation.
- A valid 220px override remains unchanged. New writes below 180px and above
  280px clamp to the current bounds.
- Targeted business/empty-state/sidebar suite: 36/36 passed.
- Full Desktop suite: 557 files passed / 1 skipped; 5622 tests passed / 2
  skipped.
- Release gates: 40/40 Node tests and 10/10 package-stage tests passed.
- Packaged business E2E: 3/3 passed, including the five viewport captures and
  real goal submission through the existing gateway.
- Typecheck and production build passed. Lint passed with 0 errors and the 106
  pre-existing warnings.
- Final package must pass strict Developer ID verification; notarization remains
  skipped when Apple API credentials are not configured.

## Boundary

This slice fixes Desktop visual state recovery only. It does not change the web
console, production Workflow data, DeepSeek Harness status, backend routing,
account data, or Windows signing state.

final result: passed
