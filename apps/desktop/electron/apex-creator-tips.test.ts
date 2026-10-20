/**
 * Tests for electron/apex-creator-tips.ts (hc-995: creator tips under the
 * process status line). The cloud owns the catalog; these pin when it is read
 * at all (the switch), how its reply is read, the known_hash fast path, and
 * that a failed read keeps what the window already had.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { registerApexAccountReads } from './apex-account-reads'
import {
  CREATOR_TIPS_ENV,
  type CreatorTipsCache,
  type CreatorTipsDeps,
  creatorTipsEnvSwitch,
  creatorTipsUrl,
  fetchCreatorTips,
  parseCreatorTips
} from './apex-creator-tips'

const TIP = {
  id: 'hook-first-3s',
  steps: ['media_transcribe'],
  text: { en: 'Lead with the result.', zh: '开头 3 秒决定完播。' }
}

const CATALOG = { schema: 'creator-tips/1', hash: 'abc123', tips: [TIP] }

function deps(
  replies: unknown[],
  overrides: Partial<CreatorTipsDeps> = {}
): CreatorTipsDeps & { calls: { bearer: string; url: string }[]; logs: string[] } {
  const calls: { bearer: string; url: string }[] = []
  const logs: string[] = []

  return {
    accessToken: () => 'jwt-1',
    apiBase: () => 'https://apex-nodes.com/',
    getJson: async (url, opts) => {
      calls.push({ bearer: opts.bearer, url })
      const reply = replies.shift()

      if (reply instanceof Error) {
        throw reply
      }

      return reply
    },
    log: line => {
      logs.push(line)
    },
    ...overrides,
    calls,
    logs
  }
}

const emptyCache = (): CreatorTipsCache => ({ hash: '', tips: [] })

test('creatorTipsUrl targets the public catalog and sends the known hash', () => {
  assert.equal(creatorTipsUrl('https://apex-nodes.com/'), 'https://apex-nodes.com/api/v1/desktop/tips')
  assert.equal(creatorTipsUrl('https://apex-nodes.com', 'a b'), 'https://apex-nodes.com/api/v1/desktop/tips?known_hash=a%20b')
})

test.each([
  [{}, null],
  [{ [CREATOR_TIPS_ENV]: '1' }, true],
  [{ [CREATOR_TIPS_ENV]: ' On ' }, true],
  [{ [CREATOR_TIPS_ENV]: '0' }, false],
  [{ [CREATOR_TIPS_ENV]: 'off' }, false],
  [{ [CREATOR_TIPS_ENV]: 'maybe' }, null]
])('creatorTipsEnvSwitch(%j) → %j', (env, expected) => {
  assert.equal(creatorTipsEnvSwitch(env), expected)
})

test.each([
  [CATALOG, { hash: 'abc123', tips: [TIP] }],
  [{ hash: 'abc123', unchanged: true }, { hash: 'abc123', unchanged: true }],
  // Malformed tips are dropped one by one; text is trimmed.
  [
    {
      hash: 'h',
      tips: [
        { ...TIP, text: { en: ' Lead with the result. ', zh: ' 开头 3 秒决定完播。 ' } },
        { id: 'Bad_Id', steps: ['media_transcribe'], text: TIP.text },
        { id: 'no-steps', steps: [], text: TIP.text },
        { id: 'no-zh', steps: ['social_download'], text: { en: 'x.' } },
        'not a tip'
      ]
    },
    { hash: 'h', tips: [TIP] }
  ],
  [{ hash: 'h', tips: [{ id: 'step-names', steps: ['Media Transcribe', 'social_download'], text: TIP.text }] }, { hash: 'h', tips: [{ id: 'step-names', steps: ['social_download'], text: TIP.text }] }],
  [{ hash: 'h', tips: [TIP, TIP] }, null], // duplicate ids
  [{ hash: 'h', tips: [] }, null],
  [{ tips: [TIP] }, null],
  [{ hash: 'h' }, null],
  [null, null],
  ['nope', null]
])('parseCreatorTips(%j) → %j', (body, expected) => {
  assert.deepEqual(parseCreatorTips(body), expected)
})

test('tips off: no request at all', async () => {
  const shell = deps([CATALOG])

  assert.deepEqual(await fetchCreatorTips(shell, {}, emptyCache(), { platformOn: false }), {
    enabled: false,
    ok: true,
    tips: []
  })
  assert.deepEqual(await fetchCreatorTips(shell, { [CREATOR_TIPS_ENV]: '0' }, emptyCache(), { platformOn: true }), {
    enabled: false,
    ok: true,
    tips: []
  })
  assert.equal(shell.calls.length, 0)
})

test('the platform switch or the install override turns the read on', async () => {
  for (const [env, request] of [
    [{}, { platformOn: true }],
    [{ [CREATOR_TIPS_ENV]: '1' }, { platformOn: false }],
    [{ [CREATOR_TIPS_ENV]: '1' }, undefined]
  ] as const) {
    const shell = deps([CATALOG])
    const result = await fetchCreatorTips(shell, env, emptyCache(), request)

    assert.deepEqual(result, { enabled: true, ok: true, tips: [TIP] })
    assert.deepEqual(shell.calls, [{ bearer: 'jwt-1', url: 'https://apex-nodes.com/api/v1/desktop/tips' }])
  }
})

test('a second read sends the hash and keeps the catalog when it is unchanged', async () => {
  const cache = emptyCache()
  const shell = deps([CATALOG, { hash: 'abc123', unchanged: true }])

  await fetchCreatorTips(shell, {}, cache, { platformOn: true })
  const again = await fetchCreatorTips(shell, {}, cache, { platformOn: true })

  assert.deepEqual(again, { enabled: true, ok: true, tips: [TIP] })
  assert.equal(shell.calls[1].url, 'https://apex-nodes.com/api/v1/desktop/tips?known_hash=abc123')
})

test('a failed or malformed read keeps what this window already had', async () => {
  const cache: CreatorTipsCache = { hash: 'abc123', tips: [TIP] }

  for (const [reply, message] of [
    [Object.assign(new Error('404: not found'), { statusCode: 404 }), 'FETCH_FAILED'],
    [new Error('socket hang up'), 'FETCH_FAILED'],
    [{ hash: '', tips: [] }, 'INVALID']
  ] as const) {
    const shell = deps([reply])
    const result = await fetchCreatorTips(shell, {}, cache, { platformOn: true })

    assert.deepEqual(result, { enabled: true, message, ok: false, tips: [TIP] })
    assert.equal(shell.logs.length, 1)
  }

  assert.deepEqual(cache, { hash: 'abc123', tips: [TIP] })
})

test('signed out: no request, nothing new', async () => {
  const shell = deps([CATALOG], { accessToken: () => '' })

  assert.deepEqual(await fetchCreatorTips(shell, {}, emptyCache(), { platformOn: true }), {
    enabled: true,
    message: 'NOT_SIGNED_IN',
    ok: false,
    tips: []
  })
  assert.equal(shell.calls.length, 0)
})

test('the registrar answers the renderer, and preload exposes the read', async () => {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
  const shell = deps([CATALOG])

  registerApexAccountReads(
    { handle: (channel, listener) => void handlers.set(channel, listener) },
    { ...shell, postJson: async () => ({}) },
    '/tmp/unused-hermes-home'
  )

  assert.deepEqual(await handlers.get('hermes:managed:creatorTips')?.({}, { platformOn: true }), {
    enabled: true,
    ok: true,
    tips: [TIP]
  })

  const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8')

  assert.ok(preload.includes("creatorTips: request => ipcRenderer.invoke('hermes:managed:creatorTips', request),"))
})
