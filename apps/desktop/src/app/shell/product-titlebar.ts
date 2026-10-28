/**
 * hc-1085: the titlebar's developer controls in single-thread product mode.
 *
 * Kept: 打开设置 and the left edge's 隐藏侧边栏. Folded while
 * `$singleThreadMode` is on (the switch on and not developer mode), each with
 * its shortcut, its ⌘K row and its line in the shortcut lists:
 *
 * - 布局编辑器, and its ⌘-click 重置布局: ⌘⇧\, ⌘K 「Toggle layout edit mode」
 *   and 「Reset layout」;
 * - HUD 模式: ⌘⇧H;
 * - 交换侧边栏位置: ⌘\;
 * - 显示右侧栏: ⌘J. The right side holds the file tree, the git review and the
 *   terminal, and nothing in product mode opens them: previews of links,
 *   deliverables and attachments dock beside the chat as their own zone,
 *   outside this toggle.
 *
 * 0.17.66 showed every one of these in product mode, so a saved layout may
 * already be off the product default. The way back stays until it is used:
 * 交换侧边栏位置 while the sessions sit right of the chat, and the right edge's
 * button while that side is open or holds the sessions. Developer mode and the
 * switch off are untouched.
 */

import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'

import { $fileBrowserOpen, $panesFlipped } from '@/store/layout'
import { $singleThreadMode } from '@/store/single-thread'
import { titlebarAppActionsClusterCounts, type TitlebarAppActionsSide } from '@/store/titlebar-app-actions'

/** Which developer controls are folded right now (true = off screen, its shortcut inert). */
export interface TitlebarFold {
  flip: boolean
  hud: boolean
  layout: boolean
  rightEdge: boolean
}

const NOTHING_FOLDED: TitlebarFold = { flip: false, hud: false, layout: false, rightEdge: false }

export const $titlebarFold = computed(
  [$singleThreadMode, $panesFlipped, $fileBrowserOpen],
  (productMode, flipped, rightOpen): TitlebarFold =>
    productMode ? { flip: !flipped, hud: true, layout: true, rightEdge: !flipped && !rightOpen } : NOTHING_FOLDED
)

/** The shortcut that reaches each folded control. */
const FOLDED_SHORTCUTS: Readonly<Record<string, keyof TitlebarFold>> = {
  'layout.editMode': 'layout',
  'view.flipPanes': 'flip',
  'view.toggleHud': 'hud',
  'view.toggleRightSidebar': 'rightEdge'
}

/** A shortcut whose control is folded does nothing (like hc-960's model-picker chord). */
export function unlessFolded(actionId: string, run: () => void): () => void {
  const control = FOLDED_SHORTCUTS[actionId]

  return () => {
    if (!control || !$titlebarFold.get()[control]) {
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
  const fold = useStore($titlebarFold)

  if (fold === NOTHING_FOLDED) {
    return NONE
  }

  return new Set(Object.keys(FOLDED_SHORTCUTS).filter(actionId => fold[FOLDED_SHORTCUTS[actionId]]))
}

/** The ⌘K rows of the layout editor: its edit-mode toggle and its reset (keys as `usePaletteContributions` builds them). */
const isLayoutEditorRow = (item: { action?: string; key: string }) =>
  item.action === 'layout.editMode' || item.key === 'core:layout.reset'

/** The palette's contributed rows, less the layout editor's while it is folded. */
export function withoutLayoutEditorRows<T extends { action?: string; key: string }>(items: T[]): T[] {
  return $titlebarFold.get().layout ? items.filter(item => !isLayoutEditorRow(item)) : items
}

/** The fixed clusters' button counts (the shell reserves their width) with the folded ones taken out. */
export function titlebarClusterCounts(
  side: TitlebarAppActionsSide,
  leftExtras: number,
  fold: TitlebarFold
): { left: number; right: number } {
  const counts = titlebarAppActionsClusterCounts(side, leftExtras, 0)
  const appActions = Number(fold.layout) + Number(fold.hud)
  const fixed = Number(fold.flip) + Number(fold.rightEdge)

  return side === 'left'
    ? { left: counts.left - appActions, right: counts.right - fixed }
    : { left: counts.left, right: counts.right - appActions - fixed }
}

export function useTitlebarClusterCounts(side: TitlebarAppActionsSide, leftExtras: number) {
  return titlebarClusterCounts(side, leftExtras, useStore($titlebarFold))
}
