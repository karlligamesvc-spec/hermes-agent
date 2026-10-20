/**
 * hc-995 今日点子: renderer cache of the signed-in account's ideas for today,
 * read and answered through the main-process bridge (electron/apex-daily-ideas.ts;
 * the login JWT never reaches the renderer). The cloud picks and words every
 * card; this store only holds the page on screen.
 *
 * Keyed by account like store/creator-profile.ts: switching accounts drops the
 * previous cards at once, and a reply for an account that is no longer signed in
 * is discarded. The section is off unless the admin client config turns it on
 * (`desktop_features.daily_ideas`) or the install's APEXNODES_DAILY_IDEAS does.
 * A failed first read shows nothing; a failed later read keeps the cards shown.
 */

import { atom } from 'nanostores'

import type { DesktopDailyIdeaCard, DesktopDailyIdeaDislikeReason, DesktopDailyIdeasPage } from '@/global'
import { desktopFeatureOn } from '@/lib/desktop-features'

export interface DailyIdeasState {
  accountId: null | string
  page: DesktopDailyIdeasPage | null
  /** loading: first read in flight · ready: cards on screen · hidden: off, no API, or nothing read yet. */
  status: 'hidden' | 'idle' | 'loading' | 'ready'
}

export const $dailyIdeas = atom<DailyIdeasState>({ accountId: null, page: null, status: 'idle' })

let inflight: null | { accountId: string; page: number; promise: Promise<boolean> } = null
/** Only the newest read lands: an older one (a refresh, the page before 换一批) is dropped. */
let latestRead = 0

function bridge() {
  return typeof window !== 'undefined' ? window.hermesDesktop?.managed?.dailyIdeas : undefined
}

async function platformOn(): Promise<boolean> {
  try {
    return desktopFeatureOn((await window.hermesDesktop?.clientConfig?.get())?.payload, 'daily_ideas')
  } catch {
    // No cached client config yet: the install's own override can still turn it on.
    return false
  }
}

/** The page for this account, or null while another account's (or nothing) is held. */
export function dailyIdeasFor(state: DailyIdeasState, accountId: null | string | undefined): DesktopDailyIdeasPage | null {
  return accountId && state.accountId === accountId && state.status === 'ready' ? state.page : null
}

/**
 * Read page `page` of today's ideas for `accountId` (Start page mount, 换一批,
 * after 不喜欢). Resolves to whether a page arrived. Never throws.
 */
export function loadDailyIdeas(accountId: null | string | undefined, page = 0): Promise<boolean> {
  if (!accountId) {
    inflight = null
    $dailyIdeas.set({ accountId: null, page: null, status: 'idle' })

    return Promise.resolve(false)
  }

  if (inflight?.accountId === accountId && inflight.page === page) {
    return inflight.promise
  }

  const read = bridge()

  if (!read) {
    $dailyIdeas.set({ accountId, page: null, status: 'hidden' })

    return Promise.resolve(false)
  }

  if ($dailyIdeas.get().accountId !== accountId) {
    $dailyIdeas.set({ accountId, page: null, status: 'loading' })
  }

  const serial = ++latestRead

  const fetchPage = async (): Promise<boolean> => {
    let next: DailyIdeasState['page'] = null
    let off = false

    try {
      const result = await read({ action: 'get', page, platformOn: await platformOn() })

      off = result.ok && !result.enabled
      next = result.ok && result.enabled ? result.page : null
    } catch {
      // A broken bridge is a failed read, like any other.
    }

    const current = $dailyIdeas.get()

    if (current.accountId !== accountId || serial !== latestRead) {
      return false
    }

    if (next) {
      $dailyIdeas.set({ accountId, page: next, status: 'ready' })

      return true
    }

    // Switched off hides the section; a failed read keeps cards already shown.
    if (off || current.status !== 'ready') {
      $dailyIdeas.set({ accountId, page: null, status: 'hidden' })
    }

    return false
  }

  const promise: Promise<boolean> = fetchPage().finally(() => {
    if (inflight?.promise === promise) {
      inflight = null
    }
  })

  inflight = { accountId, page, promise }

  return promise
}

async function sendFeedback(
  idea: DesktopDailyIdeaCard,
  kind: 'dislike' | 'start',
  reason?: DesktopDailyIdeaDislikeReason
): Promise<boolean> {
  const write = bridge()

  if (!write) {
    return false
  }

  try {
    const result = await write({ action: 'feedback', ideaId: idea.id, kind, platformOn: await platformOn(), reason })

    return result.ok
  } catch {
    return false
  }
}

/** 开做: the card shows as started at once; the cloud counts it in the background. */
export function markDailyIdeaStarted(accountId: null | string | undefined, idea: DesktopDailyIdeaCard): void {
  const current = $dailyIdeas.get()

  if (accountId && current.accountId === accountId && current.page) {
    $dailyIdeas.set({
      ...current,
      page: { ...current.page, cards: current.page.cards.map(card => (card.id === idea.id ? { ...card, started: true } : card)) }
    })
  }

  void sendFeedback(idea, 'start')
}

/**
 * 不喜欢 with a reason: the cloud drops the card for today and the same page is
 * read again, so the next idea takes its place and the others stay put.
 * Resolves to whether the cloud took it.
 */
export async function dislikeDailyIdea(
  accountId: null | string | undefined,
  idea: DesktopDailyIdeaCard,
  reason: DesktopDailyIdeaDislikeReason
): Promise<boolean> {
  const page = $dailyIdeas.get().page?.page ?? 0

  if (!accountId || $dailyIdeas.get().accountId !== accountId || !(await sendFeedback(idea, 'dislike', reason))) {
    return false
  }

  inflight = null // a read that left before the dislike would bring the card back
  await loadDailyIdeas(accountId, page)

  return true
}

/** Tests only: forget the in-flight read and the page. */
export function resetDailyIdeasForTest(): void {
  inflight = null
  $dailyIdeas.set({ accountId: null, page: null, status: 'idle' })
}
