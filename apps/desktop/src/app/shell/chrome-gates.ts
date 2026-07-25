/**
 * Codex-minimal chrome — the always-visible surfaces of OUR product.
 *
 * These constants re-apply the 0.16.17 product decision that the v0.19.0 port
 * silently reverted to upstream behaviour (hc-589 audit §0, group A-1/A-2):
 * the statusbar, the titlebar and the sidebar carry only what a consumer needs
 * on screen at all times. Developer instrumentation (command center, gateway
 * health, working directory, agents, cron, terminal, approval mode, build
 * version, haptics, keybinds, settings gear, layout editor) lives in Settings,
 * the sidebar or the composer instead.
 *
 * They are GATES, not deletions: the upstream arrays stay intact so upstream
 * merges keep applying cleanly, and flipping one line here restores upstream
 * chrome for evaluation.
 */

/**
 * Statusbar allowlists, applied to the CORE clusters only — plugin
 * contributions (`extraLeftItems` / `extraRightItems`) always pass through.
 *
 * Allowlists rather than denylists on purpose: anything upstream adds to the
 * core arrays later stays out of our chrome until somebody admits it here.
 *
 * `version-backend` keeps its own remote-only guard inside the hook, so on a
 * local desktop install no build version is on screen at all — the version
 * belongs in 设置 → 关于 (audit §6).
 */
export const MINIMAL_STATUSBAR_LEFT_IDS: ReadonlySet<string> = new Set()

export const MINIMAL_STATUSBAR_RIGHT_IDS: ReadonlySet<string> = new Set([
  'running-timer',
  'context-usage',
  'session-timer',
  'version-backend'
])

/**
 * Upstream turned the context-usage readout from plain text into a click
 * target that opens a usage breakdown. It adds no always-visible chrome, so we
 * keep it; flip to `false` to get 0.16.17's inert text item back.
 */
export const STATUSBAR_CONTEXT_USAGE_PANEL: boolean = true

/**
 * Titlebar: only the right-sidebar toggle stays pinned to the window edge.
 * The upstream system cluster (layout editor / haptics / keybinds / settings
 * gear) is reachable from Settings and ⌘K.
 */
export const TITLEBAR_SYSTEM_TOOLS: boolean = false

/**
 * Sidebar: 项目 is a section of its own with a count and a remembered
 * open/closed state (0.16.17), not a hidden toggle button inside 会话
 * (upstream). Turning this off restores upstream's grouping-toggle affordance.
 */
export const SIDEBAR_PROJECTS_SECTION: boolean = true

/**
 * Sidebar zero state stays empty. Upstream fills it with a 新建项目 pitch,
 * which frames the product as a project-first developer tool.
 */
export const SIDEBAR_BLANK_STATE_PITCH: boolean = false

/**
 * 搜索 is a main-area page (SEARCH_ROUTE), not a field stacked on top of the
 * sidebar where it pushes 置顶/项目/会话 down on every screen. Turning this on
 * puts upstream's inline field back.
 */
export const SIDEBAR_SEARCH_FIELD: boolean = false
