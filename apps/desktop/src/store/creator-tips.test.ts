import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopCreatorTip } from '@/global'
import { $creatorTipsDay, $creatorTipsSeen, type CreatorTipsDay } from '@/store/creator-tips-ledger'
import { $spentTipCount, $tipsEnabled, resetTips } from '@/store/tips'

import {
  $creatorTipByTurn,
  $creatorTipsCatalog,
  chooseCreatorTip,
  claimCreatorTip,
  creatorTipsOnInClientConfig,
  dismissCreatorTip,
  loadCreatorTips,
  localDay,
  resetCreatorTipsForTest
} from './creator-tips'

// hc-995: which creator tip a turn shows, and how this device keeps count.

const tip = (id: string, steps: string[]): DesktopCreatorTip => ({ id, steps, text: { en: `${id}.`, zh: `${id}。` } })

const CATALOG = [
  tip('download-a', ['social_download']),
  tip('download-b', ['social_download']),
  tip('transcribe-a', ['media_transcribe']),
  tip('transcribe-b', ['media_transcribe']),
  tip('transcribe-c', ['media_transcribe'])
]

const MORNING = new Date(2026, 9, 20, 10, 0, 0)
const LATE = new Date(2026, 9, 20, 23, 59, 0)
const NEXT_DAY = new Date(2026, 9, 21, 0, 1, 0)
const NONE: CreatorTipsDay = { count: 0, day: '' }

