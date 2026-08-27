# hc-794 Design QA — workflow-to-goal execution loop

- Source visual truth: `/Users/karl/.codex/visualizations/2026/08/27/hc794-action-closure/prototype-start-1440x900.png`
- Final signed-package capture: `/Users/karl/.codex/visualizations/2026/08/27/hc794-workflow-loop/packaged-start-e221b096-1440x874.png`
- Full-view same-canvas comparison: `/Users/karl/.codex/visualizations/2026/08/27/hc794-workflow-loop/prototype-vs-packaged-workflow-loop-2880x874.png`
- Additional signed-package captures: `business-start-desktop-1280.png` and `business-start-narrow-900.png` under `apps/desktop/test-results` at verification time.
- Source dimensions: 1440 × 1000 pixels; the normalized comparison uses its top 1440 × 874 pixels.
- Implementation dimensions: 2880 × 1736 Retina capture of a 1440 × 868 CSS content viewport at device scale factor 2; normalized to 1440 × 868 and placed on a 1440 × 874 white comparison frame without stretching.
- State: Simplified Chinese, light theme, Start route, isolated fresh account, signed `APEX.app` from clean renderer commit `e221b0965a`.

## Findings

No actionable P0, P1, or P2 visual or interaction defect remains in this hc-794 slice.

- Selecting a workflow on Start now stages its approved business goal in the canonical top goal field and focuses that field. The user can review or edit it before choosing “开始执行”.
- The selected goal submits through the existing `ChatView.onSubmit` path. This slice does not introduce a second conversation, transport, or hidden execution path.
- Start and the full Workflows page now render from one shared three-workflow catalog, preventing copy, icon, prompt, and ordering drift.
- The full Workflows page intentionally preserves its existing “new chat + Composer” selection exit, while Start intentionally uses the top goal field. These are two product contexts sharing one catalog, not duplicate workflow definitions.
- The default Start rendering is unchanged from the fifth-slice signed visual baseline. The new signed capture therefore preserves the already-approved composition while adding the missing interaction closure.

## Required fidelity surfaces

1. **Typography** — The signed renderer preserves the approved Desktop font stack, heading hierarchy, muted supporting copy, workflow labels, wrapping, and optical weights. The staged workflow goal remains readable in the existing textarea without truncation.
2. **Spacing and layout rhythm** — The 48rem business frame, goal surface, workflow row, evidence grid, radii, dividers, and fixed Composer keep the approved hierarchy at all tested widths. No new control or container changes the vertical rhythm.
3. **Colors and tokens** — Background, surface, border, violet action, muted text, focus, hover, and disabled states continue to use existing APEX tokens. No new palette, gradient, shadow system, or parallel theme was introduced.
4. **Image and icon fidelity** — The workflow catalog reuses the production Codicon set and existing APEX surfaces. No handmade SVG, CSS art, emoji, placeholder image, or fake asset was added.
5. **Copy and content** — The same approved three workflow titles, descriptions, and prompts feed both consumers. Existing five-locale UI copy remains intact; no untranslated UI key or prototype-only business claim was introduced.

## Interaction, accessibility, and responsive verification

- Clicking “从市场机会到上架素材” stages `分析美国宠物用品市场，并生成选品报告和上架素材` in the labelled top goal textarea and transfers focus there.
- Enter submits, Shift+Enter inserts a line, IME composition remains protected, and failed submission preserves the draft. Successful submission clears the controlled top draft through the same canonical callback.
- Signed packaged E2E: 7/7 passed. It exercised the workflow card, asserted the exact staged goal, submitted through the existing gateway, rendered the user turn, and received the streamed mock-inference response.
- Packaged viewports 1440 × 868 CSS pixels, 1280 × 800, and 900 × 720 passed without horizontal document overflow. The narrow evidence region remains reachable by scrolling.
- Full UI suite: 442 files / 3950 tests passed. Targeted business/identity suite: 50/50 passed. Typecheck, lint (0 errors; 106 existing warnings), production build, and `assert-dist-built` passed.
- Strict signature verification passed for `APEX.app`; the embedded install stamp is commit `e221b0965a43e5e273f6133a5c63e8dc7f9189e9`, `dirty: false`. Notarization was skipped because Apple API credentials are not configured.

## Comparison evidence and history

1. Earlier hc-794 iterations corrected the centered marketing-like composition, added the top action, restored the measured 48rem frame after rejecting a 64rem P2 width drift, and established the fifth-slice signed visual baseline.
2. This sixth slice changes workflow selection behavior without changing the default Start layout. The new clean signed package was captured at the same wide state and normalized beside the same source visual in `prototype-vs-packaged-workflow-loop-2880x874.png`.
3. The full-view comparison is sufficient for this slice because all visible default-state surfaces remain unchanged and readable at original resolution. A new focused crop was not needed; the earlier top-region focused evidence remains applicable, while the new behavior is proven by packaged E2E and exact-value assertions rather than a static image.
4. The post-change same-canvas pass found no new typography, spacing, color, asset, copy, icon, accessibility, or responsive regression. No visual fix was required, so there is no additional P0/P1/P2 iteration.

## Reverse validation and source/consumer/exit inventory

1. Workflow definition source: one, `businessWorkflowStarters(copy)` in `workflow-starters.ts`.
2. Workflow consumers: two, `BusinessStartShelf` and `BusinessWorkflowsView`.
3. Workflow-selection exits: two intentional context-specific exits. Start invokes `onSelectWorkflow` and stages the prompt in the top goal; Workflows starts a new chat and inserts the prompt through the existing Composer event seam.
4. Start execution exit: one canonical `ChatView.onSubmit`; no additional runtime or transport was added.
5. Standalone fallback exit: `BusinessStartShelf` retains the existing Composer event only when no Start callback is provided, preserving its reusable contract.
6. Reverse injection removed `<BusinessStartShelf onSelectWorkflow={selectWorkflow} />`. The behavioral test failed because the top goal remained empty, and the identity/source guard failed because canonical callback wiring was absent. Both returned green after restoration.
7. Rollback exit: the existing `apex.desktop.feature.business-workspace` flag still restores the legacy scenario shelf.

## Follow-up boundary

This slice does not claim production Project/Workflow/Run entities, platform-availability truth, Windows hardware execution, hc-795 completion, or hc-796 DSH wiring. Those remain separately gated work.

final result: passed
