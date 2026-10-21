/**
 * Tests for electron/apex-memory-ledger.ts (hc-1016 记得你 v1). The cloud owns
 * the ledger; these pin how its reply is read, what each page action sends,
 * that the local agent's prompt copy follows the switch and the signed-in
 * account, and that no entry text reaches a log line.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, test } from 'vitest'

import { syncUserProfilePrompt, userProfilePromptPath } from './apex-creator-profile'
import {
  clearAccountPromptMirrors,
  type MemoryLedgerDeps,
  memoryLedgerPromptPath,
  memoryLedgerRequest,
  memoryLedgerUrl,
  parseMemoryLedger,
  syncMemoryLedgerPrompt
} from './apex-memory-ledger'

const ALICE = '1f0e7b52-7c1d-4c55-9a39-1f1d1f1d1f1d'
const BOB = '2a0e7b52-7c1d-4c55-9a39-2a2a2a2a2a2a'
const ENTRY_ID = '3f2a9c1d-0000-4000-8000-000000000001'
const SECRET_ISH = '只在测试里出现-9c1d'
const SEGMENT = '【APEX 记得的 · 记忆底账】\n关于你：\n- [3f2a9c1d] 不露脸\n【APEX 记得的 · 完】'

function jwtFor(sub: string, nonce = 'a'): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

  return `${part({ alg: 'none' })}.${part({ nonce, sub })}.sig`
}

function wireEntry(overrides: Record<string, unknown> = {}) {
  return {
    content: '不露脸',
    created_at: '2026-10-21T12:00:00+00:00',
    id: ENTRY_ID,
    kind: 'about_you',
    ref: '3f2a9c1d',
    source: 'desktop',
    updated_at: '2026-10-21T12:00:00+00:00',
    ...overrides
  }
}

function reply(overrides: Record<string, unknown> = {}) {
  return {
    entries: { about_you: [wireEntry()], recent: [] },
    limits: { about_you_max: 30, content_max_chars: 100, recent_keep_days: 30, recent_max: 50 },
    prompt_segment: SEGMENT,
    ...overrides
  }
}

interface Call {
  body?: object
  bearer: string
  method: string
  url: string
}

function deps(
  options: { error?: unknown; errors?: unknown[]; onCall?: () => void; reply?: unknown; token?: string } = {}
) {
  const calls: Call[] = []
  const logs: string[] = []
  const errors = [...(options.errors ?? [])]
  let token = options.token ?? jwtFor(ALICE)

  const respond = async (call: Call) => {
    calls.push(call)
    options.onCall?.()
    const error = errors.length ? errors.shift() : options.error

    if (error) {
      throw error
    }

    return options.reply ?? reply()
  }

  const d: MemoryLedgerDeps & { calls: Call[]; logs: string[]; setToken: (next: string) => void } = {
    accessToken: () => token,
    apiBase: () => 'https://apex-nodes.com/',
    calls,
    getJson: (url, opts) => respond({ bearer: opts.bearer, method: 'GET', url }),
    log: line => logs.push(line),
    logs,
    postJson: (url, opts) => respond({ body: opts.body, bearer: opts.bearer, method: opts.method ?? 'POST', url }),
    setToken: next => {
      token = next
    }
  }

  return d
}

function statusError(statusCode: number, body = 'x') {
  return Object.assign(new Error(`${statusCode}: ${body}`), { statusCode })
}

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'apex-memory-ledger-'))
})

afterEach(() => {
  rmSync(home, { force: true, recursive: true })
})

const promptFile = () => memoryLedgerPromptPath(home)
const BASE = 'https://apex-nodes.com/api/v1/account/memory-ledger'

test('the ledger URL targets the account endpoint and escapes the entry id', () => {
  assert.equal(memoryLedgerUrl('https://apex-nodes.com/'), BASE)
  assert.equal(memoryLedgerUrl('https://apex-nodes.com', 'a/b'), `${BASE}/entries/a%2Fb`)
})

test('reads the reply into renderer state, dropping malformed entries', () => {
  const parsed = parseMemoryLedger(
    reply({
      created: true,
      entries: {
        about_you: [wireEntry(), wireEntry({ id: '../x' }), wireEntry({ kind: 'works' }), wireEntry({ content: ' ' })],
        recent: [wireEntry({ content: ' 交付了成片 ', kind: 'recent' })]
      },
      entry: wireEntry()
    })
  )

  assert.deepEqual(parsed?.state.aboutYou, [
    { content: '不露脸', createdAt: '2026-10-21T12:00:00+00:00', id: ENTRY_ID, kind: 'about_you', source: 'desktop' }
  ])
  assert.deepEqual(
    parsed?.state.recent.map(e => e.content),
    ['交付了成片']
  )
  assert.deepEqual(parsed?.state.limits, { aboutYouMax: 30, contentMaxChars: 100, recentKeepDays: 30, recentMax: 50 })
  assert.equal(parsed?.created, true)
  assert.equal(parsed?.entry?.id, ENTRY_ID)
  assert.equal(parsed?.promptSegment, SEGMENT)
})

test.each([null, [], 'x', {}, { entries: [] }, { entries: null }])('a malformed reply reads as nothing (%j)', body => {
  assert.equal(parseMemoryLedger(body), null)
})

test('a read writes the segment for the local agent, owner-only', async () => {
  const result = await memoryLedgerRequest(deps(), home, { action: 'get' })

  assert.equal(result.ok, true)
  assert.equal(result.ledger?.aboutYou.length, 1)
  assert.equal(readFileSync(promptFile(), 'utf8'), `${SEGMENT}\n`)

  if (process.platform !== 'win32') {
    assert.equal(statSync(promptFile()).mode & 0o777, 0o600)
  }
})

test('switched off: the copy goes and nothing is sent', async () => {
  syncMemoryLedgerPrompt(home, SEGMENT, () => {})
  const d = deps()

  assert.deepEqual(await memoryLedgerRequest(d, home, { action: 'off' }), { ledger: null, ok: true })
  assert.equal(existsSync(promptFile()), false)
  assert.deepEqual(d.calls, [])
})

test.each([
  [
    { action: 'add', content: '女声配音', kind: 'about_you' },
    'POST',
    `${BASE}/entries`,
    { content: '女声配音', kind: 'about_you' }
  ],
  [
    { action: 'edit', content: '男声配音', id: ENTRY_ID },
    'PATCH',
    `${BASE}/entries/${ENTRY_ID}`,
    { content: '男声配音' }
  ],
  [{ action: 'remove', id: ENTRY_ID }, 'DELETE', `${BASE}/entries/${ENTRY_ID}`, {}]
])('a page action goes out as %j', async (request, method, url, body) => {
  const d = deps({ reply: reply({ created: true, entry: wireEntry() }) })
  const result = await memoryLedgerRequest(d, home, request as never)

  assert.equal(result.ok, true)
  assert.deepEqual(d.calls, [{ body, bearer: d.accessToken(), method, url }])
  // Every write answers with the ledger as it now stands; the copy follows.
  assert.equal(readFileSync(promptFile(), 'utf8'), `${SEGMENT}\n`)
})

test.each([
  { action: 'add', content: 'x', kind: 'works' },
  { action: 'add', content: 3, kind: 'recent' },
  { action: 'edit', content: 'x', id: '../../admin' },
  { action: 'remove', id: 'abc' },
  { action: 'remove' },
  { action: 'purge' },
  null
])('a malformed request is refused without a call (%j)', async request => {
  const d = deps()

  assert.deepEqual(await memoryLedgerRequest(d, home, request as never), {
    ledger: null,
    message: 'INVALID',
    ok: false
  })
  assert.deepEqual(d.calls, [])
})

test('without a stored JWT nothing is sent', async () => {
  const d = deps({ token: '' })

  assert.deepEqual(await memoryLedgerRequest(d, home, { action: 'get' }), {
    ledger: null,
    message: 'NOT_SIGNED_IN',
    needsSignIn: true,
    ok: false
  })
  assert.deepEqual(d.calls, [])
})

test.each([
  [401, { ledger: null, message: 'SESSION_EXPIRED', needsSignIn: true, ok: false }, true],
  [403, { ledger: null, ok: true }, false],
  [404, { ledger: null, ok: true }, false],
  [500, { ledger: null, message: 'FETCH_FAILED', ok: false }, true]
])('a read answered HTTP %i reads as a known state', async (code, expected, kept) => {
  syncMemoryLedgerPrompt(home, SEGMENT, () => {})
  const d = deps({ error: statusError(code) })

  assert.deepEqual(await memoryLedgerRequest(d, home, { action: 'get' }), expected)
  assert.equal(existsSync(promptFile()), kept)
})

test.each([
  [422, '{"detail":{"code":"sensitive_content"}}', 'sensitive_content'],
  [422, '{"detail":[{"type":"string_too_long"}]}', undefined],
  [409, '{"detail":{"code":"ledger_full","limit":30}}', 'ledger_full']
])('a refused write carries the reason (%i %s)', async (code, body, reason) => {
  const d = deps({ error: statusError(code, body) })
  const result = await memoryLedgerRequest(d, home, { action: 'add', content: 'x', kind: 'about_you' })

  assert.deepEqual(result, { ...(reason ? { code: reason } : {}), ledger: null, message: 'INVALID', ok: false })
})

test('an entry already gone says so and returns the ledger as it stands', async () => {
  const d = deps({ errors: [statusError(404)] })
  const result = await memoryLedgerRequest(d, home, { action: 'remove', id: ENTRY_ID })

  assert.equal(result.message, 'NOT_FOUND')
  assert.equal(result.ok, false)
  assert.equal(result.ledger?.aboutYou.length, 1)
  assert.deepEqual(
    d.calls.map(call => call.method),
    ['DELETE', 'GET']
  )
})

test("a reply that lands after the account changed never reaches the new account's agent", async () => {
  const d = deps({ onCall: () => d.setToken(jwtFor(BOB)) })

  assert.deepEqual(await memoryLedgerRequest(d, home, { action: 'get' }), {
    ledger: null,
    message: 'FETCH_FAILED',
    ok: false
  })
  assert.equal(existsSync(promptFile()), false)
})

test('entry text never reaches a log line', async () => {
  const d = deps({ error: statusError(500, `{"detail":"${SECRET_ISH}"}`) })

  await memoryLedgerRequest(d, home, { action: 'add', content: SECRET_ISH, kind: 'recent' })
  await memoryLedgerRequest(deps({ reply: { entries: 'x' } }), home, {
    action: 'edit',
    content: SECRET_ISH,
    id: ENTRY_ID
  })
  assert.equal(d.logs.length, 1)
  assert.ok(!d.logs.join('\n').includes(SECRET_ISH))
})

test('an oversized segment is not written, and account changes clear both account copies', () => {
  syncMemoryLedgerPrompt(home, 'x'.repeat(4001), () => {})
  assert.equal(existsSync(promptFile()), false)

  syncMemoryLedgerPrompt(home, SEGMENT, () => {})
  syncUserProfilePrompt(home, '【用户画像】', () => {})
  clearAccountPromptMirrors(home)
  assert.equal(existsSync(promptFile()), false)
  assert.equal(existsSync(userProfilePromptPath(home)), false)
})

test('the copy sits where the apex-overlay seam reads it', () => {
  assert.equal(promptFile(), join(home, 'apex', 'memory-ledger-prompt.md'))
  const seam = readFileSync(join(__dirname, '..', '..', '..', 'apex_overlay', 'memory_ledger.py'), 'utf8')

  assert.ok(seam.includes('PROMPT_RELATIVE_PATH = ("apex", "memory-ledger-prompt.md")'))
})
