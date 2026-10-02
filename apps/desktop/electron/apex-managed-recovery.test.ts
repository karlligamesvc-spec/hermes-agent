import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { managedModelConfigYaml, reconcileManagedRelayKey } from './apex-managed'
import { ManagedCredentialLifetime, managedProvisionCommitToken, ManagedRelayRecoveryCoordinator, provisionManagedRelayForCurrentAccount } from './apex-managed-recovery'

const directories: string[] = []
const baseUrl = 'https://example.invalid/relay/v1'

function recoveryFixture(overrides: Record<string, unknown> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hc903-recovery-'))
  directories.push(directory)
  const config = path.join(directory, 'config.yaml')

  const original = managedModelConfigYaml({
    provider: 'custom', default: 'fixture-model', api_key: 'fixture-old', base_url: baseUrl,
    custom_providers: [{ name: 'fixture', api_key: 'fixture-old', base_url: baseUrl, model: 'fixture-model' }]
  })

  fs.writeFileSync(config, original)
  const provisionKey = vi.fn(async () => ({ apiKey: 'fixture-fresh' }))
  const applyToBackend = vi.fn(async () => undefined)
  const probeRelay = vi.fn(async () => ({ ok: false, statusCode: 401 }))

  const deps = {
    enabled: true, storedKey: 'fixture-old', baseUrl, hasToken: true,
    readConfig: () => fs.readFileSync(config, 'utf8'),
    writeConfig: (next: string) => fs.writeFileSync(config, next),
    provisionKey, applyToBackend, probeRelay, ...overrides
  }

  return { deps, config, original, provisionKey, applyToBackend, probeRelay }
}

afterEach(() => { for (const directory of directories.splice(0)) {fs.rmSync(directory, { recursive: true, force: true })} })

describe('managed recovery receipts', () => {
  it.each([
    ['missing login token', { hasToken: false }, true, 'no-token'],
    ['cooldown', { lastAttemptAt: 1000, now: 1001 }, false, 'cooldown'],
    ['provision 401', { provisionKey: async () => ({ statusCode: 401 }) }, true, 'login-token-rejected'],
    ['provision 403', { provisionKey: async () => ({ statusCode: 403 }) }, false, 'provision-failed'],
    ['provision 503', { provisionKey: async () => ({ statusCode: 503 }) }, false, 'provision-failed'],
    ['provision offline', { provisionKey: async () => null }, false, 'provision-failed'],
    ['config not managed', { readConfig: () => 'model: byok\n' }, false, 'persist-blocked: no-managed-anchor']
  ])('distinguishes %s from token expiry', async (_label, overrides, needsSignIn, reason) => {
    const fixture = recoveryFixture(overrides)
    const result = await reconcileManagedRelayKey(fixture.deps)

    expect(result).toMatchObject({ relayUnauthorized: true, healed: false, needsSignIn, reason })
    expect(fs.readFileSync(fixture.config, 'utf8')).toBe(fixture.original)
    expect(fixture.applyToBackend).not.toHaveBeenCalled()
  })

  it.each([200, 503, 0])('does not rotate a key or request login after probe %s', async statusCode => {
    const fixture = recoveryFixture({ probeRelay: async () => ({ ok: statusCode === 200, statusCode }) })
    const result = await reconcileManagedRelayKey(fixture.deps)

    expect(result).toMatchObject({ relayUnauthorized: false, needsSignIn: false, probeStatus: statusCode === 200 ? 'ok' : 'unreachable' })
    expect(fixture.provisionKey).not.toHaveBeenCalled()
  })
})

describe('shared native recovery lifetime', () => {
  it('joins boot, catalog and renderer recovery into one mint and backend reload', async () => {
    const releases: (() => void)[] = []

    const fixture = recoveryFixture({ provisionKey: vi.fn(async () => {
      await new Promise<void>(resolve => { releases.push(resolve) })

      return { apiKey: 'fixture-fresh' }
    }) })

    const coordinator = new ManagedRelayRecoveryCoordinator()
    const recover = () => reconcileManagedRelayKey(fixture.deps)
    const boot = coordinator.run(0, recover)
    const catalog = coordinator.run(0, recover)
    const renderer = coordinator.run(0, recover)
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0))

    for (const release of releases) {release()}

    const outcomes = await Promise.all([boot, catalog, renderer])

    expect(fixture.probeRelay).toHaveBeenCalledTimes(1)
    expect(fixture.deps.provisionKey).toHaveBeenCalledTimes(1)
    expect(fixture.applyToBackend).toHaveBeenCalledTimes(1)
    expect(outcomes.every(outcome => outcome.healed && !outcome.needsSignIn)).toBe(true)
    expect(fs.readFileSync(fixture.config, 'utf8')).toContain('fixture-fresh')
  })

  it('discards a late old-owner mint and allows the new owner its own recovery', async () => {
    let generation = 0
    let release!: () => void

    const fixture = recoveryFixture({
      isCurrent: () => generation === 0,
      provisionKey: async () => {
        await new Promise<void>(resolve => { release = resolve })

        return { apiKey: 'fixture-old-owner-mint' }
      }
    })

    const coordinator = new ManagedRelayRecoveryCoordinator()
    const oldOwner = coordinator.run(0, () => reconcileManagedRelayKey(fixture.deps))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    generation = 1

    const newOwner = coordinator.run(1, () => reconcileManagedRelayKey({
      ...fixture.deps, isCurrent: () => generation === 1, probeRelay: async () => ({ ok: true, statusCode: 200 })
    }))

    await expect(newOwner).resolves.toMatchObject({ probeStatus: 'ok', needsSignIn: false })
    release()
    await expect(oldOwner).resolves.toMatchObject({ ok: false, healed: false, needsSignIn: false, reason: 'account-changed' })
    expect(fs.readFileSync(fixture.config, 'utf8')).toBe(fixture.original)
    expect(fixture.applyToBackend).not.toHaveBeenCalled()
  })
})

