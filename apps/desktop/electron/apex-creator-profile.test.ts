/**
 * Tests for electron/apex-creator-profile.ts (hc-991 first-use creator intake).
 * The cloud owns the three answers; these pin how its reply is read, how a
 * card or settings edit goes out, how the local agent's prompt copy follows
 * the signed-in account, and that every failure leaves the Start page usable.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, test } from 'vitest'

import { registerApexAccountReads } from './apex-account-reads'
import {
  clearUserProfilePrompt,
  type CreatorProfileDeps,
  creatorProfileRequest,
  creatorProfileUrl,
  parseCreatorProfile,
  syncUserProfilePrompt,
  toWirePatch,
  userProfilePromptPath
} from './apex-creator-profile'

const ALICE = '1f0e7b52-7c1d-4c55-9a39-1f1d1f1d1f1d'
const BOB = '2a0e7b52-7c1d-4c55-9a39-2a2a2a2a2a2a'
const SEGMENT = '【用户画像 · 平台维护】\n- 主要做的内容：好物测评\n【用户画像结束】'

function jwtFor(sub: string, nonce = 'a'): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')

  return `${part({ alg: 'none' })}.${part({ nonce, sub })}.sig`
}

function reply(overrides: Record<string, unknown> = {}) {
  return {
    answers: {
      content_type: 'product_review',
      content_type_other: null,
      pain_point: 'no_script',
      platforms: ['xiaohongshu', 'douyin']
    },
    intake: { completed: false, next_step: 'pain_point', skipped: [] },
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

function deps(options: { error?: unknown; reply?: unknown; token?: string; onCall?: () => void } = {}) {
  const calls: Call[] = []
  const logs: string[] = []
  let token = options.token ?? jwtFor(ALICE)

  const respond = async (call: Call) => {
    calls.push(call)
    options.onCall?.()

    if (options.error) {
      throw options.error
    }

    return options.reply ?? reply()
  }

  const d: CreatorProfileDeps & { calls: Call[]; logs: string[]; setToken: (next: string) => void } = {
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

function statusError(statusCode: number) {
  return Object.assign(new Error(`${statusCode}: x`), { statusCode })
}

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'apex-creator-profile-'))
})

afterEach(() => {
  rmSync(home, { force: true, recursive: true })
})

const promptFile = () => userProfilePromptPath(home)

test('the profile URL targets the cloud account endpoint and trims a trailing slash', () => {
  assert.equal(creatorProfileUrl('https://apex-nodes.com/'), 'https://apex-nodes.com/api/v1/account/creator-profile')
  assert.equal(
    creatorProfileUrl('https://api.apex-nodes.com'),
    'https://api.apex-nodes.com/api/v1/account/creator-profile'
  )
})

test.each([
  [
    reply(),
    {
      answers: {
        contentType: 'product_review',
        contentTypeOther: null,
        painPoint: 'no_script',
        platforms: ['douyin', 'xiaohongshu']
      },
      intake: { completed: false, nextStep: 'pain_point', skipped: [] }
    }
  ],
  [
    reply({
      answers: {
        content_type: 'other',
        content_type_other: ' 宠物日常 ',
        pain_point: 'lazy',
        platforms: ['weibo', 'bilibili']
      },
      intake: { completed: true, next_step: 'platforms', skipped: ['platforms', 'mood'] }
    }),
    {
      answers: { contentType: 'other', contentTypeOther: '宠物日常', painPoint: null, platforms: ['bilibili'] },
      intake: { completed: true, nextStep: null, skipped: ['platforms'] }
    }
  ],
  [
    reply({ answers: { content_type: 'other', content_type_other: '  ', platforms: 'douyin' } }),
    {
      answers: { contentType: null, contentTypeOther: null, painPoint: null, platforms: [] },
      intake: { completed: false, nextStep: 'pain_point', skipped: [] }
    }
  ]
])('reads the reply into renderer state, dropping anything unknown (%#)', (body, expected) => {
  assert.deepEqual(parseCreatorProfile(body)?.state, expected)
})

test.each([null, [], 'x', {}, { answers: {} }, { intake: {} }, { answers: null, intake: {} }])(
  'a malformed reply reads as nothing (%j)',
  body => {
    assert.equal(parseCreatorProfile(body), null)
  }
)

test.each([
  [{ contentType: 'vlog' }, { content_type: 'vlog' }],
  [
    { contentType: 'other', contentTypeOther: ' 宠物日常 ' },
    { content_type: 'other', content_type_other: '宠物日常' }
  ],
  [{ contentType: null }, { content_type: null }],
  [{ platforms: ['douyin', 'bilibili'] }, { platforms: ['douyin', 'bilibili'] }],
  [{ platforms: null }, { platforms: [] }],
  [{ painPoint: null }, { pain_point: null }],
  [{ skip: ['platforms'] }, { skip: ['platforms'] }],
  [{ skip: [] }, {}],
  [{}, {}]
])('a patch goes out in the cloud field names, absent keys absent (%j)', (patch, wire) => {
  assert.deepEqual(toWirePatch(patch as never), wire)
})

test('a read writes the segment for the local agent, and an empty one removes it', async () => {
  const result = await creatorProfileRequest(deps(), home, { action: 'get' })

  assert.equal(result.ok, true)
  assert.equal(result.profile?.intake.nextStep, 'pain_point')
  assert.equal(readFileSync(promptFile(), 'utf8'), `${SEGMENT}\n`)

  if (process.platform !== 'win32') {
    assert.equal(statSync(promptFile()).mode & 0o777, 0o600)
  }

  await creatorProfileRequest(deps({ reply: reply({ prompt_segment: null }) }), home, { action: 'get' })
  assert.equal(existsSync(promptFile()), false)
})

test('a card answer is a PUT of the patch with the stored login JWT', async () => {
  const d = deps()
  const result = await creatorProfileRequest(d, home, { action: 'save', patch: { platforms: ['douyin'], skip: [] } })

  assert.equal(result.ok, true)
  assert.deepEqual(d.calls, [
    {
      body: { platforms: ['douyin'] },
      bearer: d.accessToken(),
      method: 'PUT',
      url: 'https://apex-nodes.com/api/v1/account/creator-profile'
    }
  ])
})

test('without a stored JWT nothing is sent and the file is left alone', async () => {
  writeFileSync(join(home, 'keep'), '')
  const d = deps({ token: '' })

  assert.deepEqual(await creatorProfileRequest(d, home, { action: 'get' }), {
    message: 'NOT_SIGNED_IN',
    needsSignIn: true,
    ok: false,
    profile: null
  })
  assert.deepEqual(d.calls, [])
})

test.each([
  [401, { message: 'SESSION_EXPIRED', needsSignIn: true, ok: false, profile: null }, true],
  [403, { ok: true, profile: null }, false],
  [404, { ok: true, profile: null }, false],
  [422, { message: 'INVALID', ok: false, profile: null }, true],
  [500, { message: 'FETCH_FAILED', ok: false, profile: null }, true]
])(
  'HTTP %i reads as a known state and only an account without the intake drops the copy',
  async (code, expected, kept) => {
    syncUserProfilePrompt(home, SEGMENT, () => {})
    const d = deps({ error: statusError(code) })

    assert.deepEqual(await creatorProfileRequest(d, home, { action: 'get' }), expected)
    assert.equal(existsSync(promptFile()), kept)
    assert.equal(d.logs.length, code === 500 ? 1 : 0)
  }
)

test('an unreadable reply changes nothing locally', async () => {
  syncUserProfilePrompt(home, SEGMENT, () => {})
  const d = deps({ reply: { answers: 'x' } })

  assert.deepEqual(await creatorProfileRequest(d, home, { action: 'get' }), {
    message: 'FETCH_FAILED',
    ok: false,
    profile: null
  })
  assert.equal(readFileSync(promptFile(), 'utf8'), `${SEGMENT}\n`)
})

test("a reply that lands after the account changed never reaches the new account's agent", async () => {
  const d = deps({ onCall: () => d.setToken(jwtFor(BOB)) })

  assert.deepEqual(await creatorProfileRequest(d, home, { action: 'get' }), {
    message: 'FETCH_FAILED',
    ok: false,
    profile: null
  })
  assert.equal(existsSync(promptFile()), false)
})

test('a renewed token for the same account still writes the copy', async () => {
  const d = deps({ onCall: () => d.setToken(jwtFor(ALICE, 'renewed')) })

  assert.equal((await creatorProfileRequest(d, home, { action: 'get' })).ok, true)
  assert.equal(existsSync(promptFile()), true)
})

test('an oversized segment is not written (the runtime would drop it anyway)', () => {
  syncUserProfilePrompt(home, 'x'.repeat(4001), () => {})
  assert.equal(existsSync(promptFile()), false)
  syncUserProfilePrompt(home, SEGMENT, () => {})
  clearUserProfilePrompt(home)
  assert.equal(existsSync(promptFile()), false)
})

test('the registrar wires every account read, and main clears the copy on every account change', () => {
  const channels: string[] = []
  registerApexAccountReads({ handle: channel => void channels.push(channel) }, deps(), home)
  assert.deepEqual(channels, [
    'hermes:announcements:list',
    'hermes:announcements:markRead',
    'hermes:managed:team',
    'hermes:managed:creatorProfile',
    'hermes:managed:creatorTips'
  ])

  const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')
  const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8')

  assert.ok(
    preload.includes("creatorProfile: request => ipcRenderer.invoke('hermes:managed:creatorProfile', request),")
  )
  assert.ok(main.includes('registerApexAccountReads(ipcMain, apexAccountReads, HERMES_HOME)'))
  // Sign-out (the credential clear) and a different account signing in (writeManagedConfig).
  const signOut = main.slice(main.indexOf('function clearManagedRelayCredential()'))
  assert.ok(signOut.slice(0, signOut.indexOf('\n}\n')).includes('clearUserProfilePrompt(HERMES_HOME)'))
  assert.ok(
    main.includes(
      '  if (Boolean(previous.key) !== Boolean(key) || managedAccountId(previous.accessToken) !== managedAccountId(accessToken)) {\n' +
        '    clearUserProfilePrompt(HERMES_HOME)\n'
    )
  )
  assert.equal(main.split('clearUserProfilePrompt(HERMES_HOME)').length - 1, 2)
})
