import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import { $approvalModes } from '@/store/approval-mode'
import { $activeGatewayProfile } from '@/store/profile'
import { $singleThreadMode } from '@/store/single-thread'
import { $updateApply, $updateStatus } from '@/store/updates'

import type { StatusbarItem } from './statusbar-controls'

/**
 * hc-1015: the status bar in single-thread mode.
 *
 * The bar's own items (gateway, working directory, timers, context meter,
 * version…) are mechanism, and the version and model are exactly what this
 * mode keeps off screen. Two stay, because they need the user:
 *
 *  - ⚡ approvals, only while they are off — then dangerous commands run
 *    without asking, which the user must be able to see (and turn back);
 *  - the version pill, only while an update is waiting or applying — hiding it
 *    is how a client falls behind.
 *
 * Items a plugin contributed pass through: the user installed them. With
 * nothing left the bar is not drawn at all (statusbar-controls.tsx).
 */

export interface SingleThreadStatusbarKeep {
  approvalsOff: boolean
  updatePending: boolean
}

export function singleThreadStatusbarItems(
  items: readonly StatusbarItem[],
  contributed: readonly StatusbarItem[],
  keep: SingleThreadStatusbarKeep
): StatusbarItem[] {
  const fromPlugins = new Set(contributed)

  return items.filter(
    item =>
      fromPlugins.has(item) ||
      (item.id === 'approval-mode' && keep.approvalsOff) ||
      (item.id === 'version-client' && keep.updatePending)
  )
}

interface StatusbarItemSets {
  leftStatusbarItems: StatusbarItem[]
  statusbarItems: StatusbarItem[]
}

interface Contributions {
  extraLeftItems: readonly StatusbarItem[]
  extraRightItems: readonly StatusbarItem[]
}

/** `useStatusbarItems`' result, narrowed while single-thread mode is on. */
export function useSingleThreadStatusbar<T extends StatusbarItemSets>(
  items: T,
  { extraLeftItems, extraRightItems }: Contributions
): T {
  const singleThread = useStore($singleThreadMode)
  const profile = useStore($activeGatewayProfile)
  const approvalsOff = useStore($approvalModes)[profile.trim() || 'default'] === 'off'
  const update = useStore($updateStatus)
  const apply = useStore($updateApply)
  const updatePending = Boolean(update?.updateAvailable) || apply.applying || apply.stage === 'restart'

  return useMemo(() => {
    if (!singleThread) {
      return items
    }

    const keep = { approvalsOff, updatePending }

    return {
      ...items,
      leftStatusbarItems: singleThreadStatusbarItems(items.leftStatusbarItems, extraLeftItems, keep),
      statusbarItems: singleThreadStatusbarItems(items.statusbarItems, extraRightItems, keep)
    }
  }, [approvalsOff, extraLeftItems, extraRightItems, items, singleThread, updatePending])
}
