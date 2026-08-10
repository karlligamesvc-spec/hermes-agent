# hc-711 Design QA

- Source visual truth: `artifacts/hc711/reference.png`
- Rendered implementation: `artifacts/hc711/implementation.png`
- Side-by-side comparison: `artifacts/hc711/side-by-side.png`
- Source pixels: 1172 × 768
- Implementation pixels: 1172 × 768
- Side-by-side pixels: 2344 × 768
- CSS viewport: 1172 × 768 for both full-window captures
- Device scale / normalization: both app-window captures came from the same macOS display surface at the same native scale; no resize, crop, fit, or density normalization was applied before comparison.
- State: Simplified Chinese, light theme, empty scheduled-task list. The reference is the installed packaged APEX modal; the implementation is the real contribution shell running the branch renderer against an isolated Desktop mock backend.

## Findings

No actionable P0/P1/P2 visual differences remain.

- The rejected capture's empty state sat near the lower-right because the page had no explicit layout owner for the space below `PanelHeader`; it relied on `PanelEmpty` to infer its flex basis in an isolated surface harness. The real page now inserts `PanelPageBody` as a `min-h-0 min-w-0 flex-1 flex-col` child and makes `PanelEmpty` a full-width, flexing centered grid.
- In the corrected implementation, the empty-state group is horizontally and vertically centered in the main content body below the title. It is no longer near the lower-right.
- The source backdrop, floating rounded modal card, shadow, top-right X, and dimmed shell are intentionally absent. The implementation keeps the complete shell visible, including Start/new conversation, Search, Scheduled Runs, and the right-hand scheduled-task page.
- The implementation reuses the existing shell, sidebar, page gutter, typography, Codicon, button, and theme tokens.

## Required fidelity surfaces

1. **Fonts and typography** — Existing Desktop font family, optical weights, sizes, line heights, antialiasing, wrapping, and hierarchy are unchanged. Title/count and empty-state copy remain the same components and translations.
2. **Spacing and layout rhythm** — Both evidence images are exact 1172 × 768 full-window captures. `PanelPageBody` owns all remaining height below the header; `PanelEmpty` owns its full width and centers via grid. The main page retains `PAGE_INSET_X` and titlebar clearance.
3. **Colors and visual tokens** — Page/sidebar backgrounds, active navigation row, text hierarchy, icon opacity, and primary button resolve through existing Desktop tokens. No new palette, gradient, shadow, or bespoke border was introduced.
4. **Image quality and asset fidelity** — Both images retain native capture pixels. The existing Codicon watch glyph is used; there are no handmade SVG, CSS-art, or placeholder substitutions.
5. **Copy and content** — Chinese title, count, empty title, description, and primary action match the reference. The implementation capture visibly includes Start/new conversation (`开始`), Search (`搜索`), and Scheduled Runs (`定时运行`) in the real sidebar.

## Full-view comparison evidence

`artifacts/hc711/side-by-side.png` places the exact-size source and implementation captures together without scaling. The left side shows the old modal/backdrop/X. The right side shows the complete contribution shell and same empty state as a sibling workspace page. The empty-state center aligns with the available page body, not with the whole window or a clipped standalone surface.

## Focused-region evidence

No separate crop is needed: the exact-size full-window comparison keeps the sidebar labels, title/count, empty-state group, modal X, and absence of backdrop/card/X readable. Accessibility inspection additionally reported the real page as a named `定时任务` container and found the create dialog only after the primary action was invoked.

## Interaction and responsive verification

- Desktop full shell: clicked `定时运行`, confirmed route `#/cron`, opened `新建定时任务`, then clicked `取消` and returned to the same page.
- Narrow shell: resized the Electron content viewport to 700 × 800 (the app-window capture including native frame measured 728 × 833), opened the responsive sidebar, clicked `定时运行`, opened the create dialog, cancelled, and returned to the page.
- Narrow layout kept the title, empty copy, and primary action visible without horizontal clipping; the responsive sidebar appeared as its existing overlay rail.
- Initial page state has no route dialog, backdrop, floating card, close control, or top-right X. The create/edit and delete confirmations remain intentional dialogs.
- No renderer console error appeared during the clean Desktop interaction runs. Electron emitted only its existing dev-only deprecation/sandbox diagnostics outside the renderer.

## Comparison history

- **Rejected pass (P1):** `implementation.png` was an isolated 2103 × 1676 surface while the 2440 × 1660 source showed the full app. The empty state appeared around the lower-right and the report incorrectly called it centered.
- **Fix:** added an explicit flexing `PanelPageBody`, gave `PanelEmpty` full-width/min-size constraints, added a real `CronView` accessible-name/layout test, and discarded the isolated harness evidence.
- **Corrected pass:** recaptured source and implementation as full app windows at identical 1172 × 768 pixels, same language/theme/empty state, then rebuilt the unscaled 2344 × 768 side-by-side. No actionable P0/P1/P2 mismatch remains.

## Behavioral guards

- `CronView` now sets `aria-labelledby="cron-page-title"`, and its real heading owns that ID.
- The real `CronView` test asserts the named durable region, heading relationship, `PanelPageBody` parentage/flex ownership, empty state, and absence of route-modal chrome.
- The primitive test asserts `PanelPage > PanelPageBody > PanelEmpty` plus the exact flex/grid relationship required to consume the remaining body.
- Reverse layout fault injection removed `flex-1` from `PanelPageBody`; both the real CronView test and primitive layout test failed at the missing token. The injection was then reverted and both passed.
- The existing route fault injection still proves that restoring `cron` to `OVERLAY_VIEWS` fails the page-identity guard.
- Existing `hermes-cron-scope.test.ts` verifies list/read/create/update/pause/resume/trigger/delete helpers retain active-profile identity.

## Follow-up polish

None required for hc-711.

final result: passed
