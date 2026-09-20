# hc-840 Desktop 首页任务入口 Design QA

## Evidence

- Source screenshot: `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-21b88b44-1fcb-486c-93a9-c2c94ec9f358.png`
- Icon style reference: `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-e1f9b66e-fcb1-4195-a390-8ae5b9fa6686.png`
- Rendered implementation: `/tmp/hc840-generated-line-icons/start-video-tasks-1220x800.png`
- Full-view comparison: `/tmp/hc840-design-qa/source-vs-implementation.png`
- Focused comparison: `/tmp/hc840-design-qa/cards-focus-before-after.png`
- Reference dimensions: 2230 × 1614 px
- Implementation dimensions: 2440 × 1600 px (1220 × 800 Electron window at 2× density)
- State: zh-CN, signed-in isolated local-review fixture, Start page, light theme, local test project data

## Findings and iteration history

1. The source used two stacked labels, “成熟业务路径” and “三条重点路径”, before the actual choices. They repeated the same idea and made the section read like generated marketing copy. Replaced them with the direct heading “选择一个任务开始” and the instruction “粘贴链接，或告诉我你想分析的内容。”
2. The source reused three decorative raster illustrations whose metaphors did not match download/transcription, frame analysis, or data analysis. A first semantic-icon pass was clearer but too generic; two generated color passes were rejected because 3D volume, gradients, and saturated fills competed with the card copy. The accepted assets are task-specific monochrome line illustrations generated from the supplied style reference: video-to-transcript, frame analysis/remake, and product/social analysis.
3. The three-column layout constrained Chinese titles and summaries to narrow tracks, producing awkward wraps and uneven card heights. The Start page now keeps all three entries in one full-width vertical stack at every approved width; the general workflow catalog retains its responsive multi-column layout.
4. Card copy was rewritten as plain actions and outcomes. Platform coverage is secondary metadata immediately after the task rows under the natural label “支持的平台”; the lower source-management section is renamed from “可用数据源” to “应用连接”.
5. The accepted artwork uses transparent PNGs at 512 px source resolution (34–48 KB each), rendered without background tiles, tint, shadow, or glow. The packaged 1220 × 800 review confirms the line weight stays readable while remaining secondary to the title; dark mode inverts the monochrome artwork so the same assets remain legible.

## Verification

- Packaged visual regression: `hc-840 Start presents three readable video task rows with generated artwork` — passed.
- Responsive geometry matrix: 700, 752, 899, 900, 1000, 1220, and 1235 px — passed with one task row per grid row, no clipped title/summary, and no horizontal overflow.
- Full UI suite: 771 files / 7,663 tests — passed.
- TypeScript, ESLint, and production renderer build — passed (repository-wide pre-existing lint warnings only).
- Interaction coverage: selecting a task still inserts its full prompt into the primary goal composer; keyboard focus order remains textbox → “开始执行”.
- Reverse verification: changing the transcript artwork mapping to a nonexistent regressed asset made `uses task-specific generated artwork for video-transcript` fail on the exact asset contract; restoring the mapping returned the test to green. The prior stacked-grid reverse check remains covered by the home-layout test.

## Final result

passed
