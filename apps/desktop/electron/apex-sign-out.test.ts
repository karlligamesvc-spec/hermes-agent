// hc-1114: after 「退出登录」 no copy of the relay key stays on this computer.
// M7 found two `api_key` lines left in config.yaml on two test copies; the
// engine's own config backups, older backups beside config.yaml, every profile
// and a legacy runtime's .env hold copies too.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import yaml from 'js-yaml'
import { afterEach, describe, test } from 'vitest'

import { managedModelConfigYaml } from './apex-managed'
import { MANAGED_PROVIDER_NAME } from './apex-relay-key-anchors'
import {
  cleanUpAfterSignOut,
  relayKeyHomes,
  relayKeyLeftIn,
  revokePreviousAccountKey,
  scrubRelayKeyFromHomes,
  scrubRelayKeyText,
  sweepSignedOutRelayKeys
} from './apex-sign-out'

const RELAY = 'https://apex-nodes.com/relay/v1'
const MODEL = 'deepseek-flash-APEX'
const KEY = 'sk-SignedOutKey0000000000000000000'
const ROTATED = 'sk-RotatedEarlier00000000000000000'
const BYOK = 'sk-users-own-deepseek-key-000000'
const TARGET = { baseUrls: [RELAY], key: KEY }

/** The first-run seed (managedModelConfigYaml): model + custom_providers[0], both on `key`. */
const seeded = (key: string) =>
  managedModelConfigYaml({
    default: MODEL,
    provider: 'custom',
    base_url: RELAY,
    api_key: key,
    custom_providers: [{ name: MANAGED_PROVIDER_NAME, base_url: RELAY, api_key: key, model: MODEL }]
  })

/** A PyYAML re-dump: sorted keys, so a list item starts with `- api_key:`. */
const redumped = (key: string) =>
  `model:\n  api_key: ${key}\n  base_url: ${RELAY}\n  provider: custom\n` +
  `custom_providers:\n- api_key: ${key}\n  base_url: ${RELAY}\n  name: ${MANAGED_PROVIDER_NAME}\n`

/** The v12 `providers:` dict plus the user's own DeepSeek key, which is not ours to touch. */
const keyedWithByok = (key: string) =>
  `model:\n  default: ${MODEL}\n  provider: custom\n  base_url: ${RELAY}\n  api_key: "${key}"\n` +
  'providers:\n' +
  `  apex-nodes-com:\n    api: "${RELAY}"\n    name: "${MANAGED_PROVIDER_NAME}"\n    api_key: "${key}"\n` +
  `  deepseek:\n    api: https://api.deepseek.com/v1\n    api_key: "${BYOK}"\n`

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc1114-'))
  tempRoots.push(root)

  return root
}

function put(root: string, relative: string, text: string) {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** Every file under `root` holding `needle`: a walk that knows nothing about which files the scrub visits. */
function filesHolding(root: string, needle: string): string[] {
  const found: string[] = []

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        walk(full)
      } else if (fs.readFileSync(full, 'utf8').includes(needle)) {
        found.push(path.relative(root, full))
      }
    }
  }

  walk(root)

  return found.sort()
}

describe('one file', () => {
  test.each([
    ['the first-run seed', seeded],
    ['a PyYAML re-dump', redumped],
    ['the providers dict', keyedWithByok]
  ])('%s: every anchor holds "" afterwards and the YAML keeps its shape', (_name, render) => {
    const before = render(KEY)
    const after = scrubRelayKeyText(before, TARGET, true)
    const parsed = yaml.load(after) as any

    assert.equal(after.includes(KEY), false)
    assert.deepEqual(relayKeyLeftIn(after, TARGET, true), [])
    assert.equal(parsed.model.api_key, '')
    assert.equal(parsed.model.base_url, RELAY, 'only the key goes; the next sign-in fills the same anchor')
    assert.equal(after.split('\n').length, before.split('\n').length, 'no line removed')
  })

  test("the user's own provider key stays", () => {
    const after = scrubRelayKeyText(keyedWithByok(KEY), TARGET, true)

    assert.equal((yaml.load(after) as any).providers.deepseek.api_key, BYOK)
  })

  test('an older, rotated key in a relay anchor goes too, though the scrub was never told it', () => {
    const after = scrubRelayKeyText(seeded(ROTATED), TARGET, true)

    assert.equal(after.includes(ROTATED), false)
    assert.deepEqual(relayKeyLeftIn(after, { baseUrls: [RELAY] }, true), [])
  })

  test('CRLF files come back CRLF', () => {
    const after = scrubRelayKeyText(seeded(KEY).replace(/\n/g, '\r\n'), TARGET, true)

    assert.equal(after.includes(KEY), false)
    assert.equal(after.replace(/\r\n/g, '').includes('\n'), false)
  })

  test('.env: the key is blanked, every other line is left as it was', () => {
    const env = `DEEPSEEK_API_KEY=${BYOK}\nHERMES_CUSTOM_APEX_DESKTOP_MANAGED_API_KEY=${KEY}\nOTHER=1\n`

    assert.equal(
      scrubRelayKeyText(env, TARGET, false),
      `DEEPSEEK_API_KEY=${BYOK}\nHERMES_CUSTOM_APEX_DESKTOP_MANAGED_API_KEY=\nOTHER=1\n`
    )
  })

  test('the judge sees what the writer does not: an unregistered map on the relay holding a key', () => {
    const raw = seeded(KEY) + `auxiliary:\n  vision:\n    base_url: ${RELAY}\n    api_key: "${ROTATED}"\n`
    const after = scrubRelayKeyText(raw, { baseUrls: [RELAY] }, true)

    assert.deepEqual(relayKeyLeftIn(after, { baseUrls: [RELAY] }, true), ['auxiliary.vision'])
  })
})

