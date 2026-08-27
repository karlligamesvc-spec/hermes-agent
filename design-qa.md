# hc-794 Design QA — business Start layout

- Source visual truth: `/Users/karl/.codex/visualizations/2026/08/27/hc794-action-closure/prototype-start-1440x900.png`
- Final signed-package capture: `/Users/karl/.codex/visualizations/2026/08/27/hc794-start-layout/implementation-packaged-wide-1440.png`
- Full-view same-canvas comparison: `/Users/karl/.codex/visualizations/2026/08/27/hc794-start-layout/prototype-vs-packaged-start-layout-1440x874.png`
- Focused top-region comparison: `/Users/karl/.codex/visualizations/2026/08/27/hc794-start-layout/prototype-vs-packaged-start-top-1440x520.png`
- Additional signed-package captures: `implementation-packaged-desktop-1280.png` and `implementation-packaged-narrow-900.png` in the same evidence directory
- Source dimensions: 1440 × 1000 pixels (JPEG payload with `.png` filename); comparison uses its top 1440 × 874 pixels.
- Implementation dimensions: 2880 × 1748 Retina capture of a 1440 × 874 CSS viewport at device scale factor 2; normalized to 1440 × 874 without stretching.
- State: Simplified Chinese, light theme, Start route, isolated fresh account, signed `APEX.app` from clean renderer commit `df8c2f84e5`.

## Findings

No actionable P0, P1, or P2 visual or interaction defect remains in this hc-794 slice.

- The business heading, description, goal field, workflow starters, and real-work evidence now share a left-aligned frame instead of the earlier centered marketing-like composition.
- The prototype's top-right “new goal” action is represented by “开始一个目标”; it focuses the same canonical business-goal textarea and does not create another conversation or transport.
- Recent conversations, running task progress, and transcript-derived deliverables are compressed into a two-column first-screen evidence region. Empty, loading, partial-failure, and degraded states remain truthful.
- The fixed production Composer remains visible for attachments, project/model selection, voice, and advanced controls. This is an intentional product constraint rather than design drift.
- Prototype-only project names, progress percentages, and platform availability are not copied because the Desktop does not have authoritative data for those claims yet.

## Required fidelity surfaces

1. **Typography** — The signed renderer keeps the Desktop font stack and increases the business heading to the prototype's stronger hierarchy. Weight, wrapping, muted description, section labels, and compact evidence copy remain legible at all tested widths.
2. **Spacing and layout rhythm** — The final 48rem business frame is visually close to the prototype's content width. Heading, goal card, workflow row, divider, and two-column evidence preserve the prototype's scan order without horizontal overflow.
3. **Colors and tokens** — Background, elevated goal surface, borders, violet action, muted text, focus, hover, and disabled states all use existing APEX tokens; no parallel palette or gradient was introduced.
4. **Image and icon fidelity** — Production uses the existing Codicon set and APEX surfaces. No handmade SVG, CSS art, emoji, or fake asset was introduced. The source's illustrative workflow art is intentionally represented by established production icons.
5. **Copy and content** — Existing five-locale business copy remains intact. The new top action reuses the already-translated “start a goal” copy, so language parity is preserved without a new translation seam.

## Interaction, accessibility, and responsive verification

- The top action focuses the canonical labelled textarea; keyboard focus remains visible and the field keeps its accessible “业务目标” name.
- Enter submits, Shift+Enter inserts a line, IME composition is protected, rejected/failed submission preserves the draft, and the canonical ChatView submit path remains the only exit.
- Signed packaged E2E: 7/7 passed. The top action focused the field, the goal was submitted through the existing gateway, the user turn rendered, and the streamed mock-inference response appeared in the conversation body.
- Packaged viewports 1440 × 900, 1280 × 800, and 900 × 720 passed without horizontal document overflow. At 900 pixels the evidence region remains reachable by scrolling.
- Full UI suite: 442 files / 3949 tests passed. Targeted business/identity suite: 55/55 before final packaging and 49/49 after the last width correction. Typecheck, lint (0 errors; 106 existing warnings), production build, and `assert-dist-built` passed.
- Strict signature verification passed for `APEX.app`; the embedded install stamp is commit `df8c2f84e584023c18e97ce964025d1654fd6c88`, `dirty: false`. Notarization was skipped because Apple API credentials are not configured.

## Comparison history

1. The pre-slice signed comparison showed a centered heading/goal/workflow stack, no top-right goal action, and recent conversations plus task/deliverable evidence spread vertically below the fold.
2. The first implementation pass left-aligned the business frame, added the focus action, and grouped real evidence into a compact lower grid. The signed same-canvas comparison showed the intended hierarchy but prompted a width measurement check.
3. A 64rem trial visibly overshot the prototype's roughly 750px content width by more than 200px and was rejected as P2 drift.
4. The final implementation restored the 48rem frame, regenerated a clean signed package, and passed the full-view and focused same-canvas comparisons shown above.

## Reverse validation and source/consumer/exit inventory

1. Business Start composition source: one, `BusinessStartHome`.
2. Intro consumer: one, the business-workspace branch in `Intro`.
3. Goal input source: one, `BusinessGoalLauncher`; both the top action and submit button address that same labelled field.
4. Submit exit: one canonical `ChatView.onSubmit`, shared with the fixed Composer.
5. Evidence exits: existing session restore, task deep-link, and artifact open transports only.
6. Rollback exit: the existing `apex.desktop.feature.business-workspace` flag restores the legacy scenario shelf.
7. Reverse injection replaced the business Start consumer with the legacy scenario shelf. The behavioral identity test and source-wiring guard both failed, then returned green after restoration.

## Follow-up boundary

This slice does not claim production Project/Workflow/Run entities, platform-availability truth, Windows hardware execution, hc-795 completion, or hc-796 DSH wiring. Those remain separately gated work.

final result: passed
