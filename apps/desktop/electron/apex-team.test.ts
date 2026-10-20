/**
 * Tests for electron/apex-team.ts (hc-971: the account menu shows the light
 * team the signed-in account belongs to). The cloud is the authority; these
 * pin how its answer is read and how every failure reads as "no team".
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { type AccountReadDeps, fetchMyTeam, parseTeamOverview, teamMeUrl } from './apex-team'

function deps(overrides: Partial<AccountReadDeps> = {}): AccountReadDeps & { calls: { bearer: string; url: string }[]; logs: string[] } {
  const calls: { bearer: string; url: string }[] = []
  const logs: string[] = []

  return {
    accessToken: () => 'jwt-1',
    apiBase: () => 'https://apex-nodes.com/',
    getJson: async (url, opts) => {
      calls.push({ bearer: opts.bearer, url })

      return { team: { is_admin: false, name: '星河传媒', status: 'active' } }
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

test('teamMeUrl targets the cloud team endpoint and trims a trailing slash', () => {
  assert.equal(teamMeUrl('https://apex-nodes.com/'), 'https://apex-nodes.com/api/v1/teams/me')
  assert.equal(teamMeUrl('https://api.apex-nodes.com'), 'https://api.apex-nodes.com/api/v1/teams/me')
})

test.each([
  [{ team: { is_admin: true, name: '  星河传媒 ', status: 'active' } }, { isAdmin: true, name: '星河传媒', status: 'active' }],
  [{ team: { name: 'Studio', status: 'pending' } }, { isAdmin: false, name: 'Studio', status: 'pending' }],
  [{ team: { is_admin: 'yes', name: 'Studio', status: 'active' } }, { isAdmin: false, name: 'Studio', status: 'active' }],
  [{ team: null }, null],
  [{ team: { name: 'Gone', status: 'closed' } }, null],
  [{ team: { name: '   ', status: 'active' } }, null],
  [{ team: { status: 'active' } }, null],
  [{ team: ['x'] }, null],
  [null, null],
  ['nope', null]
])('parseTeamOverview(%j) → %j', (body, expected) => {
  assert.deepEqual(parseTeamOverview(body), expected)
})

test('reads the team with the stored login JWT', async () => {
  const d = deps()

  assert.deepEqual(await fetchMyTeam(d), { ok: true, team: { isAdmin: false, name: '星河传媒', status: 'active' } })
  assert.deepEqual(d.calls, [{ bearer: 'jwt-1', url: 'https://apex-nodes.com/api/v1/teams/me' }])
})

test('no stored JWT asks for sign-in without calling the cloud', async () => {
  const d = deps({ accessToken: () => '  ' })

  assert.deepEqual(await fetchMyTeam(d), { message: 'NOT_SIGNED_IN', needsSignIn: true, ok: false, team: null })
  assert.equal(d.calls.length, 0)
})

test.each([
  [401, { message: 'SESSION_EXPIRED', needsSignIn: true, ok: false, team: null }],
  // An installer-only account cannot be on a team; a cloud from before teams has no endpoint.
  [403, { ok: true, team: null }],
  [404, { ok: true, team: null }],
  [500, { message: 'FETCH_FAILED', ok: false, team: null }],
  [undefined, { message: 'FETCH_FAILED', ok: false, team: null }]
])('a %s from the cloud shows no team and never throws', async (statusCode, expected) => {
  const d = deps({ getJson: failingWith(statusCode as number | undefined) })

  assert.deepEqual(await fetchMyTeam(d), expected)
  assert.equal(d.logs.length, (expected as { message?: string }).message === 'FETCH_FAILED' ? 1 : 0)
})

test('the shell exposes this read to the renderer and to nothing else', () => {
  const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')
  const registrar = readFileSync(join(__dirname, 'apex-account-reads.ts'), 'utf8')
  const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8')

  // The handler sits with the other JWT-relayed account reads; main lends them the token.
  assert.ok(registrar.includes("ipcMain.handle('hermes:managed:team', async () => fetchMyTeam(reads))"))
  assert.ok(main.includes('registerApexAccountReads(ipcMain, apexAccountReads, HERMES_HOME)'))
  assert.ok(main.includes("accessToken: () => String(resolveManagedConfig().accessToken || '').trim(),"))
  assert.ok(preload.includes("team: () => ipcRenderer.invoke('hermes:managed:team'),"))
  assert.equal(main.split("'hermes:managed:team'").length - 1, 0)
  assert.equal(registrar.split("'hermes:managed:team'").length - 1, 1)
})
