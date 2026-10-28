/**
 * hc-1085: the developer controls single-thread product mode folds.
 *
 * Folded while `$singleThreadMode` is on (the switch on and not developer
 * mode), each with its shortcut (inert, like hc-960's model-picker chord), its
 * ⌘K row and its line in the shortcut lists. Developer mode and the switch
 * off are untouched.
 *
 * The titlebar keeps 打开设置 and the left edge's 隐藏侧边栏 and folds:
 * - 布局编辑器, and its ⌘-click 重置布局: ⌘⇧\, ⌘K 「Toggle layout edit mode」
 *   and 「Reset layout」;
 * - HUD 模式: ⌘⇧H;
 * - 交换侧边栏位置: ⌘\;
 * - 显示右侧栏: ⌘J. The right side holds the file tree, the git review and the
 *   terminal, and nothing in product mode opens them: previews of links,
 *   deliverables and attachments dock beside the chat as their own zone,
 *   outside this toggle.
 *
 * ⌘K folds the developer commands: Reload desktop plugins, Toggle tabs (⌥⌘T),
 * Export / Import profile, Toggle yolo (a per-session approval bypass the
 * product status bar never shows), the hide-only tabs' Toggle rows, Open
 * folder as project (⌘O) with the coding projects under it, Import session,
 * the technical 配置档案 and 派生树 pages, 前往's 技能与工具 / 消息平台 / 排程 /
 * 记忆图谱 and the command center's 会话 / 系统 / 重启网关 rows (排程 is the
 * page the account menu opens as 定时运行); Toggle status bar (⇧⌘S), Toggle
 * terminal (⌃`, ⌃⇧`) and Toggle logs. 产物 stays: it lists the images, files
 * and links the conversations produced.
 *
 * 0.17.66 showed all of this in product mode, so a saved layout may already be
 * off the product default. The way back stays until it is used: 交换侧边栏位置
 * while the sessions sit right of the chat, the right edge's button while that
 * side is open or holds the sessions, Toggle status bar while the bar is
 * hidden, Toggle terminal / logs while that pane is on screen.
 */

import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'

import { $paneVisible } from '@/components/pane-shell/tree/store'
import { $fileBrowserOpen, $panesFlipped } from '@/store/layout'
import { $singleThreadMode } from '@/store/single-thread'
import { $statusbarVisible } from '@/store/statusbar-prefs'
import { titlebarAppActionsClusterCounts, type TitlebarAppActionsSide } from '@/store/titlebar-app-actions'

/** Which developer controls are folded right now (true = off screen, its shortcut inert). */
export interface ProductFold {
  devCommands: boolean
  flip: boolean
  hud: boolean
  layout: boolean
  logs: boolean
  rightEdge: boolean
  statusbar: boolean
  terminal: boolean
}

const NOTHING_FOLDED: ProductFold = {
  devCommands: false,
  flip: false,
  hud: false,
  layout: false,
  logs: false,
  rightEdge: false,
  statusbar: false,
  terminal: false
}

// Every input is a boolean store, which notifies only when its value flips: a
// sash drag rewrites the tree every frame, and must not re-render the shell.
export const $productFold = computed(
  [
    $singleThreadMode,
    $panesFlipped,
    $fileBrowserOpen,
    $statusbarVisible,
    $paneVisible('terminal'),
    $paneVisible('logs')
  ],
  (productMode, flipped, rightOpen, statusbarShown, terminalShown, logsShown): ProductFold =>
    productMode
      ? {
          devCommands: true,
          flip: !flipped,
          hud: true,
          layout: true,
          logs: !logsShown,
          rightEdge: !flipped && !rightOpen,
          statusbar: statusbarShown,
          terminal: !terminalShown
        }
      : NOTHING_FOLDED
)

/** The shortcut that reaches each folded control. */
const FOLDED_SHORTCUTS: Readonly<Record<string, keyof ProductFold>> = {
  'layout.editMode': 'layout',
  'nav.agents': 'devCommands',
  'nav.cron': 'devCommands',
  'nav.messaging': 'devCommands',
  'nav.profiles': 'devCommands',
  'nav.skills': 'devCommands',
  'view.flipPanes': 'flip',
  'view.newTerminal': 'terminal',
  'view.showTerminal': 'terminal',
  'view.toggleHud': 'hud',
  'view.toggleRightSidebar': 'rightEdge',
  'view.toggleStatusbar': 'statusbar',
  'view.toggleTabStrip': 'devCommands',
  'workspace.openFolder': 'devCommands'
}