describe('provision receipt commits', () => {
  const ownerA = '11111111-1111-1111-1111-111111111111'
  const ownerB = '22222222-2222-2222-2222-222222222222'
  const token = (owner: string, version: number) => `fixture.${Buffer.from(JSON.stringify({ sub: owner, version })).toString('base64url')}.fixture`

  it('accepts the same-owner transport renewal and retains its newer JWT when committing the minted key', async () => {
    const lifetime = new ManagedCredentialLifetime()
    const requestToken = token(ownerA, 1)
    const renewedToken = token(ownerA, 2)
    let storedToken = requestToken
    let storedKey = 'fixture-old'
    const generation = lifetime.current()

    const result = await provisionManagedRelayForCurrentAccount({
      isCurrent: () => lifetime.current() === generation,
      request: async () => {
        // Actual transport ordering: persist the authenticated renewal before
        // resolving the provision body to its caller.
        lifetime.persist(() => { storedToken = renewedToken }, true)

        return { apiKey: 'fixture-minted' }
      },
      commit: provisioned => lifetime.persist(() => {
        storedKey = provisioned.apiKey
        storedToken = managedProvisionCommitToken(requestToken, storedToken, 'recovery')
      }),
      unavailable: vi.fn()
    })

    expect(result).toEqual({ ok: true, hasRelayKey: true, credentialGeneration: 1 })
    expect(storedKey).toBe('fixture-minted')
    expect(storedToken).toBe(renewedToken)
  })

  it('explicit same-account sign-in replaces the old JWT rather than treating it as a transport renewal', () => {
    const expiredToken = token(ownerA, 1)
    const freshToken = token(ownerA, 2)

    expect(managedProvisionCommitToken(freshToken, expiredToken, 'sign-in')).toBe(freshToken)
    expect(managedProvisionCommitToken(expiredToken, freshToken, 'recovery')).toBe(freshToken)
  })

  it.each(['login', 'logout'])('does not persist a late provision after a new %s', async action => {
    const lifetime = new ManagedCredentialLifetime()
    const generation = lifetime.current()
    let storedToken = token(ownerA, 1)
    let storedKey = 'fixture-old'
    let release!: () => void
    const commit = vi.fn((provisioned: { apiKey: string }) => lifetime.persist(() => { storedKey = provisioned.apiKey }))

    const pending = provisionManagedRelayForCurrentAccount({
      isCurrent: () => lifetime.current() === generation,
      request: async () => {
        await new Promise<void>(resolve => { release = resolve })

        return { apiKey: 'fixture-late-old-owner' }
      },
      commit,
      unavailable: vi.fn()
    })

    lifetime.persist(() => {
      storedToken = action === 'login' ? token(ownerB, 1) : ''
      storedKey = action === 'login' ? 'fixture-new-owner' : ''
    })
    release()
    await expect(pending).resolves.toMatchObject({ ok: false, hasRelayKey: false })
    expect(commit).not.toHaveBeenCalled()
    expect(storedKey).toBe(action === 'login' ? 'fixture-new-owner' : '')
    expect(storedToken).toBe(action === 'login' ? token(ownerB, 1) : '')
  })

  it('returns the commit generation rather than absorbing a later owner write', async () => {
    const lifetime = new ManagedCredentialLifetime()

    const pending = provisionManagedRelayForCurrentAccount({
      request: async () => ({ apiKey: 'fixture-mint' }),
      isCurrent: () => lifetime.current() === 0,
      commit: () => lifetime.persist(() => undefined),
      unavailable: vi.fn()
    })

    void pending.then(() => lifetime.persist(() => undefined))
    const receipt = await pending

    expect(receipt.credentialGeneration).toBe(1)
    expect(lifetime.current()).toBe(2)
    expect(receipt.credentialGeneration === lifetime.current()).toBe(false)
  })
})
