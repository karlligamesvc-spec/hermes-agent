/**
 * Tests for electron/apex-plan-usage.ts (hc-1061 / hc-1062: the single-thread
 * sidebar's account row reads the plan and its usage from the cloud). The cloud
 * is the authority; these pin how its answer is read and how every failure
 * reads as "no usage line".
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { fetchPlanUsage, parsePlanUsage, planUsageUrl } from './apex-plan-usage'
import type { AccountReadDeps } from './apex-team'

const OK_BODY = {
  period: 'month',
  period_key: '2026-10',
  plan: { code: 'fast', name: '快速' },
  quota_tokens: 10_000_000,
  resets_at: '2026-10-31T16:00:00+00:00',
  unlimited: false,
  used_ratio: 0.18,
  used_tokens: 1_800_000
}

function deps(
  overrides: Partial<AccountReadDeps> = {}
): AccountReadDeps & { calls: { bearer: string; url: string }[]; logs: string[] } {
  const calls: { bearer: string; url: string }[] = []
  const logs: string[] = []

  return {
    accessToken: () => 'jwt-1',
    apiBase: () => 'https://apex-nodes.com/',
    getJson: async (url, opts) => {
      calls.push({ bearer: opts.bearer, url })

      return OK_BODY
    },
    log: line => {
      logs.push(line)
    },
    ...overrides,
    calls,
    logs
  }
}

function failingWith(statusCode: number | undefined, message = 'boom') {
  return async () => {
    throw Object.assign(new Error(message), statusCode === undefined ? {} : { statusCode })
  }
}

test('planUsageUrl targets the cloud plan-usage endpoint and trims a trailing slash', () => {
  assert.equal(planUsageUrl('https://apex-nodes.com/'), 'https://apex-nodes.com/api/v1/account/plan-usage')
  assert.equal(planUsageUrl('https://api.apex-nodes.com'), 'https://api.apex-nodes.com/api/v1/account/plan-usage')
})

test.each([
  [OK_BODY, { period: 'month', planName: '快速', usedRatio: 0.18 }],
  [
    { ...OK_BODY, plan: { code: 'fast', name: '  快速 ' } },
    { period: 'month', planName: '快速', usedRatio: 0.18 }
  ],
  [
    { ...OK_BODY, used_ratio: 1.25 },
    { period: 'month', planName: '快速', usedRatio: 1.25 }
  ],
  [
    { ...OK_BODY, quota_tokens: null, unlimited: true, used_ratio: null },
    { period: 'month', planName: '快速', usedRatio: null }
  ],
  [
    { ...OK_BODY, period: 'week' },
    { period: 'week', planName: '快速', usedRatio: 0.18 }
  ],
  // Anything the row cannot say truthfully is no line at all.
  [{ ...OK_BODY, period: 'day' }, null],
  [{ ...OK_BODY, period: undefined }, null],
  [{ ...OK_BODY, used_ratio: null }, null],
  [{ ...OK_BODY, used_ratio: -0.1 }, null],
  [{ ...OK_BODY, used_ratio: '18%' }, null],
  [{ ...OK_BODY, plan: { code: 'fast', name: '' } }, null],
  [{ ...OK_BODY, plan: null }, null],
  [['x'], null],
  [null, null],
  ['nope', null]
])('parsePlanUsage(%j) → %j', (body, expected) => {
  assert.deepEqual(parsePlanUsage(body), expected)
})

test('reads with the stored JWT, never anything else', async () => {
  const d = deps()

  assert.deepEqual(await fetchPlanUsage(d), { ok: true, usage: { period: 'month', planName: '快速', usedRatio: 0.18 } })
  assert.deepEqual(d.calls, [{ bearer: 'jwt-1', url: 'https://apex-nodes.com/api/v1/account/plan-usage' }])
})

test('no JWT: asks for sign-in without a request', async () => {
  const d = deps({ accessToken: () => '  ' })

  assert.deepEqual(await fetchPlanUsage(d), { message: 'NOT_SIGNED_IN', needsSignIn: true, ok: false, usage: null })
  assert.equal(d.calls.length, 0)
})

test.each([
  [401, { message: 'SESSION_EXPIRED', needsSignIn: true, ok: false, usage: null }, 0],
  [403, { ok: true, usage: null }, 0],
  [404, { ok: true, usage: null }, 0],
  [500, { message: 'FETCH_FAILED', ok: false, usage: null }, 1],
  [undefined, { message: 'FETCH_FAILED', ok: false, usage: null }, 1]
])('HTTP %s reads as no usage line', async (statusCode, expected, logLines) => {
  const d = deps({ getJson: failingWith(statusCode, 'secret-jwt-should-not-appear?') })

  assert.deepEqual(await fetchPlanUsage(d), expected)
  assert.equal(d.logs.length, logLines)
})

test('main relays it through the shared account-read registrar, and preload exposes it under managed', () => {
  const reads = readFileSync(join(__dirname, 'apex-account-reads.ts'), 'utf8')
  const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8')

  assert.match(reads, /ipcMain\.handle\('hermes:managed:planUsage', async \(\) => fetchPlanUsage\(reads\)\)/)
  assert.match(preload, /planUsage: \(\) => ipcRenderer\.invoke\('hermes:managed:planUsage'\)/)
})