/** A shortcut whose control is folded does nothing (like hc-960's model-picker chord). */
export function unlessFolded(actionId: string, run: () => void): () => void {
  const control = FOLDED_SHORTCUTS[actionId]

  return () => {
    if (!control || !$productFold.get()[control]) {
      run()
    }
  }
}

/** use-keybinds' built-in handlers with the folded controls' shortcuts gated; every other handler as given. */
export function withFoldedShortcuts<T extends Record<string, () => void>>(handlers: T): T {
  const gated: Record<string, () => void> = { ...handlers }

  for (const actionId of Object.keys(FOLDED_SHORTCUTS)) {
    if (gated[actionId]) {
      gated[actionId] = unlessFolded(actionId, gated[actionId])
    }
  }

  return gated as T
}

const NONE: ReadonlySet<string> = new Set()

/** Shortcut actions the shortcut lists leave out right now: the folded controls'. */
export function useFoldedShortcuts(): ReadonlySet<string> {
  const fold = useStore($productFold)

  if (fold === NOTHING_FOLDED) {
    return NONE
  }

  return new Set(Object.keys(FOLDED_SHORTCUTS).filter(actionId => fold[FOLDED_SHORTCUTS[actionId]]))
}

/** Folded ⌘K rows by palette id (contributed rows as `${source}:${id}`, the way the palette keys them). */
const FOLDED_ROWS: Readonly<Record<string, keyof ProductFold>> = {
  'core:layout.editMode': 'layout',
  'core:layout.reset': 'layout',
  'core:logs.toggle': 'logs',
  'core:plugins.reload': 'devCommands',
  'core:profile.export': 'devCommands',
  'core:profile.import': 'devCommands',
  'core:session.yolo': 'devCommands',
  'core:view.showTerminal': 'terminal',
  'core:view.toggleStatusbar': 'statusbar',
  'core:view.toggleTabStrip': 'devCommands',
  'cc-restart-gateway': 'devCommands',
  'cc-sessions': 'devCommands',
  'cc-system': 'devCommands',
  'nav-agents': 'devCommands',
  'nav-cron': 'devCommands',
  'nav-messaging': 'devCommands',
  'nav-profiles': 'devCommands',
  'nav-skills': 'devCommands',
  'nav-starmap': 'devCommands',
  'session-import': 'devCommands'
}

/** Open folder as project and every coding project under it; the hide-only tabs' Toggle rows. */
const FOLDED_ROW_PREFIXES = ['project-', 'core:strip-tab.']

function rowControl(id: string): keyof ProductFold | undefined {
  return FOLDED_ROWS[id] ?? (FOLDED_ROW_PREFIXES.some(prefix => id.startsWith(prefix)) ? 'devCommands' : undefined)
}

/** The palette's groups less the rows whose control is folded right now; empty groups leave too. */
export function withoutFoldedRows<G extends { items: readonly { id: string }[] }>(groups: G[]): G[] {
  const fold = $productFold.get()

  if (fold === NOTHING_FOLDED) {
    return groups
  }

  return groups
    .map(group => ({
      ...group,
      items: group.items.filter(item => {
        const control = rowControl(item.id)

        return !control || !fold[control]
      })
    }))
    .filter(group => group.items.length > 0)
}

/** The fixed clusters' button counts (the shell reserves their width) with the folded ones taken out. */
export function titlebarClusterCounts(
  side: TitlebarAppActionsSide,
  leftExtras: number,
  fold: ProductFold
): { left: number; right: number } {
  const counts = titlebarAppActionsClusterCounts(side, leftExtras, 0)
  const appActions = Number(fold.layout) + Number(fold.hud)
  const fixed = Number(fold.flip) + Number(fold.rightEdge)

  return side === 'left'
    ? { left: counts.left - appActions, right: counts.right - fixed }
    : { left: counts.left, right: counts.right - appActions - fixed }
}

export function useTitlebarClusterCounts(side: TitlebarAppActionsSide, leftExtras: number) {
  return titlebarClusterCounts(side, leftExtras, useStore($productFold))
}
