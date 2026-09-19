# Desktop design QA — hc-840

- Reference: `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-b6bbe4ae-4483-4055-8b6e-775ef6da23a0.png`
- Build inspected: local `release/mac-arm64/APEX.app` produced from `codex/hc-840-video-agent-home`
- Viewport inspected: 1484 × 865 macOS window, including the narrower state with the artifact preview pane open

## Checks

- Preserved the existing APEX Start-page hierarchy, typography, spacing, colors, card assets, and responsive wrapping.
- Replaced the three visible path titles and summaries with the requested short-video tasks and eight-platform scope.
- Confirmed all titles and platform lists remain legible without clipping in the narrower two-column layout.
- Confirmed the full Start page remains keyboard and accessibility navigable.
- Confirmed selecting “短视频链接下载和转逐字稿” fills the business-goal composer with an actionable Agent prompt and enables execution; it does not masquerade as an existing production Workflow template.
- Confirmed the Workflows catalog remains unchanged and independently reachable.

final result: passed
