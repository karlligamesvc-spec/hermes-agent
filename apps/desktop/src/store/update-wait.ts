/**
 * hc-1117: what a requested update waits for. The app install keeps its wait in `$shellUpdate`,
 * pushed by the main process; an engine switch answers once per attempt, so its wait is kept here.
 */

import { atom } from 'nanostores'

import type {
  DesktopEngineHolder,
  DesktopRuntimeUpdateApply,
  DesktopShellUpdateDeferralReason,
  DesktopShellUpdateState
} from '@/global'

export interface DesktopUpdateWait {
  reason: DesktopShellUpdateDeferralReason
  /** For `engine_holders`, who holds the engine, when the gate named them. */
  holders: DesktopEngineHolder[] | null
}

export const $runtimeUpdateWait = atom<DesktopUpdateWait | null>(null)

/** Every engine apply answer lands here: a deferred one sets the wait, any other ends it. */
export function noteRuntimeApply(result: DesktopRuntimeUpdateApply): void {
  $runtimeUpdateWait.set(result.deferred ? { reason: result.reason ?? 'active_work', holders: result.holders ?? null } : null)
}

export function desktopUpdateWait(
  shell: DesktopShellUpdateState | null,
  runtime: DesktopUpdateWait | null
): DesktopUpdateWait | null {
  return shell?.deferred ? { reason: shell.deferredReason ?? 'active_work', holders: shell.deferredHolders ?? null } : runtime
}
