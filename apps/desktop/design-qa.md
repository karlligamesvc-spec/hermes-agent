# Desktop design QA — hc-848

- References:
  - `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-cae2e3ce-304a-41f3-85e8-83e3061197e2.png`
  - `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-3660a335-c3ec-42e8-a929-de9ed1d813dc.png`
  - `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-d48504b0-4267-42c8-8436-fad77492d749.png`
  - `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-21a7d5c8-85c6-4a2c-b823-51ddc2205d29.png`
  - `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-e03d4607-d117-4399-871c-38241cea90c7.png`
  - `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-51e8632d-6f7c-46fb-abcc-f76b1831907b.png`
- Implementation screenshot: `/tmp/apex-hc848-settings-gateway.png`
- Build inspected: isolated local `release/mac-arm64/APEX.app` from `codex/hc-848-desktop-settings`
- Viewport: 1220 × 800
- State: Settings → Gateway, Simplified Chinese, fresh isolated app data

## Checks

- Restored the current Hermes settings categories to the APEX sidebar: Personalization, Models, Chat, Appearance, Workspace, Security, Browser, Passwords & Login, Memory & Context, Voice, Advanced, Notifications, Providers, Gateway, Keyboard Shortcuts, Tools & Keys, Archived Chats, and About.
- Confirmed the upstream Billing entry is absent from the sidebar and an old `?tab=billing` deep link falls back to Personalization.
- Confirmed the Settings search pill is absent while the rest of the title bar remains aligned.
- Replaced the visible Hermes Cloud mode card with an APEX website card that opens `https://www.apex-nodes.com/`; it does not pretend the website implements the upstream Nous cloud protocol.
- Confirmed the Gateway layout still fits at 1220 × 800 without clipping the navigation or connection cards.
- Confirmed Models no longer waits on the generic config/schema request before rendering its own controls. A reverse fault injection restored the infinite skeleton and made the regression test fail.
- Confirmed the StrictMode mount replay no longer clears freshly loaded config. Models, Chat, and the other schema-backed settings pages render after reopening Settings; an actual gateway profile change still invalidates per-profile state exactly once.
- Confirmed Deliverables image preview sits above the sticky result pagination; the pagination control remains in the dimmed background and no longer crosses the image.
- Confirmed image and video model menus use provider-specific marks without numeric or letter badges on GPT Image and Seedance variants.
- Preserved the existing APEX light theme, spacing, typography, modal dimensions, icons, and keyboard navigation.

final result: passed
