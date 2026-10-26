import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ManagedProvisionError, requestRevisionedManagedKeyMutation } from './desktop-managed-provision'

// The rejection apexAuthPostJson builds for any HTTP status >= 400 (main.ts).
const httpError = (statusCode: number, body: string) =>
  Object.assign(new Error(`${statusCode}: ${body}`), { statusCode })

// Byte-for-byte what apex-nodes app/routers/desktop.py answers when the account's
// Desktop anchor already holds 8 active device keys and this install is new.
const LIMIT_BODY = JSON.stringify({
  detail: {
    code: 'desktop_device_key_limit_reached',
    message: 'Too many active Desktop installations. Sign out on another device before adding this one.'
  }
})

const SUPERSEDED_BODY = JSON.stringify({ detail: { code: 'desktop_provision_superseded' } })

async function refusal(step: 'capabilities' | 'issue', error: Error) {
  const calls = { rollback: 0, unknown: 0 }

  const failure = await requestRevisionedManagedKeyMutation({
    capabilities: async () => {
      if (step === 'capabilities') {
        throw error
      }

      return { version: 1 }
    },
    nextRevision: () => 1,
    issue: async () => {
      throw error
    },
    isCurrent: () => true,
    beginMutation: () => () => {
      calls.rollback++
    },
    recordUnknownMutation: () => {
      calls.unknown++
    }
  }).then(
    () => null,
    (caught: unknown) => caught
  )

  expect(failure).toBeInstanceOf(ManagedProvisionError)
  const { code, message, serverCode, statusCode } = failure as ManagedProvisionError

  return { code, message, serverCode, statusCode, ...calls }
}

describe('provision-key refusal marker', () => {
  it.each([
    [
      'the device limit',
      httpError(409, LIMIT_BODY),
      'MANAGED_DEVICE_LIMIT_REACHED',
      'desktop_device_key_limit_reached'
    ],
    [
      'a superseded intent on the same 409',
      httpError(409, SUPERSEDED_BODY),
      'MANAGED_PROVISION_UNAVAILABLE',
      'desktop_provision_superseded'
    ],
    [
      'the limit code outside detail',
      httpError(409, '{"code":"desktop_device_key_limit_reached"}'),
      'MANAGED_PROVISION_UNAVAILABLE',
      undefined
    ],
    ['a string detail', httpError(401, '{"detail":"Not authenticated"}'), 'MANAGED_PROVISION_UNAVAILABLE', undefined],
    ['a non-string code', httpError(409, '{"detail":{"code":409}}'), 'MANAGED_PROVISION_UNAVAILABLE', undefined],
    [
      'an Object.prototype key as code',
      httpError(409, '{"detail":{"code":"constructor"}}'),
      'MANAGED_PROVISION_UNAVAILABLE',
      'constructor'
    ],
    ['an empty 409 body', httpError(409, ''), 'MANAGED_PROVISION_UNAVAILABLE', undefined],
    ['a proxy HTML page', httpError(502, '<html>Bad Gateway</html>'), 'MANAGED_PROVISION_UNAVAILABLE', undefined],
    [
      'limit text on an error with no HTTP status',
      new Error(`409: ${LIMIT_BODY}`),
      'MANAGED_PROVISION_UNAVAILABLE',
      undefined
    ]
  ])('issue refused with %s', async (_case, error, code, serverCode) => {
    const outcome = await refusal('issue', error)

    expect(outcome).toMatchObject({ code, message: code, serverCode })
    expect(outcome.statusCode).toBe((error as { statusCode?: number }).statusCode)
  })

  it('a device-limit 409 is a refusal before mutation: rollback, no pending credential recovery', async () => {
    expect(await refusal('issue', httpError(409, LIMIT_BODY))).toMatchObject({ rollback: 1, unknown: 0 })
  })

  it('the capability preflight carries the server code the same way', async () => {
    expect(await refusal('capabilities', httpError(409, LIMIT_BODY))).toMatchObject({
      code: 'MANAGED_DEVICE_LIMIT_REACHED',
      serverCode: 'desktop_device_key_limit_reached',
      rollback: 0,
      unknown: 0
    })
  })

  it('Native forwards the marker to the renderer unchanged (main.ts cannot be imported in tests)', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')
    const post = main.slice(main.indexOf('function apexAuthPostJson('), main.indexOf('function apexAuthBodylessJson('))

    const provision = main.slice(
      main.indexOf('async function provisionManagedFromAccessToken'),
      main.indexOf('\n/**\n * Sign in to ApexNodes')
    )

    const payload = main.slice(
      main.indexOf('function managedSignInResultPayload('),
      main.indexOf('function managedSignInErrorMessage(')
    )

    // The parser above reads `${status}: ${body}`; a reworded rejection would silently drop every code.
    expect(post).toContain("const err: any = new Error(`${statusCode}: ${text || ''}`)")
    // hc-1073: the status passes through cloudLogin unchanged (apex-cloud-login.test.ts pins that).
    expect(post).toContain('err.statusCode = cloudLogin.noteFailure(bearer, statusCode)')
    expect(provision).toContain(
      "return { ...result, ok: false, message: provisionFailure.code || 'MANAGED_PROVISION_UNAVAILABLE' }"
    )
    expect(payload).toContain("message: result.message || 'MODEL_RUNTIME_UNAVAILABLE'")
  })
})
