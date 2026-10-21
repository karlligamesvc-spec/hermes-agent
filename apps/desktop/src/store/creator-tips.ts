/**
 * hc-995 creator tips (WP4 小白引导): which tip a turn shows.
 *
 * A creator tip is one line of know-how tied to the step a task is waiting on
 * (「识别语音」 → 「开头 3 秒决定完播……」), shown under the process status line.
 * Kael 2026-10-20 (Q1–Q4 all A):
 *
 * - the cloud owns the catalog (apex-nodes app/catalog/creator_tips.json), read
 *   once per window through main (electron/apex-creator-tips.ts), and only when
 *   tips are on: the admin client config's `desktop_features.creator_tips`, or
 *   APEXNODES_CREATOR_TIPS for one install;
 * - a step must run 6 seconds before its turn claims a tip; at most one tip per
 *   turn and three per local day, and each tip once on this device;
 * - the switch is the existing Settings › 外观 › 应用内提示 (`$tipsEnabled`),
 *   one switch for every tip; ✕ closes the tip in that turn only.
 *
 * Tips are for people, never for the model: nothing here enters a prompt.
 */

import { atom } from 'nanostores'

import type { DesktopCreatorTip } from '@/global'
import { desktopFeatureOn } from '@/lib/desktop-features'
import { $creatorTipsDay, $creatorTipsSeen, type CreatorTipsDay } from '@/store/creator-tips-ledger'
import { $tipsEnabled } from '@/store/tips'

export const CREATOR_TIPS_DAILY_CAP = 3
/** How long a step runs before its turn shows a tip: quick steps never flash one. */
export const CREATOR_TIP_DELAY_MS = 6_000
/** A failed catalog read is retried by a later turn, not sooner than this. */
const RETRY_AFTER_MS = 5 * 60_000

export interface TurnTip {
  /** ✕ in this turn: it stays closed there, and the tip is spent anyway. */
  dismissed: boolean
  tipId: string
}

export const $creatorTipsCatalog = atom<readonly DesktopCreatorTip[]>([])
/** One tip per turn, keyed by the turn's key; kept for the life of the window. */
export const $creatorTipByTurn = atom<Readonly<Record<string, TurnTip>>>({})
/** The turn whose tip was used to turn every tip off: it says where to turn them back on. */
export const $creatorTipsTurnedOffIn = atom<null | string>(null)

export function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')

  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * The first tip this device has not shown for the most recent step that still
 * has one; null once today's three are used up. `steps` are tool names, oldest
 * first.
 */
export function chooseCreatorTip(
  catalog: readonly DesktopCreatorTip[],
  steps: readonly string[],
  seen: readonly string[],
  ledger: CreatorTipsDay,
  today: string
): DesktopCreatorTip | null {
  if (ledger.day === today && ledger.count >= CREATOR_TIPS_DAILY_CAP) {
    return null
  }

  const seenIds = new Set(seen)
  const tried = new Set<string>()

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]

    if (tried.has(step)) {
      continue
    }

    tried.add(step)

    const tip = catalog.find(candidate => candidate.steps.includes(step) && !seenIds.has(candidate.id))

    if (tip) {
      return tip
    }
  }

  return null
}

/**
 * The tip a turn shows. A turn that already claimed one keeps it (or nothing,
 * once ✕'d); otherwise a new claim is recorded as seen and counted for today.
 */
export function claimCreatorTip(turnKey: string, steps: readonly string[], now = new Date()): DesktopCreatorTip | null {
  const catalog = $creatorTipsCatalog.get()
  const claimed = $creatorTipByTurn.get()[turnKey]

  if (claimed) {
    return claimed.dismissed ? null : (catalog.find(tip => tip.id === claimed.tipId) ?? null)
  }

  if (!turnKey || !$tipsEnabled.get() || catalog.length === 0) {
    return null
  }

  const today = localDay(now)
  const ledger = $creatorTipsDay.get()
  const tip = chooseCreatorTip(catalog, steps, $creatorTipsSeen.get(), ledger, today)

  if (!tip) {
    return null
  }

  $creatorTipsSeen.set([...$creatorTipsSeen.get(), tip.id])
  $creatorTipsDay.set({ count: ledger.day === today ? ledger.count + 1 : 1, day: today })
  $creatorTipByTurn.set({ ...$creatorTipByTurn.get(), [turnKey]: { dismissed: false, tipId: tip.id } })

  return tip
}

/** ✕: close this turn's tip; it was already spent when it showed. */
export function dismissCreatorTip(turnKey: string): void {
  const claimed = $creatorTipByTurn.get()[turnKey]

  if (claimed && !claimed.dismissed) {
    $creatorTipByTurn.set({ ...$creatorTipByTurn.get(), [turnKey]: { ...claimed, dismissed: true } })
  }
}

/** The admin client config's switch: only a literal `true` turns tips on. */
export function creatorTipsOnInClientConfig(payload: unknown): boolean {
  return desktopFeatureOn(payload, 'creator_tips')
}

let loading: null | Promise<void> = null
/** Settled for this window: the catalog arrived, or tips are off. */
let settled = false
let failedAt = 0

/**
 * Read the catalog once per window, when tips are on. A failed read leaves the
 * catalog empty (no tips, the slow-step hint as before) and a later turn tries
 * again after a few minutes.
 */
export function loadCreatorTips(now = Date.now()): Promise<void> {
  if (loading) {
    return loading
  }

  const desktop = window.hermesDesktop
  const read = desktop?.managed?.creatorTips

  if (settled || !read || (failedAt && now - failedAt < RETRY_AFTER_MS)) {
    return Promise.resolve()
  }

  loading = (async () => {
    let platformOn = false

    try {
      platformOn = creatorTipsOnInClientConfig((await desktop?.clientConfig?.get())?.payload)
    } catch {
      // No cached client config yet: the install's own override can still turn tips on.
    }

    try {
      const result = await read({ platformOn })

      if (!result.enabled || result.tips.length > 0) {
        $creatorTipsCatalog.set(result.enabled ? result.tips : [])
        settled = true

        return
      }

      failedAt = now
    } catch {
      failedAt = now
    }
  })().finally(() => {
    loading = null
  })

  return loading
}

/** Tests only: forget the window's catalog, claims and read state. */
export function resetCreatorTipsForTest(): void {
  loading = null
  settled = false
  failedAt = 0
  $creatorTipsCatalog.set([])
  $creatorTipByTurn.set({})
  $creatorTipsTurnedOffIn.set(null)
}
