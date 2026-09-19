# Desktop design QA — hc-840

- Reference: `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-b6bbe4ae-4483-4055-8b6e-775ef6da23a0.png`
- Link-rendering defect reference: `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-9ec47935-72bd-438b-8550-88edd26f418e.png`
- Build inspected: local `release/mac-arm64/APEX.app` produced from `codex/hc-840-video-agent-home`
- Viewports inspected: 1484 × 865 Start page and 1318 × 768 session transcript, including the narrower state with the artifact preview pane open

## Checks

- Preserved the existing APEX Start-page hierarchy, typography, spacing, colors, card assets, and responsive wrapping.
- Replaced the three visible path titles and summaries with the requested short-video tasks and eight-platform scope.
- Confirmed all titles and platform lists remain legible without clipping in the narrower two-column layout.
- Confirmed the full Start page remains keyboard and accessibility navigable.
- Confirmed selecting “短视频链接下载和转逐字稿” fills the business-goal composer with an actionable Agent prompt and enables execution; it does not masquerade as an existing production Workflow template.
- Confirmed the Workflows catalog remains unchanged and independently reachable.
- Reopened the exact historical Douyin-share turn in the packaged app and confirmed the URL is now a compact inline reference with a normal chain glyph; the giant black arc is gone without changing the stored message.
- Confirmed the repaired `.ref` treatment covers URL, file, folder, image, session, command, tool, skill, Git, diff, staged, terminal, line, and theme references rather than special-casing one provider.
- Compared the live packaged-app capture against the defect screenshot at the same user-message state; typography and bubble spacing remain stable and the link no longer inflates the turn height.

final result: passed
