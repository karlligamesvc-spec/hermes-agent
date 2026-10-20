import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopDailyIdeaCard, DesktopDailyIdeasPage, DesktopDailyIdeasRequest, DesktopDailyIdeasResult } from '@/global'

import { $dailyIdeas, dailyIdeasFor, dislikeDailyIdea, loadDailyIdeas, markDailyIdeaStarted, resetDailyIdeasForTest } from './daily-ideas'

function idea(id: string): DesktopDailyIdeaCard {
  return {
    hook: '',
    how: '一镜到底',
    id,
    kind: 'structure',
    lowEdit: false,
    noFace: false,
    source: { label: 'APEX 常用选题库', observedAt: null, url: null },
    started: false,
    startPrompt: `用今天的点子开工：「${id}」。`,
    title: id,
    why: '常用结构'
  }
}

function page(ids: string[], number = 0): DesktopDailyIdeasPage {
  return { cards: ids.map(idea), day: '2026-10-21', more: false, page: number, pending: false, profile: { complete: true, summary: 'Vlog' } }
}

function ok(result: DesktopDailyIdeasPage): DesktopDailyIdeasResult {
  return { enabled: true, ok: true, page: result }
}

type Read = (request: DesktopDailyIdeasRequest) => Promise<DesktopDailyIdeasResult>

function install(read: Read | undefined, flag = true) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    clientConfig: { get: async () => ({ payload: { desktop_features: { daily_ideas: flag } } }) },
    managed: read ? { dailyIdeas: vi.fn(read) } : {}
  }
}

/** A reply the test releases when it wants. */
function held<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => (release = resolve))

  return { promise, release }
}

describe('今日点子 store (hc-995)', () => {
  beforeEach(() => resetDailyIdeasForTest())
  afterEach(() => {
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
  })

  it('passes the platform switch to main and holds the page for its account only', async () => {
    const read = vi.fn<Read>(async () => ok(page(['a', 'b', 'c'])))
    install(read)

    expect(await loadDailyIdeas('acc-1')).toBe(true)
    expect(read).toHaveBeenCalledExactlyOnceWith({ action: 'get', page: 0, platformOn: true })
    expect(dailyIdeasFor($dailyIdeas.get(), 'acc-1')?.cards.map(card => card.id)).toEqual(['a', 'b', 'c'])
    expect(dailyIdeasFor($dailyIdeas.get(), 'acc-2')).toBeNull()
  })

  it('a reply for an account that is no longer signed in is dropped', async () => {
    const first = held<DesktopDailyIdeasResult>()
    let calls = 0
    install(() => (++calls === 1 ? first.promise : Promise.resolve(ok(page(['x'])))))

    const stale = loadDailyIdeas('acc-1')
    await loadDailyIdeas('acc-2')
    first.release(ok(page(['a', 'b', 'c'])))

    expect(await stale).toBe(false)
    expect($dailyIdeas.get().accountId).toBe('acc-2')
    expect($dailyIdeas.get().page?.cards.map(card => card.id)).toEqual(['x'])
  })

  it('a reply that arrives after sign-out does not refill the store', async () => {
    const first = held<DesktopDailyIdeasResult>()
    install(() => first.promise)

    const late = loadDailyIdeas('acc-1')
    await loadDailyIdeas(null)
    first.release(ok(page(['a'])))

    expect(await late).toBe(false)
    expect($dailyIdeas.get()).toEqual({ accountId: null, page: null, status: 'idle' })
  })

  it('a failed first read shows nothing; a failed later read keeps the cards on screen', async () => {
    let fail = true
    install(async () => (fail ? { enabled: true, message: 'FETCH_FAILED', ok: false, page: null } : ok(page(['a']))))

    expect(await loadDailyIdeas('acc-1')).toBe(false)
    expect($dailyIdeas.get().status).toBe('hidden')

    fail = false
    await loadDailyIdeas('acc-1')
    fail = true
    expect(await loadDailyIdeas('acc-1', 1)).toBe(false)
    expect($dailyIdeas.get()).toMatchObject({ status: 'ready', page: { cards: [{ id: 'a' }] } })
  })

  it('switched off in the cloud hides cards already shown', async () => {
    let enabled = true
    install(async () => (enabled ? ok(page(['a'])) : { enabled: false, ok: true, page: null }))

    await loadDailyIdeas('acc-1')
    enabled = false
    await loadDailyIdeas('acc-1', 1)

    expect($dailyIdeas.get().status).toBe('hidden')
  })

  it('an older main process without the bridge shows nothing', async () => {
    install(undefined)

    expect(await loadDailyIdeas('acc-1')).toBe(false)
    expect($dailyIdeas.get().status).toBe('hidden')
  })

  it('after 不喜欢 a read that left before it cannot bring the card back', async () => {
    const before = held<DesktopDailyIdeasResult>()
    const gone = new Set<string>()
    let reads = 0

    install(async request => {
      if (request.action === 'feedback') {
        gone.add(request.ideaId)

        return { enabled: true, ok: true, page: null }
      }

      reads += 1

      return reads === 2 ? before.promise : ok(page(['a', 'b', 'c', 'd'].filter(id => !gone.has(id)).slice(0, 3)))
    })

    await loadDailyIdeas('acc-1')
    const stale = loadDailyIdeas('acc-1') // e.g. the pending refresh, still in flight
    expect(await dislikeDailyIdea('acc-1', idea('b'), 'too_hard')).toBe(true)
    before.release(ok(page(['a', 'b', 'c'])))
    await stale

    expect($dailyIdeas.get().page?.cards.map(card => card.id)).toEqual(['a', 'c', 'd'])
  })

  it('开做 marks the card at once and tells the cloud', async () => {
    const read = vi.fn<Read>(async request => (request.action === 'get' ? ok(page(['a', 'b'])) : { enabled: true, ok: true, page: null }))
    install(read)
    await loadDailyIdeas('acc-1')

    markDailyIdeaStarted('acc-1', idea('b'))

    expect($dailyIdeas.get().page?.cards.map(card => card.started)).toEqual([false, true])
    await vi.waitFor(() =>
      expect(read).toHaveBeenLastCalledWith({ action: 'feedback', ideaId: 'b', kind: 'start', platformOn: true, reason: undefined })
    )
  })
})
