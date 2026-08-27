# hc-794 Design QA — goal-first Start

- Source visual truth: `/Users/karl/.codex/visualizations/2026/08/27/hc794-action-closure/prototype-start-1440x900.png`
- Current signed-package capture: `/Users/karl/.codex/visualizations/2026/08/27/hc794-goal-launcher/implementation-packaged-wide-1440@2x.png`
- Same-canvas comparison: `/Users/karl/.codex/visualizations/2026/08/27/hc794-goal-launcher/prototype-vs-packaged-goal-launcher-1440x877.png`
- Additional signed-package captures: `implementation-packaged-desktop-1280@2x.png` and `implementation-packaged-narrow-900@2x.png` in the same evidence directory
- Source state: Simplified Chinese, light theme, Start route. The comparison keeps the source's first 1440 × 877 pixels.
- Implementation state: signed packaged `APEX.app` from renderer commit `a22ba2b8d2`, Simplified Chinese, light theme, isolated fresh account. The Retina capture is reduced from 2880 × 1754 to 1440 × 877 without stretching or state substitution.

## Findings

No actionable visual or interaction defect blocks this hc-794 goal-first slice.

- The signed package now carries the prototype's primary business-goal entrance above the workflow starters. It uses APEX's existing tokens and icon library and stays inside the production conversation shell.
- Enter starts the goal, Shift+Enter keeps multiline editing, IME composition is protected, and a rejected or failed submission preserves the draft.
- The launcher is a second view onto `ChatView.onSubmit`; it does not create a second transport, Project, Workflow, Run, or Deliverable model. The fixed bottom Composer remains available for attachments, project/model selection, voice, and advanced controls.
- Production empty states remain truthful. Prototype project names, percentages, platform availability, and deliverables are not copied as fake business data.

## Fidelity surfaces

1. **Typography** — Existing Desktop font stacks, weights, and five-locale copy remain in use. The goal label is accessible while the visible placeholder follows the prototype.
2. **Spacing and layout** — The prototype and signed renderer were judged together in one 1440 × 877 comparison input. The goal card, heading hierarchy, workflow row, recent work, and lower composer remain legible and contained.
3. **Color and tokens** — Sidebar, canvas, violet primary action, strokes, muted copy, focus, and disabled states resolve through APEX theme tokens; no parallel palette was introduced.
4. **Assets** — The submit control uses the existing Codicon set. No handmade SVG, CSS art, emoji, or placeholder asset was added.
5. **Copy and data truth** — Goal-launcher copy is present in Simplified Chinese, Traditional Chinese, English, Japanese, and Arabic. Visible workspace claims still come only from existing sessions, scheduler tasks, and transcript/file/link evidence.

## Interaction and responsive verification

- Strict package signature verification passed for `APEX.app`; Developer ID `Q3S52NJ72G`, hardened runtime, and timestamp are present. Notarization remains intentionally skipped because the Apple notarization API credentials are not configured.
- Packaged launch and business workspace E2E: 7/7 passed.
- The packaged goal launcher submitted `分析美国宠物用品市场并给出有证据支持的上架建议` through the existing gateway, rendered the user turn, and received the streamed mock-inference response.
- Packaged viewports: 1440 × 900, 1280 × 800, and 900 × 720 pass without horizontal document overflow. At 900 pixels wide the lower evidence surface remains reachable by scrolling.
- Unit/UI suite: 442 files / 3948 tests passed; targeted launcher and identity behavior: 48/48 passed.
- Typecheck, lint (0 errors; existing warnings only), production build, and packaged `assert-dist-built` passed.

## Reverse validation

1. Confirmed the production wiring anchor `onSubmitGoal: onSubmit` occurs once.
2. Replaced that one source-to-consumer edge with `onSubmitGoal: undefined` and asserted the injection landed at the target call site.
3. The identity-layer guard failed on the missing canonical submit wiring, while the rest of the zero-state still rendered; this proves the guard protects behavior that could otherwise disappear silently during an upstream rebase.
4. Restored the edge and reran the targeted suite: 48/48 passed.

## Source, consumers, and exits

1. Goal-launcher source: one, `BusinessGoalLauncher`.
2. Zero-state consumer: one, `Intro` when the existing business-workspace flag is enabled.
3. Submit exit: one canonical `ChatView.onSubmit`, also used by the existing bottom `ChatBar`.
4. Rollback exit: the existing `apex.desktop.feature.business-workspace` flag restores the previous scenario shelf and removes the goal launcher.
5. Platform consumers: the same renderer code ships to Mac and Windows; only the signed macOS package is claimed as hardware-tested in this slice.

## Follow-up boundary

This slice closes the prototype's top goal-entry gap without claiming full pixel parity, Windows hardware execution, production DSH wiring, or completion of hc-795/hc-796. Those remain separate gated work.

final result: passed
