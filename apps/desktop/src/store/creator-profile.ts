/**
 * hc-991 first-use creator intake: renderer cache of the signed-in account's
 * three answers (what they make, where they publish, what troubles them
 * most), read and written through the main-process bridge
 * (electron/apex-creator-profile.ts; the login JWT never reaches the renderer).
 *
 * Keyed by account like store/account-team.ts: switching accounts drops the
 * previous answers at once, and a reply for an account that is no longer
 * signed in is discarded. A failed read shows no cards rather than guessing;
 * a failed save keeps the card on screen so the user can press again.
 */

import { atom } from 'nanostores'

import type { DesktopCreatorProfile, DesktopCreatorProfilePatch } from '@/global'

export interface CreatorProfileState {
  accountId: null | string
  profile: DesktopCreatorProfile | null
  /** loading: first read in flight · ready: the cloud answered · unavailable: no intake for this account or no answer. */
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
}

export const $creatorProfile = atom<CreatorProfileState>({ accountId: null, profile: null, status: 'idle' })

let inflight: null | { accountId: string; promise: Promise<void> } = null

function bridge() {
  return typeof window !== 'undefined' ? window.hermesDesktop?.managed?.creatorProfile : undefined
}

/** Read the answers for `accountId` (Start page and settings mount). Never throws. */
export function loadCreatorProfile(accountId: null | string | undefined): Promise<void> {
  if (!accountId) {
    inflight = null
    $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })

    return Promise.resolve()
  }

  if (inflight?.accountId === accountId) {
    return inflight.promise
  }

  const read = bridge()

  if (!read) {
    $creatorProfile.set({ accountId, profile: null, status: 'unavailable' })

    return Promise.resolve()
  }

  if ($creatorProfile.get().accountId !== accountId) {
    $creatorProfile.set({ accountId, profile: null, status: 'loading' })
  }

  const fetchProfile = async (): Promise<void> => {
    let next: null | Pick<CreatorProfileState, 'profile' | 'status'> = null

    try {
      const result = await read({ action: 'get' })

      // ok without a profile is the cloud's answer: this account has no intake.
      if (result.ok) {
        next = result.profile ? { profile: result.profile, status: 'ready' } : { profile: null, status: 'unavailable' }
      }
    } catch {
      // A broken bridge is a failed read, like any other.
    }

    const current = $creatorProfile.get()

    if (current.accountId !== accountId) {
      return
    }

    // A failed read keeps answers already shown for this account, and otherwise shows no cards.
    if (next || current.status !== 'ready') {
      $creatorProfile.set({ accountId, ...(next ?? { profile: null, status: 'unavailable' }) })
    }
  }

  const promise: Promise<void> = fetchProfile().finally(() => {
    if (inflight?.promise === promise) {
      inflight = null
    }
  })

  inflight = { accountId, promise }

  return promise
}

/** Send one card answer, skip or settings edit; resolves to whether the cloud took it. */
export async function saveCreatorProfile(
  accountId: null | string | undefined,
  patch: DesktopCreatorProfilePatch
): Promise<boolean> {
  const write = bridge()

  if (!accountId || !write || $creatorProfile.get().accountId !== accountId) {
    return false
  }

  try {
    const result = await write({ action: 'save', patch })

    if (!result.ok || !result.profile) {
      return false
    }

    if ($creatorProfile.get().accountId === accountId) {
      $creatorProfile.set({ accountId, profile: result.profile, status: 'ready' })
    }

    return true
  } catch {
    return false
  }
}

/** The answers to show for `accountId`, never another account's. */
export function creatorProfileFor(
  state: CreatorProfileState,
  accountId: null | string | undefined
): DesktopCreatorProfile | null {
  return accountId && state.accountId === accountId && state.status === 'ready' ? state.profile : null
}