describe('every home', () => {
  function signedInTree(root: string) {
    put(root, 'config.yaml', seeded(KEY))
    put(root, 'backups/config/config.yaml.good.20261029-101500', seeded(KEY))
    put(root, 'backups/config/config.yaml.good.20261028-091200', redumped(ROTATED))
    put(root, 'config.yaml.bak.1', seeded(ROTATED))
    put(root, '.env', `DEEPSEEK_API_KEY=${BYOK}\n`)
    put(root, 'profiles/apex-bot-2/SOUL.md', '# 剪辑助手\n')
    put(root, 'profiles/apex-bot-2/config.yaml', seeded(KEY))
    put(root, 'profiles/apex-bot-2/backups/config/config.yaml.good.20261029-101501', seeded(KEY))
    put(root, 'profiles/apex-bot-2/.env', `HERMES_CUSTOM_APEX_DESKTOP_MANAGED_API_KEY=${KEY}\n`)
    // A clone that never finished: no SOUL.md, hidden, still a copy of the root.
    put(root, 'profiles/.apex-bot-3.staging-4242/config.yaml', seeded(KEY))
    put(root, 'logs/desktop.log', 'nothing secret\n')
  }

  test('no file anywhere under the root holds the key or the rotated one afterwards', () => {
    const root = tempRoot()
    signedInTree(root)

    const report = scrubRelayKeyFromHomes(root, TARGET)

    assert.deepEqual(filesHolding(root, KEY), [])
    assert.deepEqual(filesHolding(root, ROTATED), [])
    assert.deepEqual(report.failed, [])
    assert.deepEqual(report.scrubbed.sort(), [
      'backups/config/config.yaml.good.20261028-091200',
      'backups/config/config.yaml.good.20261029-101500',
      'config.yaml',
      'config.yaml.bak.1',
      'profiles/.apex-bot-3.staging-4242/config.yaml',
      'profiles/apex-bot-2/.env',
      'profiles/apex-bot-2/backups/config/config.yaml.good.20261029-101501',
      'profiles/apex-bot-2/config.yaml'
    ])
    assert.equal(
      fs.readFileSync(path.join(root, '.env'), 'utf8'),
      `DEEPSEEK_API_KEY=${BYOK}\n`,
      'untouched: it held no key'
    )
  })

  test('homes are the root and every directory under profiles/', () => {
    const root = tempRoot()
    signedInTree(root)
    put(root, 'profiles/stray-file', '')

    assert.deepEqual(relayKeyHomes(root), [
      root,
      path.join(root, 'profiles', '.apex-bot-3.staging-4242'),
      path.join(root, 'profiles', 'apex-bot-2')
    ])
  })

  test('a file it cannot write is named, without the key', () => {
    const root = tempRoot()
    signedInTree(root)
    const locked = path.join(root, 'profiles/apex-bot-2/config.yaml')
    fs.chmodSync(locked, 0o444)

    try {
      const report = scrubRelayKeyFromHomes(root, TARGET)

      assert.deepEqual(report.failed, ['profiles/apex-bot-2/config.yaml (unwritable: EACCES)'])
      assert.equal(JSON.stringify(report).includes(KEY), false)
      assert.deepEqual(filesHolding(root, KEY), ['profiles/apex-bot-2/config.yaml'])
    } finally {
      fs.chmodSync(locked, 0o644)
    }
  })
})

describe('after a sign-out the server confirmed', () => {
  test('scrubs the stored endpoint and the default, restarts the holders, and reports no key', () => {
    const root = tempRoot()
    const custom = 'https://staging.apex-nodes.com/relay/v1'
    put(
      root,
      'config.yaml',
      managedModelConfigYaml({ default: MODEL, provider: 'custom', base_url: custom, api_key: KEY })
    )
    put(root, 'backups/config/config.yaml.good.20261001-000000', seeded(ROTATED))
    const restarts: string[] = []

    const detail = cleanUpAfterSignOut({
      root,
      managed: { baseUrl: custom, key: KEY },
      defaultRelayBaseUrl: RELAY,
      restartHolders: reason => restarts.push(reason)
    })

    assert.deepEqual(filesHolding(root, KEY), [])
    assert.deepEqual(filesHolding(root, ROTATED), [])
    assert.deepEqual(restarts, ['sign-out'])
    assert.equal(detail, 'relay key removed from 2 local file(s); engines still on it restart once idle')
  })
})

