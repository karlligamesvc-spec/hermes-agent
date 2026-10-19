/**
 * hc-971: the light team (apex-nodes hc-955) the signed-in APEX account belongs
 * to — renderer cache of the cloud's answer, read through the main-process
 * bridge (electron/apex-team.ts; the login JWT never reaches the renderer).
 *
 * The cache is keyed by account: switching accounts drops the previous team at
 * once, and a reply that comes back for an account that is no longer signed in
 * is discarded. Anything uncertain (bridge missing on an older main process, a
 * failed read) shows no team rather than a stale one.
 */

import { atom } from 'nanostores'

import type { DesktopTeamSummary } from '@/global'

export interface AccountTeamState {
  accountId: null | string
  team: DesktopTeamSummary | null
}

export const $accountTeam = atom<AccountTeamState>({ accountId: null, team: null })

let inflight: null | { accountId: string; promise: Promise<void> } = null

/** Re-read the team for `accountId` (account menu mount and open). Never throws. */
export function loadAccountTeam(accountId: null | string | undefined): Promise<void> {
  if (!accountId) {
    inflight = null
    $accountTeam.set({ accountId: null, team: null })

    return Promise.resolve()
  }

  if (inflight?.accountId === accountId) {
    return inflight.promise
  }

  if ($accountTeam.get().accountId !== accountId) {
    $accountTeam.set({ accountId, team: null })
  }

  const read = typeof window !== 'undefined' ? window.hermesDesktop?.managed?.team : undefined

  if (!read) {
    return Promise.resolve()
  }

  const fetchTeam = async (): Promise<void> => {
    let team: DesktopTeamSummary | null = null

    try {
      const result = await read()
      team = result.ok ? result.team : null
    } catch {
      team = null
    }

    // A reply for an account that is no longer signed in is dropped.
    if ($accountTeam.get().accountId === accountId) {
      $accountTeam.set({ accountId, team })
    }
  }

  const promise: Promise<void> = fetchTeam().finally(() => {
    if (inflight?.promise === promise) {
      inflight = null
    }
  })

  inflight = { accountId, promise }

  return promise
}

/** The team to show for `accountId`, never another account's. */
export function teamFor(state: AccountTeamState, accountId: null | string | undefined): DesktopTeamSummary | null {
  return accountId && state.accountId === accountId ? state.team : null
}
