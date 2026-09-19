# hc-835 Design QA — APEX Desktop 登录回调

- Source visual truth: `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-54883ee1-b83e-4c96-a840-2d81a6d700d6.png`
- Source pixels: 856×638 at 1× density.
- Implementation: the real `startLoopbackLogin()` success response rendered in the Codex in-app browser at 856×638 CSS pixels and 1× density.
- Comparison evidence: a browser-rendered, same-canvas 1220×500 comparison at 0.68 scale, with the 856×638 source on the left and the live 856×638 APEX callback on the right (`http://127.0.0.1:50340/`, local QA session only).
- State: Simplified Chinese, success callback, dark theme.

## Findings and comparison history

1. **First pass — P2 status-icon mismatch.** The initial Tabler filled icon exposed the page background through its check, making the check black instead of the reference's white. Its painted circle also occupied only 20/24 of the image box, so it appeared smaller and shifted the visual hierarchy downward.
2. **Fix.** The final self-contained asset composes the existing Tabler filled-circle and check paths with explicit semantic colors, crops the icon view box to its painted bounds, and adjusts the content group by 5–17 px to align the icon, title, copy, and CTA with the reference.
3. **Post-fix evidence.** The final same-canvas comparison shows the icon, heading, two-line explanatory copy, and full-width CTA aligned within approximately 0–5 px of the reference at the source viewport. The visible product-name changes from ZCode to APEX are intentional and required.

No focused crop was needed: at the normalized 0.68 comparison scale, all typography, both icons, button geometry, and copy remained clearly readable in the full-view evidence.

## Required fidelity surfaces

- **Fonts and typography:** platform-native Chinese/desktop font stack, 32 px/750 heading, 27 px/600 supporting copy, and 28 px/700 CTA reproduce the source hierarchy without loading a remote font.
- **Spacing and layout rhythm:** 688 px CTA width, 72 px height, 15 px radius, centered 72 px status icon, two-line copy, and vertical positions match the 856×638 reference. A <=620 px breakpoint keeps the page usable on narrow browser windows.
- **Colors and visual tokens:** `#151515` background, `#f7f7f7` heading, muted `#9b9b9f` copy, light CTA, and APEX green success state match the visible palette and retain accessible contrast.
- **Image quality and asset fidelity:** status and external-link icons come from the project's pinned Tabler Icons library and are embedded as lossless data-image assets; there are no remote assets, placeholder glyphs, emoji, or handcrafted CSS icons.
- **Copy and content:** “登录已完成”, APEX synchronization copy, and “打开 APEX” replace every ZCode reference while preserving the target meaning.

## Behavior and accessibility

- The CTA has a visible keyboard focus ring, hover/active states, and reduced-motion handling.
- The CTA uses `apexnodes://open?source=login-complete`, which focuses APEX without replaying the one-time login route.
- Success and failure responses use no-store, no-referrer, nosniff, and a restrictive content-security policy.
- Browser console check returned no warnings or errors.
- Automated callback tests verify the real HTTP response, APEX-only copy, deep link, headers, success/failure states, and absence of “ZCode”.

## Residual boundaries

- The visual reference defines only the success state. The failure state deliberately reuses the same layout with a red Tabler status icon and recovery copy.
- The final production artifact still requires the paired macOS/Windows release workflow; this report does not claim Windows signing or hardware execution.

final result: passed
