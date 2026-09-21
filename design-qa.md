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

---

# hc-845 Desktop 白色主题与模型选择 Design QA

Reference: the established APEX Desktop white shell and compact composer menu.

## Scope

- Restore the white/light APEX identity for fresh and previously system-following installs.
- Keep an explicit user choice of system theme after the one-time migration.
- Add compact image and video model submenus under the composer add button.
- Keep one persisted selection for images and one for videos.
- Restrict the managed LLM picker to the seven hc-845 text models; cached or
  older relay responses must not reintroduce Kimi K3, GLM 5.2, or Qwen 3.7 Max.

## Visual verification

- P0: the running macOS Desktop shell is white; the navy regression is absent.
- P0: the composer add menu exposes image and video rows with the active friendly model names.
- P0: each submenu shows exactly one selected model and all requested model labels.
- P1: menu density, spacing, borders, and monochrome icons match the existing APEX white UI.
- P2: no price, package, quota, or raw provider identifier is displayed in these menus.
- P0: the live picker connected to the pre-deployment relay no longer shows any
  legacy model. It currently shows the two approved ids already advertised by
  production; the other five become visible when the paired cloud PR deploys.

Verification was performed against the real Electron development build with the local gateway ready.

final result: passed

---

# hc-841 Desktop 首页任务输入区 Design QA

## Evidence

- Source screenshot: `/var/folders/z0/_ltgtgv11p715mn0kd8_1zqc0000gn/T/codex-clipboard-63d9c42d-9c81-42b0-99f6-645520ddb4a5.png`
- Packaged implementation: `apps/desktop/.artifacts/hc-841/start-task-brief-1440x900.png`
- Side-by-side comparison: `apps/desktop/.artifacts/hc-841/reference-vs-implementation.png`
- Review state: macOS packaged APEX, 1440 × 900, zh-CN, signed-in isolated local-review fixture, Start → “拆解并复刻爆款视频”

## Findings

1. The primary task area now uses the same 52rem content axis as the three task entries. The packaged width is 884px at the app's 17px root size, up from the previous 44rem container.
2. The textarea now starts at five rows with a minimum height of 8rem on regular desktop windows and 7rem on narrow windows. The selected task remains fully readable with room for user edits.
3. The visible viral-video brief is now two plain-language sentences. Vendor names, local tooling, implementation phases, reproduction commands, pricing, and plan-confirmation language remain outside the user-visible prompt.
4. Heading hierarchy, attachment control, send action, keyboard focus order, monochrome task artwork, and the single-column task shelf are unchanged.
5. At 1440 × 900, the third task entry reaches the lower edge of the first viewport because the user explicitly prioritized a taller editor. It remains on the same page and immediately reachable by normal scrolling; there is no nested scroll trap or horizontal overflow.
6. The redundant subtitle under the main question is removed. The empty goal field now tells users that they can either describe a goal or drop in an image, video, or file for analysis; all four Desktop locales carry the same behavior and tone.

## Verification

- Packaged Electron geometry and copy regression: `hc-841 Start keeps the primary task brief readable without exposing internal execution details` — passed.
- Full UI suite after rebasing onto current Desktop main: 889 files / 8,488 tests — passed.
- TypeScript — passed.
- ESLint — 0 errors (repository-wide pre-existing warnings only).
- Production renderer build — passed. The earlier packaged macOS geometry evidence remains attached to this change.
- Reverse verification: restoring the removed subtitle made the identity guard fail on the exact visible copy; restoring hc-841 returned it to green. The earlier width/internal-copy reverse checks remain covered.

## Final result

passed
