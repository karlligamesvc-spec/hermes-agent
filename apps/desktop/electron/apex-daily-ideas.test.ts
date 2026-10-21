/**
 * Tests for electron/apex-daily-ideas.ts (hc-995 今日点子 on the Start page). The
 * cloud picks and words the cards; these pin when it is asked at all (the
 * switch), how its reply is read (bad cards dropped, only web links kept), what
 * 开做 / 不喜欢 send, and how each failure reads to the renderer.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { registerApexAccountReads } from './apex-account-reads'
import {
  DAILY_IDEAS_ENV,
  type DailyIdeasDeps,
  dailyIdeasEnvSwitch,
  dailyIdeasRequest,
  dailyIdeasUrl,
  parseDailyIdeas
} from './apex-daily-ideas'

const CARD = {
  id: 'vlog:douyin:2026-10-21:0',
  kind: 'hot',
  title: '换季收纳：5 样东西',
  how: '前后对比，一镜到底',
  hook: '先看之前。',
  why: '今天抖音热点词榜上有「换季收纳」',
  source: { label: '抖音热点词榜', observed_at: '2026-10-21T06:00:00+08:00', url: 'https://www.douyin.com/hot/1' },
  no_face: true,
  low_edit: false,
  started: false,
  start_prompt: '用今天的点子开工：「换季收纳：5 样东西」。'
}

const PAGE = {
  enabled: true,
  day: '2026-10-21',
  bucket: 'vlog:douyin',
  profile: { summary: 'Vlog · 抖音', complete: true },
  cards: [CARD],
  pending: false,
  page: 0,
  more: true
}

const PARSED_CARD = {
  hook: '先看之前。',
  how: '前后对比，一镜到底',
  id: 'vlog:douyin:2026-10-21:0',
  kind: 'hot',
  lowEdit: false,
  noFace: true,
  source: { label: '抖音热点词榜', observedAt: '2026-10-21T06:00:00+08:00', url: 'https://www.douyin.com/hot/1' },
  started: false,
  startPrompt: '用今天的点子开工：「换季收纳：5 样东西」。',
  title: '换季收纳：5 样东西',
  why: '今天抖音热点词榜上有「换季收纳」'
}

type Call = { body?: object; bearer: string; method: 'GET' | 'POST'; url: string }

function deps(
  replies: unknown[],
  overrides: Partial<DailyIdeasDeps> = {}
): DailyIdeasDeps & { calls: Call[]; logs: string[] } {
  const calls: Call[] = []
  const logs: string[] = []

  const next = async () => {
    const reply = replies.shift()

    if (reply instanceof Error) {
      throw reply
    }

    return reply
  }

  return {
    accessToken: () => 'jwt-1',
    apiBase: () => 'https://apex.example/',
    calls,
    getJson: async (url, { bearer }) => {
      calls.push({ bearer, method: 'GET', url })

      return next()
    },
    log: line => void logs.push(line),
    logs,
    postJson: async (url, { bearer, body }) => {
      calls.push({ body, bearer, method: 'POST', url })

      return next()
    },
    ...overrides
  }
}

function httpError(status: number): Error {
  return Object.assign(new Error(`${status}: refused`), { statusCode: status })
}

test('the switch: off sends nothing; the platform or the install turns it on; the install wins', async () => {
  assert.equal(dailyIdeasEnvSwitch({ [DAILY_IDEAS_ENV]: 'on' }), true)
  assert.equal(dailyIdeasEnvSwitch({ [DAILY_IDEAS_ENV]: '0' }), false)
  assert.equal(dailyIdeasEnvSwitch({}), null)

  const off = deps([PAGE])
  assert.deepEqual(await dailyIdeasRequest(off, {}, { action: 'get', platformOn: false }), { enabled: false, ok: true, page: null })
  assert.deepEqual(await dailyIdeasRequest(off, { [DAILY_IDEAS_ENV]: '0' }, { action: 'get', platformOn: true }), {
    enabled: false,
    ok: true,
    page: null
  })
  assert.equal(off.calls.length, 0)

  const tester = deps([PAGE])
  const result = await dailyIdeasRequest(tester, { [DAILY_IDEAS_ENV]: '1' }, { action: 'get', platformOn: false })
  assert.equal(result.ok, true)
  assert.deepEqual(tester.calls, [{ bearer: 'jwt-1', method: 'GET', url: 'https://apex.example/api/v1/account/daily-ideas?page=0' }])
})

test('a page is read as the renderer shows it', async () => {
  const shell = deps([PAGE])

  assert.deepEqual(await dailyIdeasRequest(shell, {}, { action: 'get', page: 2, platformOn: true }), {
    enabled: true,
    ok: true,
    page: { cards: [PARSED_CARD], day: '2026-10-21', more: true, page: 0, pending: false, profile: { complete: true, summary: 'Vlog · 抖音' } }
  })
  assert.equal(shell.calls[0].url, dailyIdeasUrl('https://apex.example/', 2))
})

test('page numbers are clamped to what the cloud accepts', async () => {
  for (const [asked, sent] of [
    [-3, 0],
    [2.7, 2],
    [99, 20],
    [Number.NaN, 0]
  ] as const) {
    const shell = deps([PAGE])
    await dailyIdeasRequest(shell, {}, { action: 'get', page: asked, platformOn: true })
    assert.ok(shell.calls[0].url.endsWith(`?page=${sent}`), `${asked} → ${shell.calls[0].url}`)
  }
})

test('cards that do not parse are dropped one by one; only web links survive', () => {
  const parsed = parseDailyIdeas({
    ...PAGE,
    cards: [
      CARD,
      { ...CARD, id: 'dup' },
      { ...CARD, id: 'dup', title: '同一个 id 第二次' },
      { ...CARD, id: 'x', kind: 'trending' },
      { ...CARD, id: 'y', start_prompt: '' },
      { ...CARD, id: 'z', title: '   ' },
      { ...CARD, id: 'a'.repeat(65) },
      { ...CARD, id: 'js', source: { label: '来源', url: 'javascript:alert(1)' } },
      'not a card'
    ]
  })

  assert.ok(parsed && parsed !== 'disabled')
  assert.deepEqual(
    parsed.cards.map(card => card.id),
    ['vlog:douyin:2026-10-21:0', 'dup', 'js']
  )
  assert.equal(parsed.cards[1].title, '换季收纳：5 样东西')
  assert.equal(parsed.cards[2].source.url, null)
  assert.equal(parseDailyIdeas({ enabled: false, day: '2026-10-21', cards: [] }), 'disabled')
  assert.equal(parseDailyIdeas({ enabled: true }), null)
  assert.equal(parseDailyIdeas([PAGE]), null)
})

test('the cloud saying off hides the section, like an installer-only account or an old cloud', async () => {
  for (const reply of [{ enabled: false, day: '2026-10-21', cards: [] }, httpError(403), httpError(404)]) {
    assert.deepEqual(await dailyIdeasRequest(deps([reply]), {}, { action: 'get', platformOn: true }), {
      enabled: false,
      ok: true,
      page: null
    })
  }
})

test('failures say what happened and never throw', async () => {
  const cases: [unknown, object][] = [
    [httpError(401), { enabled: true, message: 'SESSION_EXPIRED', needsSignIn: true, ok: false, page: null }],
    [httpError(500), { enabled: true, message: 'FETCH_FAILED', ok: false, page: null }],
    [new Error('socket hang up'), { enabled: true, message: 'FETCH_FAILED', ok: false, page: null }],
    [{ enabled: true, cards: 'nope' }, { enabled: true, message: 'INVALID', ok: false, page: null }]
  ]

  for (const [reply, expected] of cases) {
    const shell = deps([reply])
    assert.deepEqual(await dailyIdeasRequest(shell, {}, { action: 'get', platformOn: true }), expected)
  }

  const signedOut = deps([PAGE], { accessToken: () => '' })
  assert.deepEqual(await dailyIdeasRequest(signedOut, {}, { action: 'get', platformOn: true }), {
    enabled: true,
    message: 'NOT_SIGNED_IN',
    needsSignIn: true,
    ok: false,
    page: null
  })
  assert.equal(signedOut.calls.length, 0)
})

test('开做 and 不喜欢 send exactly what the cloud accepts', async () => {
  const shell = deps([{ enabled: true, ok: true }, { enabled: true, ok: true }, { enabled: true, ok: true }])
  const feedbackUrl = 'https://apex.example/api/v1/account/daily-ideas/feedback'

  assert.deepEqual(await dailyIdeasRequest(shell, {}, { action: 'feedback', ideaId: 'ev:ge-day', kind: 'start', platformOn: true }), {
    enabled: true,
    ok: true,
    page: null
  })
  await dailyIdeasRequest(shell, {}, { action: 'feedback', ideaId: 'ev:ge-day', kind: 'dislike', platformOn: true, reason: 'too_hard' })
  await dailyIdeasRequest(shell, {}, {
    action: 'feedback',
    ideaId: 'ev:ge-day',
    kind: 'dislike',
    platformOn: true,
    reason: 'boring' as never
  })

  assert.deepEqual(shell.calls, [
    { body: { action: 'start', idea_id: 'ev:ge-day' }, bearer: 'jwt-1', method: 'POST', url: feedbackUrl },
    { body: { action: 'dislike', idea_id: 'ev:ge-day', reason: 'too_hard' }, bearer: 'jwt-1', method: 'POST', url: feedbackUrl },
    { body: { action: 'dislike', idea_id: 'ev:ge-day' }, bearer: 'jwt-1', method: 'POST', url: feedbackUrl }
  ])

  const bad = deps([])
  assert.deepEqual(await dailyIdeasRequest(bad, {}, { action: 'feedback', ideaId: ' ', kind: 'start', platformOn: true }), {
    enabled: true,
    message: 'INVALID',
    ok: false,
    page: null
  })
  assert.equal(bad.calls.length, 0)

  const refused = deps([httpError(422)])
  assert.equal(
    (await dailyIdeasRequest(refused, {}, { action: 'feedback', ideaId: 'x', kind: 'start', platformOn: true })).ok,
    false
  )
})

test('the registrar answers the renderer, and preload exposes the call', async () => {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()

  registerApexAccountReads(
    { handle: (channel, listener) => void handlers.set(channel, listener) },
    deps([PAGE]),
    '/tmp/unused-hermes-home'
  )

  const previous = process.env[DAILY_IDEAS_ENV]
  delete process.env[DAILY_IDEAS_ENV]

  try {
    const result = (await handlers.get('hermes:managed:dailyIdeas')?.({}, { action: 'get', platformOn: true })) as {
      page: { cards: unknown[] }
    }

    assert.deepEqual(result.page.cards, [PARSED_CARD])
  } finally {
    if (previous !== undefined) {
      process.env[DAILY_IDEAS_ENV] = previous
    }
  }

  const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8')
  const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')

  assert.ok(preload.includes("dailyIdeas: request => ipcRenderer.invoke('hermes:managed:dailyIdeas', request),"))
  assert.equal(main.split("'hermes:managed:dailyIdeas'").length - 1, 0)
})