beforeEach(() => {
  resetCreatorTipsForTest()
  resetTips()
  $tipsEnabled.set(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chooseCreatorTip', () => {
  it.each([
    [['social_download', 'media_transcribe'], [], NONE, 'transcribe-a'],
    [['social_download', 'media_transcribe'], ['transcribe-a', 'transcribe-b', 'transcribe-c'], NONE, 'download-a'],
    [['social_download', 'media_transcribe', 'social_download'], [], NONE, 'download-a'],
    [['web_search'], [], NONE, null],
    [[], [], NONE, null],
    [['media_transcribe'], [], { count: 3, day: '2026-10-20' }, null],
    [['media_transcribe'], [], { count: 3, day: '2026-10-19' }, 'transcribe-a'],
    [['media_transcribe'], [], { count: 2, day: '2026-10-20' }, 'transcribe-a']
  ])('steps %j, seen %j, ledger %j → %s', (steps, seen, ledger, expected) => {
    expect(chooseCreatorTip(CATALOG, steps, seen, ledger, '2026-10-20')?.id ?? null).toBe(expected)
  })
})

describe('claimCreatorTip', () => {
  it('gives a turn one tip, keeps it there, and spends it on this device', () => {
    $creatorTipsCatalog.set(CATALOG)

    expect(claimCreatorTip('turn-1', ['media_transcribe'], MORNING)?.id).toBe('transcribe-a')
    expect(claimCreatorTip('turn-1', ['social_download'], MORNING)?.id).toBe('transcribe-a')
    expect(claimCreatorTip('turn-2', ['media_transcribe'], MORNING)?.id).toBe('transcribe-b')
    expect($creatorTipsSeen.get()).toEqual(['transcribe-a', 'transcribe-b'])
    expect($creatorTipsDay.get()).toEqual({ count: 2, day: '2026-10-20' })
  })

  it('stops at three a day and starts again the next day', () => {
    $creatorTipsCatalog.set(CATALOG)

    for (const turn of ['t1', 't2', 't3']) {
      expect(claimCreatorTip(turn, ['social_download', 'media_transcribe'], MORNING)).not.toBeNull()
    }

    expect(claimCreatorTip('t4', ['social_download', 'media_transcribe'], LATE)).toBeNull()
    expect(claimCreatorTip('t4', ['social_download', 'media_transcribe'], NEXT_DAY)?.id).toBe('download-a')
    expect($creatorTipsDay.get()).toEqual({ count: 1, day: '2026-10-21' })
  })

  it('claims nothing with tips off, no catalog or no turn', () => {
    $creatorTipsCatalog.set(CATALOG)
    $tipsEnabled.set(false)
    expect(claimCreatorTip('turn-1', ['media_transcribe'], MORNING)).toBeNull()

    $tipsEnabled.set(true)
    expect(claimCreatorTip('', ['media_transcribe'], MORNING)).toBeNull()

    $creatorTipsCatalog.set([])
    expect(claimCreatorTip('turn-1', ['media_transcribe'], MORNING)).toBeNull()
    expect($creatorTipsSeen.get()).toEqual([])
  })

  it('a closed tip stays closed in its turn and stays spent', () => {
    $creatorTipsCatalog.set(CATALOG)
    claimCreatorTip('turn-1', ['media_transcribe'], MORNING)
    dismissCreatorTip('turn-1')

    expect(claimCreatorTip('turn-1', ['media_transcribe'], MORNING)).toBeNull()
    expect($creatorTipByTurn.get()['turn-1']).toEqual({ dismissed: true, tipId: 'transcribe-a' })
    expect(claimCreatorTip('turn-2', ['media_transcribe'], MORNING)?.id).toBe('transcribe-b')
  })

  it('Settings › Reset brings creator tips back and counts them', () => {
    $creatorTipsCatalog.set(CATALOG)
    claimCreatorTip('turn-1', ['media_transcribe'], MORNING)
    claimCreatorTip('turn-2', ['media_transcribe'], MORNING)
    expect($spentTipCount.get()).toBe(2)

    resetTips()

    expect($creatorTipsSeen.get()).toEqual([])
    expect($creatorTipsDay.get()).toEqual(NONE)
    expect($spentTipCount.get()).toBe(0)
  })
})

describe('localDay', () => {
  it('is the local calendar day', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})

describe('creatorTipsOnInClientConfig', () => {
  it.each([
    [{ desktop_features: { creator_tips: true } }, true],
    [{ desktop_features: { creator_tips: 'true' } }, false],
    [{ desktop_features: { model_tiers: true } }, false],
    [{ desktop_features: [] }, false],
    [{}, false],
    [null, false],
    ['x', false]
  ])('%j → %s', (payload, expected) => {
    expect(creatorTipsOnInClientConfig(payload)).toBe(expected)
  })
})

describe('loadCreatorTips', () => {
  function stubShell(read: (request: { platformOn: boolean }) => Promise<unknown>, payload: unknown = {}) {
    const calls: { platformOn: boolean }[] = []

    vi.stubGlobal('hermesDesktop', {
      clientConfig: { get: async () => ({ appliedVersion: 1, payload, version: 1 }) },
      managed: {
        creatorTips: async (request: { platformOn: boolean }) => {
          calls.push(request)

          return read(request)
        }
      }
    })

    return calls
  }

  it('passes the platform switch, keeps the catalog, and reads once per window', async () => {
    const calls = stubShell(async () => ({ enabled: true, ok: true, tips: CATALOG }), {
      desktop_features: { creator_tips: true }
    })

    await loadCreatorTips()
    await loadCreatorTips()

    expect(calls).toEqual([{ platformOn: true }])
    expect($creatorTipsCatalog.get()).toEqual(CATALOG)
  })

  it('tips off: no catalog, and no second read', async () => {
    const calls = stubShell(async () => ({ enabled: false, ok: true, tips: [] }))

    await loadCreatorTips()
    await loadCreatorTips()

    expect(calls).toEqual([{ platformOn: false }])
    expect($creatorTipsCatalog.get()).toEqual([])
  })

  it('a failed read is tried again by a later turn, not straight away', async () => {
    const calls = stubShell(async () => ({ enabled: true, message: 'FETCH_FAILED', ok: false, tips: [] }), {
      desktop_features: { creator_tips: true }
    })

    await loadCreatorTips(1_000)
    await loadCreatorTips(1_000 + 60_000)
    await loadCreatorTips(1_000 + 5 * 60_000)

    expect(calls).toHaveLength(2)
    expect($creatorTipsCatalog.get()).toEqual([])
  })

  it('an older shell without the bridge reads nothing', async () => {
    vi.stubGlobal('hermesDesktop', { managed: {} })

    await loadCreatorTips()

    expect($creatorTipsCatalog.get()).toEqual([])
  })
})
