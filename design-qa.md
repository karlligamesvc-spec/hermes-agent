# hc-711 Design QA

- Source visual truth: `artifacts/hc711/reference.png`
- Browser-rendered implementation: `artifacts/hc711/implementation.png`
- Side-by-side comparison: `artifacts/hc711/side-by-side.png`
- Source pixels: 2440 × 1660
- Implementation capture pixels: 2103 × 1676
- CSS viewport: 2440 × 1676, device scale factor 1
- Density normalization: implementation was fit to the 2440 × 1660 source canvas only for the side-by-side evidence; the unmodified implementation capture is retained separately.
- State: Simplified Chinese, light theme, empty scheduled-jobs list, desktop viewport. A 700 × 800 responsive pass and the create-dialog interaction were checked separately.

## Findings

No actionable P0/P1/P2 visual differences remain.

- The source's backdrop, floating rounded card, shadow, and top-right X are intentionally absent. This is the required information-architecture change, not visual drift.
- The implementation keeps the source hierarchy and content: title/count at upper left, centered watch icon, empty-state title and description, and the existing purple primary action.
- The page uses the existing APEX page background, responsive gutter, typography, button primitive, Codicon icon, and theme tokens. No new visual system or replacement asset was introduced.
- The main-area viewport is taller than the source modal's inner card, so the empty-state group centers in the available page body rather than the old card body. This is expected and keeps the layout stable at narrow and wide sizes.

## Required fidelity surfaces

1. **Fonts and typography** — Existing Desktop font stack, weights, sizes, line heights, antialiasing, hierarchy, wrapping, and truncation are unchanged. The visible title/count/empty copy match the source component implementation.
2. **Spacing and layout rhythm** — Existing responsive `PAGE_INSET_X`, titlebar clearance, panel header/body spacing, empty-state rhythm, and shared button sizing are used. At 700 × 800, document scroll size exactly matched the viewport (700 × 800).
3. **Colors and visual tokens** — Page background, text hierarchy, icon opacity, and primary button all resolve through existing `--ui-*`/theme tokens; no raw colors, gradient, new shadow, or bespoke border was added.
4. **Image quality and asset fidelity** — The screen contains no raster art. The existing Codicon watch glyph is preserved; there are no inline/handcrafted SVG or placeholder substitutions.
5. **Copy and content** — Chinese title, count, empty-state title, explanatory copy, and action label match the reference. Existing i18n catalogs remain authoritative for all locales.

## Full-view comparison evidence

`artifacts/hc711/side-by-side.png` shows the source route modal beside the main-area page at the normalized source canvas. The content hierarchy and token styling are preserved while the forbidden modal chrome is removed.

## Focused-region evidence

A separate crop was not needed: at original resolution the full-view evidence keeps the title/count and empty-state typography readable. Browser DOM inspection additionally confirmed one `[data-cron-surface="page"]`, zero route dialogs, and zero dialog overlays before invoking an editor.

## Interaction and responsive verification

- Primary action tested: “新建定时任务” opened the existing create dialog; Cancel dismissed it.
- Initial route state: zero `role=dialog`, zero `[data-slot="dialog-overlay"]`, no close control.
- Narrow viewport: 700 × 800 CSS px; document scroll width/height remained 700 × 800.
- Browser console: no page warnings or errors after the clean interaction rerun.
- Loading, list, create/edit, pause/resume, trigger, delete, empty, and error behavior remain on the existing Cron API/store paths; the page adds a canonical retryable `ErrorState` for an initial-list failure.

## Comparison history

- Initial comparison: no P0/P1/P2 mismatch. The only large-region differences were the explicitly requested removal of modal/backdrop/X and the expected centering change from card body to page body.
- No visual fixes were required after the first side-by-side pass.

## Behavioral guards

- Route classification asserts `isOverlayView('cron') === false` and that `/cron` fronts/publishes the workspace page.
- `PanelPage` behavior asserts no dialog, backdrop, or close button is rendered.
- Reverse fault injection re-added `cron` to `OVERLAY_VIEWS`; `routes.workspace-reveal.test.ts` failed at the expected guard (`true` vs `false`). The injected change was then removed.
- Existing `hermes-cron-scope.test.ts` verifies every list/read/create/update/pause/resume/trigger/delete helper keeps the active gateway profile identity.

## Follow-up polish

None required for hc-711.

final result: passed
