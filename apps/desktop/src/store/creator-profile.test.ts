import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopCreatorProfile, DesktopCreatorProfileRequest, DesktopCreatorProfileResult } from '@/global'

import { $creatorProfile, creatorProfileFor, loadCreatorProfile, saveCreatorProfile } from './creator-profile'

type Bridge = (request: DesktopCreatorProfileRequest) => Promise<DesktopCreatorProfileResult>

const PENDING: DesktopCreatorProfile = {
  answers: { contentType: null, contentTypeOther: null, painPoint: null, platforms: [] },
  intake: { completed: false, nextStep: 'content_type', skipped: [] }
}

const ANSWERED: DesktopCreatorProfile = {
  answers: { contentType: 'vlog', contentTypeOther: null, painPoint: null, platforms: [] },
  intake: { completed: false, nextStep: 'platforms', skipped: [] }
}

function installBridge(bridge: Bridge | undefined) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = bridge
    ? { managed: { creatorProfile: bridge } }
    : undefined
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(r => {
    resolve = r
  })

  return { promise, resolve }
}

describe('creator profile cache (hc-991 first-use intake)', () => {
  beforeEach(() => {
    $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
  })

  afterEach(() => {
    installBridge(undefined)
    vi.restoreAllMocks()
  })

  it('reads the answers for the signed-in account', async () => {
    const bridge = vi.fn<Bridge>().mockResolvedValue({ ok: true, profile: PENDING })
    installBridge(bridge)
    await loadCreatorProfile('acc-1')
    expect(bridge).toHaveBeenCalledWith({ action: 'get' })
    expect(creatorProfileFor($creatorProfile.get(), 'acc-1')).toEqual(PENDING)
  })

  it('never shows one account the answers of another', async () => {
    const first = deferred<DesktopCreatorProfileResult>()
    installBridge(
      vi.fn<Bridge>().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ok: true, profile: PENDING })
    )

    const late = loadCreatorProfile('acc-1')
    await loadCreatorProfile('acc-2')
    first.resolve({ ok: true, profile: ANSWERED })
    await late

    expect($creatorProfile.get()).toEqual({ accountId: 'acc-2', profile: PENDING, status: 'ready' })
    expect(creatorProfileFor($creatorProfile.get(), 'acc-1')).toBeNull()
    expect(creatorProfileFor({ accountId: 'acc-1', profile: ANSWERED, status: 'ready' }, 'acc-2')).toBeNull()
  })

  it.each<[string, Bridge | undefined]>([
    ['an older main process without the bridge', undefined],
    ['a failed read', async () => ({ message: 'FETCH_FAILED', ok: false, profile: null })],
    ['an account without the intake', async () => ({ ok: true, profile: null })],
    [
      'a bridge that throws',
      async () => {
        throw new Error('boom')
      }
    ]
  ])('%s shows no cards', async (_label, bridge) => {
    installBridge(bridge)
    await loadCreatorProfile('acc-1')
    expect($creatorProfile.get().status).toBe('unavailable')
    expect(creatorProfileFor($creatorProfile.get(), 'acc-1')).toBeNull()
  })

  it('a failed refresh keeps the answers already shown, and a cloud "no intake" clears them', async () => {
    const bridge = vi
      .fn<Bridge>()
      .mockResolvedValueOnce({ ok: true, profile: ANSWERED })
      .mockResolvedValueOnce({ message: 'FETCH_FAILED', ok: false, profile: null })
      .mockRejectedValueOnce(new Error('bridge gone'))
      .mockResolvedValueOnce({ ok: true, profile: null })

    installBridge(bridge)
    await loadCreatorProfile('acc-1')
    await loadCreatorProfile('acc-1')
    await loadCreatorProfile('acc-1')
    expect(creatorProfileFor($creatorProfile.get(), 'acc-1')).toEqual(ANSWERED)

    await loadCreatorProfile('acc-1')
    expect($creatorProfile.get()).toEqual({ accountId: 'acc-1', profile: null, status: 'unavailable' })
  })

  it('a save replaces the cached answers with what the cloud returned', async () => {
    const bridge = vi
      .fn<Bridge>()
      .mockResolvedValueOnce({ ok: true, profile: PENDING })
      .mockResolvedValueOnce({ ok: true, profile: ANSWERED })

    installBridge(bridge)
    await loadCreatorProfile('acc-1')

    await expect(saveCreatorProfile('acc-1', { contentType: 'vlog' })).resolves.toBe(true)
    expect(bridge).toHaveBeenLastCalledWith({ action: 'save', patch: { contentType: 'vlog' } })
    expect(creatorProfileFor($creatorProfile.get(), 'acc-1')).toEqual(ANSWERED)
  })

  it('a refused or stale save changes nothing', async () => {
    const bridge = vi
      .fn<Bridge>()
      .mockResolvedValueOnce({ ok: true, profile: PENDING })
      .mockResolvedValueOnce({ message: 'INVALID', ok: false, profile: null })

    installBridge(bridge)
    await loadCreatorProfile('acc-1')

    await expect(saveCreatorProfile('acc-1', { contentType: 'vlog' })).resolves.toBe(false)
    expect(creatorProfileFor($creatorProfile.get(), 'acc-1')).toEqual(PENDING)

    // A save for an account that is no longer the cached one is never sent.
    await expect(saveCreatorProfile('acc-2', { contentType: 'vlog' })).resolves.toBe(false)
    expect(bridge).toHaveBeenCalledTimes(2)
  })
})