describe('the boot while nobody is signed in', () => {
  test('takes out a key an earlier sign-out left, and says so once', () => {
    const root = tempRoot()
    put(root, 'config.yaml', seeded(KEY))
    put(root, 'profiles/apex-bot-2/SOUL.md', '#\n')
    put(root, 'profiles/apex-bot-2/config.yaml', redumped(KEY))
    const log: string[] = []

    sweepSignedOutRelayKeys({
      root,
      managedEnabled: true,
      key: '',
      credentialStored: false,
      baseUrls: [RELAY],
      log: line => log.push(line)
    })

    assert.deepEqual(filesHolding(root, KEY), [])
    assert.deepEqual(log, [
      '[managed] signed out: relay key removed from 2 local file(s) (left by an earlier sign-out)'
    ])

    sweepSignedOutRelayKeys({
      root,
      managedEnabled: true,
      key: '',
      credentialStored: false,
      baseUrls: [RELAY],
      log: line => log.push(line)
    })
    assert.equal(log.length, 1, 'nothing left: no second line')
  })

  test.each([
    ['an env key', { managedEnabled: true, key: KEY, credentialStored: false }],
    ['a stored credential that did not decrypt', { managedEnabled: true, key: '', credentialStored: true }],
    ['a build with managed off', { managedEnabled: false, key: '', credentialStored: false }]
  ])('%s: never touches a byte', (_name, state) => {
    const root = tempRoot()
    put(root, 'config.yaml', seeded(KEY))

    sweepSignedOutRelayKeys({ root, ...state, baseUrls: [RELAY], log: () => assert.fail('no log') })

    assert.equal(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'), seeded(KEY))
  })
})

describe('signing in as another account', () => {
  const token = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`
  const ALICE = token('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  const BOB = token('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  const DEVICE = '11111111-1111-4111-8111-111111111111'

  test("revokes the previous account's key with that account's login, by proof only", async () => {
    const posts: Array<{ bearer: string; body: Record<string, unknown> }> = []
    const log: string[] = []

    const outcome = await revokePreviousAccountKey({
      previous: { key: KEY, accessToken: ALICE },
      nextAccessToken: BOB,
      deviceInstanceId: DEVICE,
      post: async (bearer, body) => {
        posts.push({ bearer, body })

        return { revoked: true }
      },
      log: line => log.push(line)
    })

    assert.equal(outcome, 'revoked')
    assert.deepEqual(posts, [
      {
        bearer: ALICE,
        body: { device_instance_id: DEVICE, legacy_key_hash: crypto.createHash('sha256').update(KEY).digest('hex') }
      }
    ])
    assert.deepEqual(log, [
      "[managed] signed in as another account: the server revoked the previous account's relay key for this computer"
    ])
  })

  test('the same account signing in again leaves it to the server rotation', async () => {
    const outcome = await revokePreviousAccountKey({
      previous: { key: KEY, accessToken: ALICE },
      nextAccessToken: token('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      deviceInstanceId: DEVICE,
      post: async () => assert.fail('no revoke'),
      log: () => assert.fail('no log')
    })

    assert.equal(outcome, 'kept')
  })

  test.each([
    ['nothing stored', { key: '', accessToken: '' }],
    ['an env key with no login', { key: KEY, accessToken: '' }]
  ])('%s: nothing to revoke', async (_name, previous) => {
    assert.equal(
      await revokePreviousAccountKey({
        previous,
        nextAccessToken: BOB,
        deviceInstanceId: DEVICE,
        post: async () => assert.fail('no revoke'),
        log: () => assert.fail('no log')
      }),
      'kept'
    )
  })

  test.each([
    [
      'an expired login',
      Object.assign(new Error(`401: {"detail":"Token expired","echo":"${KEY}"}`), { statusCode: 401 }),
      'HTTP 401'
    ],
    ['a server that did not revoke', null, 'DESKTOP_KEY_NOT_REVOKED'],
    ['a network error that echoes the request', new Error(`socket hang up ${KEY} ${ALICE}`), 'socket hang up … …']
  ])('%s: logged with a code, never a body or the key', async (_name, error, reason) => {
    const log: string[] = []

    const outcome = await revokePreviousAccountKey({
      previous: { key: KEY, accessToken: ALICE },
      nextAccessToken: BOB,
      deviceInstanceId: DEVICE,
      post: async () => {
        if (error) {
          throw error
        }

        return { revoked: false }
      },
      log: line => log.push(line)
    })

    assert.equal(outcome, 'failed')
    assert.equal(log.length, 1)
    assert.ok(log[0].includes(`(${reason})`), log[0])
    assert.equal(log[0].includes(KEY), false)
    assert.equal(log[0].includes(ALICE), false)
  })
})
