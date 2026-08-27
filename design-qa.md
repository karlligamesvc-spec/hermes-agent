# hc-794 Design QA — workspace action closure

- Source visual truth: `/Users/karl/.codex/visualizations/2026/08/27/hc794-action-closure/prototype-start-1440x900.png`
- Current signed-package capture: `/Users/karl/.codex/visualizations/2026/08/27/hc794-action-closure/implementation-packaged-wide-1440@2x.png`
- Same-canvas comparison: `/Users/karl/.codex/visualizations/2026/08/27/hc794-action-closure/prototype-vs-packaged-1440x868.png`
- Additional signed-package captures: `implementation-packaged-desktop-1280@2x.png` and `implementation-packaged-narrow-900@2x.png` in the same evidence directory
- Source state: Simplified Chinese, light theme, Start route. The comparison removes only the source capture's blank lower canvas and keeps the first 1440 × 868 pixels.
- Implementation state: packaged `APEX.app` from renderer commit `6db5a60268`, Simplified Chinese, light theme, isolated fresh account. The Retina capture is reduced from 2880 × 1736 to 1440 × 868 without stretching or state substitution.

## Findings

No actionable visual or interaction defect blocks this hc-794 action-closure slice.

- The signed package preserves the prototype's business information architecture: Start, Projects, Workflows, Scheduled, Deliverables, Accounts, and History; goal-first copy; three workflow starters; recent work; task progress; and evidence/deliverables.
- The implementation deliberately retains the existing APEX conversation shell and fixed bottom composer. This keeps current message behavior, shortcuts, project selection, model selection, and the shared Mac/Windows renderer instead of copying the prototype's temporary top composer.
- Production empty states remain truthful. Prototype project names, percentages, platform availability, and deliverables are not copied as fake business data.
- Concrete task rows on Start and Projects now preserve the real scheduler job ID in `/tasks?task=<id>` and the Tasks page selects that exact item, including switching to its running/completed status tab.
- Concrete artifact rows on Start and Projects now use the same local/remote open transport as the canonical Artifacts page. Section-header actions still open the aggregate Tasks and Artifacts views.

## Fidelity surfaces

1. **Typography** — Existing Desktop font stacks, weights, and translated Chinese copy remain in use. The hierarchy is quieter than the visual prototype but keeps its goal-first intent.
2. **Spacing and layout** — The source and signed renderer are judged together in one 1440 × 868 comparison input. The renderer remains horizontally contained at 1440 × 900, 1280 × 800, and 900 × 720 outer window sizes.
3. **Color and tokens** — Sidebar, canvas, primary purple, strokes, muted text, hover states, and controls continue to resolve through APEX theme tokens. No parallel palette was introduced.
4. **Assets** — Existing icon assets are used for navigation, workflows, tasks, artifacts, and actions. No handmade SVG, CSS art, emoji, or placeholder asset was added.
5. **Copy and data truth** — Visible session/task/artifact claims come from the existing session, scheduler-task, and transcript/file/link sources. Loading, empty, partial, and unavailable states remain explicit.

## Interaction and responsive verification

- Current signed package: all seven business navigation entries are present, implementation vocabulary is absent, Start's evidence surface is reachable, and no startup error banner appears.
- Packaged business workspace E2E: 2/2 passed. The fixture tolerates both valid first-start outcomes: the preconfigured runtime can become ready immediately, or the provider escape hatch can briefly render and be dismissed.
- Packaged launch smoke: 4/4 passed against the signed app (title, renderer DOM, boot overlay, screenshot).
- Packaged viewports: 1440 × 900, 1280 × 800, and 900 × 720 pass without horizontal document overflow. At 900 pixels wide the lower evidence surface remains reachable by scrolling.
- Real-history E2E: a durable TUI session is created through the real gateway and mock provider, appears on Start and Projects, and restores its current stored tip when reopened.
- Unit behavior: workflow starters prefill the existing composer; live one-shot tasks map progress/latest output; transcript files, images, and links map to deliverables; failed evidence reads never report a false zero-result state.

## Reverse validation

1. Replaced both concrete task exits with the aggregate `/tasks` route. The business-workspace test failed because it expected `/tasks?task=job-1` and received `/tasks`.
2. Replaced the concrete artifact action with aggregate Artifacts navigation. The same test failed because the canonical Desktop open transport was never called.
3. Restored both behaviors and reran the targeted suite: 31/31 assertions passed.

## Follow-up boundary

This slice closes real-data action routing and refreshes packaged responsive evidence. It does not claim full pixel parity with the prototype, Windows hardware execution, production DSH wiring, or completion of hc-795/hc-796. Those remain separate gated work.

final result: passed
