# hc-703 Design QA

- Reference: `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-6b78be5d-b008-4810-b6cb-ff54d9b63027.png`
- Implementation: `/Users/karl/projects/.wt/hc690/artifacts/hc703-implementation.png`
- Model-menu verification: `/Users/karl/projects/.wt/hc690/artifacts/hc703-effort-menu.png`
- Reference dimensions: 1556 × 642 (cropped Codex Desktop state)
- Implementation viewport: 1129 × 768 (APEX Desktop production renderer, local packaged build)
- State: docked composer, desktop width, empty editor, toolbar visible; Chinese model catalog opened separately

## Fidelity surfaces

1. **Composition** — the docked composer spans the working column and keeps the project/context strip above the input surface.
2. **Hierarchy** — the writing area occupies two comfortable lines; the third visual row is a stable toolbar with capabilities left and model/voice/send controls right.
3. **Spacing and geometry** — 72 px editor minimum, one compact row gap, aligned toolbar baselines, 64 rem desktop maximum, and responsive width clamping.
4. **Visual language** — existing APEX glass fill, border, radius, type, icon library, and high-contrast circular primary action are preserved.
5. **Behavior and content** — keyboard submit, queue, voice, capability menu, scenario, approval, model picker, pop-out, narrow-pane adaptation, and per-model reasoning subsets remain wired.

## QA history

- P1 fixed: the one-line editor and inline toolbar made the composer feel short and crowded.
- P1 fixed: explicit reasoning efforts used hard-coded English while inherited effort used localized text.
- P1 fixed: a saved unsupported effort could disagree between the model row and its capability-filtered submenu.
- P2 fixed: the loading skeleton height now matches the expanded docked composer.
- No open P0/P1/P2 visual issues after real Electron inspection and side-by-side comparison.

## Final result

passed
