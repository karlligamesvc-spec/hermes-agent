# hc-794 Design QA — Start real-work evidence

- Source visual truth: `/Users/karl/.codex/visualizations/2026/08/26/hc794-design-qa/prototype-start-1440x900.png`
- Packaged implementation: `/Users/karl/.codex/visualizations/2026/08/26/hc794-design-qa/implementation-packaged-wide-1440.png`
- Normalized comparison: `/Users/karl/.codex/visualizations/2026/08/26/hc794-design-qa/source-vs-packaged-1440x865-logical.png`
- Additional packaged captures: `implementation-packaged-desktop-1280.png`, `implementation-packaged-narrow-900.png` in the same evidence directory
- Source capture: 1440 × 900 CSS pixels, Simplified Chinese, light theme, Start route
- Implementation capture: packaged `APEX.app` from commit `6068101dd1`, 1440 × 900 outer window / 1440 × 865 renderer viewport, Simplified Chinese, light theme, isolated fresh account
- Normalization: removed only the source's bottom 35 pixels of blank canvas, and reduced the Retina implementation capture from 2880 × 1730 to 1440 × 865. The side-by-side image contains both 1440 × 865 surfaces without fit, stretch, or state substitution.

## Findings

No actionable P0/P1/P2 visual or interaction defects remain in this hc-794 slice.

- The prototype's core information architecture is present: Start, Projects, Workflows, Scheduled, Deliverables, Accounts, and History; goal-first heading; three workflow starters; recent work; task progress; and evidence/deliverables.
- The implementation deliberately retains the existing APEX conversation shell and its bottom composer instead of moving the production composer to the prototype's temporary top-card position. This preserves current message behavior, keyboard shortcuts, project selector, model selector, and Mac/Windows shared renderer.
- The prototype's fake project rows, percentages, platform availability, and deliverables are not copied. Fresh packaged state shows explicit truthful empty states. Runtime-populated rows are covered by real session/task/transcript evidence tests.
- At 900 × 720 the fixed composer pushes the lower evidence sections below the first fold; the renderer remains horizontally contained and the evidence region is reachable by scrolling. The packaged guard scrolls that region into the viewport and verifies it remains usable.

## Fidelity surfaces

1. **Typography** — The implementation uses the existing Desktop font stack, weight hierarchy, text colors, and Chinese translations. The headline and explanatory copy preserve the prototype's goal-first intent while using APEX production wording.
2. **Spacing and layout** — The source and packaged renderer were compared at the same 1440 × 865 content area. The implementation uses the existing centered chat column and fixed composer; workflow, recent-work, and evidence sections align to one 48rem content rail.
3. **Color and tokens** — Sidebar, canvas, primary purple, strokes, muted text, hover states, and controls all resolve through existing APEX theme tokens. No parallel palette or one-off visual system was introduced.
4. **Assets** — Existing Codicon assets are used for navigation, workflows, tasks, artifacts, and actions. No handmade SVG, CSS-art, emoji, or placeholder asset was added.
5. **Copy and data truth** — All visible project/session/task/artifact claims come from the existing session, scheduler-task, and transcript/file/link sources. Loading, empty, partial, and unavailable states use translated production copy rather than prototype mock entities.

## Interaction and responsive verification

- Packaged `APEX.app`: all seven business navigation entries are present, implementation vocabulary is absent, Start's evidence surface is visible, and no startup error banner appears.
- Packaged viewports: 1440 × 900, 1280 × 800, and 900 × 720 all pass without horizontal document overflow. The narrow evidence region is programmatically scrolled into view and asserted visible.
- Real E2E: a durable session is created through the real TUI gateway and mock provider, appears first on Start, appears again in Projects, and restores its stored session when opened.
- Unit behavior: workflow starters prefill the existing composer; live one-shot tasks map progress/latest output; transcript files, images, and links map to deliverables; a failed evidence read never reports a false zero-result state.
- Routes/actions continue to use the canonical Tasks, Artifacts, Projects, and Workflows routes; no duplicate business model or fake entity store was added.

## Reverse validation

- Injected fault: removed `data-business-start-evidence` from the Start implementation.
- Expected guard: `apps/desktop/src/identity-layer.test.tsx` failed specifically because the real-evidence surface disappeared from the identity layer.
- Restored result: the same identity test passed all 24 assertions.

## Follow-up boundary

This slice closes Start/Projects real-data projection and packaged responsive evidence. It does not claim Windows hardware execution, production DSH wiring, or completion of hc-795/hc-796; those remain separate gated work.

final result: passed
