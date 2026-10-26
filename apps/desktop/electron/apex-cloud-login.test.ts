/**
 * Tests for electron/apex-cloud-login.ts (hc-1073). The login JWT died on one
 * account while the relay key lived: chat kept working and skills stayed on a
 * two-week-old version with nothing on screen. These pin which answers count
 * as "the login is gone" (only a 401 to the stored JWT), which never do
 * (network, 5xx, other bearers, a replaced token), how it clears, and that
 * every JWT transport in main.ts reports through the tracker.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test } from 'vitest'

import { CLOUD_LOGIN_CHANNEL, type CloudLoginState, createCloudLoginHealth, registerCloudLoginHealth } from './apex-cloud-login'

const JWT = 'jwt.stored.one'
const NEW_JWT = 'jwt.after.sign-in'
const AT = 1_761_500_000_000

function harness(token = JWT) {
  const sent: CloudLoginState[] = []
  const closedSent: CloudLoginState[] = []
  const logs: string[] = []
  let current = token

  const health = createCloudLoginHealth({
    currentToken: () => current,
    log: message => logs.push(message),
    now: () => AT,
    windows: () => [
      { isDestroyed: () => false, webContents: { send: (channel, state) => sent.push({ ...state, channel } as never) } },
      { isDestroyed: () => true, webContents: { send: (_channel, state) => closedSent.push(state) } }
    ]
  })

  return {
    closedSent,
    health,
    logs,
    sent,
    signIn: (next: string) => {
      current = next
    }
  }
}

test('a 401 to the stored JWT raises the card once, in every open window', () => {
  const h = harness()

  assert.equal(h.health.noteFailure(JWT, 401), 401)
  assert.equal(h.health.noteFailure(JWT, 401), 401)

  assert.deepEqual(h.health.snapshot(), { rejected: true, since: AT })
  assert.deepEqual(h.sent, [{ channel: CLOUD_LOGIN_CHANNEL, rejected: true, since: AT }])
  assert.deepEqual(h.closedSent, [])
  assert.equal(h.logs.length, 1)
})

test.each([400, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504])(
  'HTTP %i says nothing about the login: no card, status passed through',
  statusCode => {
    const h = harness()

    assert.equal(h.health.noteFailure(JWT, statusCode), statusCode)
    assert.deepEqual(h.health.snapshot(), { rejected: false, since: null })
    assert.deepEqual(h.sent, [])
  }
)

test.each([
  ['the relay key', 'sk-relay-key'],
  ['the daemon token', 'daemon-token'],
  ['a JWT the user has since replaced', 'jwt.old'],
  ['no bearer', ''],
  ['an undefined bearer', undefined]
])('a 401 to %s is not the login going away', (_label, bearer) => {
  const h = harness()

  h.health.noteFailure(bearer, 401)

  assert.equal(h.health.snapshot().rejected, false)
  assert.deepEqual(h.sent, [])
})

test('with no stored JWT (signed out, env-key install) nothing counts', () => {
  const h = harness('')

  h.health.noteFailure('', 401)
  h.health.noteFailure(undefined, 401)

  assert.equal(h.health.snapshot().rejected, false)
  assert.deepEqual(h.sent, [])
})

test('a 2xx to the stored JWT clears the card and says so; other bearers do not', () => {
  const h = harness()
  h.health.noteFailure(JWT, 401)

  h.health.noteSuccess('sk-relay-key')
  assert.equal(h.health.snapshot().rejected, true)

  h.health.noteSuccess(JWT)
  assert.deepEqual(h.health.snapshot(), { rejected: false, since: null })
  assert.deepEqual(
    h.sent.map(state => state.rejected),
    [true, false]
  )
})

test('a 2xx with nothing rejected pushes nothing', () => {
  const h = harness()

  h.health.noteSuccess(JWT)

  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.logs, [])
})

test('signing in again clears it at once; a late 401 for the old JWT does not bring it back', () => {
  const h = harness()
  h.health.noteFailure(JWT, 401)

  h.signIn(NEW_JWT)
  assert.equal(h.health.snapshot().rejected, false)

  h.health.noteFailure(JWT, 401)
  assert.equal(h.health.snapshot().rejected, false)

  // main re-pulls skills and plugins after the sign-in; their 2xx tells every window.
  h.health.noteSuccess(NEW_JWT)
  assert.deepEqual(
    h.sent.map(state => state.rejected),
    [true, false]
  )

  // The new JWT can be rejected in its turn.
  h.health.noteFailure(NEW_JWT, 401)
  assert.equal(h.health.snapshot().rejected, true)
})

test('the renderer reads the current state over hermes:managed:cloudLogin', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  const health = registerCloudLoginHealth(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    { currentToken: () => JWT, now: () => AT, windows: () => [] }
  )

  assert.deepEqual(await handlers.get('hermes:managed:cloudLogin')?.({}), { rejected: false, since: null })
  health.noteFailure(JWT, 401)
  assert.deepEqual(await handlers.get('hermes:managed:cloudLogin')?.({}), { rejected: true, since: AT })
})

// ── main.ts / preload wiring ────────────────────────────────────────────────

const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')
const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8')

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function functionBody(name: string): string {
  const start = main.indexOf(`\nfunction ${name}(`)
  assert.notEqual(start, -1, `main.ts no longer defines ${name}`)

  return stripComments(main.slice(start, main.indexOf('\n}\n', start)))
}

// Every transport that sends `Authorization: Bearer ${bearer}` carries the login
// JWT for some caller (and other bearers for others). Counted, so a new one fails
// here until it reports to cloudLogin too.
const JWT_TRANSPORTS = ['analysisUploadFile', 'apexAuthBodylessJson', 'apexAuthGetBuffer', 'apexAuthPostJson']

test('main.ts has exactly the counted Bearer transports', () => {
  const found = [...main.matchAll(/\nfunction (\w+)\([^\n]*\n(?:(?!\nfunction )[\s\S])*?setHeader\('Authorization', `Bearer \$\{bearer\}`\)/g)]
    .map(match => match[1])
    .sort()

  assert.deepEqual(found, JWT_TRANSPORTS)
})

test.each(JWT_TRANSPORTS)('%s reports its HTTP errors and its 2xx to cloudLogin', name => {
  const body = functionBody(name)
  const failures = body.match(/\.statusCode = cloudLogin\.noteFailure\(bearer, (?:statusCode|response\.statusCode)\)/g) ?? []

  assert.equal(failures.length, 1, `${name}: its >=400 branch must set statusCode through cloudLogin.noteFailure`)
  assert.equal(body.match(/persistRenewedLoginToken\([^\n]*, bearer\)/g)?.length, 1, `${name}: its 2xx path must reach persistRenewedLoginToken`)
  // A network error has no HTTP status and must never reach the tracker.
  const onError = body.slice(body.indexOf("request.on('error'"))
  assert.equal(onError.includes('cloudLogin'), false, `${name}: the network-error path must not report to cloudLogin`)
})

test('every authed 2xx tells cloudLogin the stored JWT works', () => {
  const body = functionBody('persistRenewedLoginToken')

  assert.match(body, /\{\n\s+try \{\n\s+cloudLogin\.noteSuccess\(requestBearer\)\n/)
  assert.ok(
    main.includes(
      "const cloudLogin = registerCloudLoginHealth(ipcMain, { currentToken: () => String(resolveManagedConfig().accessToken || '').trim(),"
    )
  )
})

test('preload exposes the read and the push on the channel main sends', () => {
  assert.ok(preload.includes("cloudLogin: () => ipcRenderer.invoke('hermes:managed:cloudLogin'),"))
  assert.ok(preload.includes(`ipcRenderer.on('${CLOUD_LOGIN_CHANNEL}', listener)`))
  assert.ok(preload.includes(`return () => ipcRenderer.removeListener('${CLOUD_LOGIN_CHANNEL}', listener)`))
})
