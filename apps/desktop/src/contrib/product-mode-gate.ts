/**
 * hc-1085: plugin contributions single-thread product mode leaves out.
 *
 * Product mode lists the assistants in its own sidebar (hc-1077: APEX, 「+」,
 * each row's 「···」). Bot Mode (plugins/hermes-bots) docks a second pane into
 * the same zone, 「助手」, listing the same profiles, and the zone grew a
 * 「会话 | 助手」 tab strip. While `$singleThreadMode` is on (the switch on and
 * not developer mode) these stay out of the registry; they register again the
 * moment it turns off:
 *
 * - `hermes-bots:pane`, the 「助手」 pane. Every way to show it reads the panes
 *   area (the strip's chip, ⌘1…⌘9, the ⌘K show/hide row controller.tsx derives
 *   from hide-only panes, the layout editor, the narrow-window overlay), so
 *   leaving the registry takes it out of all of them.
 * - `hermes-bots:new-agent`, the ⌘K row 「添加助手」, whose only action is a
 *   hint to open that pane.
 * - `hermes-bots:mention-completions` and `hermes-bots:mention-middleware`,
 *   Bot Mode's 「@助手」 messaging: the composer's @ popover offering every
 *   profile's handle, and the send-time note naming the @-ed agents and
 *   pointing the model at its message_agent tool. Product mode does not merge
 *   assistants into Bot Chat (hc-1074 K5), so 「@名字」 is plain text there.
 *
 * Nothing persisted changes: the saved layout keeps the pane where the user
 * left it, so developer mode comes back as it was.
 */

import { computed, type ReadableAtom } from 'nanostores'

import { $singleThreadMode } from '@/store/single-thread'

import { registry } from './registry'
import type { Contribution } from './types'

/** Scoped contribution ids (`<plugin id>:<id>`) product mode holds back. */
export const PRODUCT_MODE_HIDDEN: ReadonlySet<string> = new Set([
  'hermes-bots:pane',
  'hermes-bots:new-agent',
  'hermes-bots:mention-completions',
  'hermes-bots:mention-middleware'
])

function registerOutsideProductMode(contribution: Contribution): () => void {
  let unregister: (() => void) | null = null

  const sync = (productMode: boolean) => {
    if (productMode) {
      unregister?.()
      unregister = null
    } else {
      unregister ??= registry.register(contribution)
    }
  }

  sync($singleThreadMode.get())
  const unlisten = $singleThreadMode.listen(sync)

  return () => {
    unlisten()
    sync(true)
  }
}

/** A plugin's scoped contributions into the registry: one batch, as ever, less any product mode holds back. */
export function registerPluginContributions(contributions: Contribution[]): () => void {
  const held = contributions.filter(contribution => PRODUCT_MODE_HIDDEN.has(contribution.id))

  if (held.length === 0) {
    return registry.registerMany(contributions)
  }

  const rest = contributions.filter(contribution => !PRODUCT_MODE_HIDDEN.has(contribution.id))
  const disposers = [...(rest.length ? [registry.registerMany(rest)] : []), ...held.map(registerOutsideProductMode)]

  return () => disposers.forEach(dispose => dispose())
}

/** Keyed by the tree's store (`$paneVisible` memoizes one per pane id), so each source gets one gated store. */
const heldPaneVisibility = new WeakMap<ReadableAtom<boolean>, ReadableAtom<boolean>>()

/**
 * `host.paneVisibility`. A held-back pane is never on screen, even while the
 * saved layout still has it as its zone's active tab (someone who clicked
 * 「助手」 on 0.17.66): Bot Mode reads this to decide whether it owns the main
 * workspace. Any other pane gets the tree's own store back, unchanged.
 */
export function pluginPaneVisibility(paneId: string, $onScreen: ReadableAtom<boolean>): ReadableAtom<boolean> {
  if (!PRODUCT_MODE_HIDDEN.has(paneId)) {
    return $onScreen
  }

  let held = heldPaneVisibility.get($onScreen)

  if (!held) {
    held = computed([$onScreen, $singleThreadMode], (onScreen, productMode) => onScreen && !productMode)
    heldPaneVisibility.set($onScreen, held)
  }

  return held
}
