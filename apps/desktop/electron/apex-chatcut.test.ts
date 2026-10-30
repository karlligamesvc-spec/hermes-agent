/**
 * hc-1122: the launch switch main settles from `desktop_features.chatcut`, and what
 * leaves this computer when the APEX account does. The off path is pinned against
 * fork main by apex-chatcut-identity.test.ts.
 *
 * Run with: npx vitest run electron/apex-chatcut.test.ts --project electron
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { applyChatcutSwitch, CHATCUT_ACTIVE_ENV, scrubChatcutConnections, withoutChatcutEntry } from './apex-chatcut'
import { clearAccountPromptMirrors } from './apex-memory-ledger'
import { applyDesktopFeatureSwitches } from './apex-model-tiers'

const ON = { desktop_features: { chatcut: true } }

describe('the launch switch', () => {
  test('the platform turns it on with a literal true, and it is logged once', () => {
    const env: Record<string, string | undefined> = {}
    const lines: string[] = []

    assert.equal(applyChatcutSwitch(env, ON, line => lines.push(line)), true)
    assert.equal(env[CHATCUT_ACTIVE_ENV], '1')
    assert.deepEqual(lines, ['[client-config] APEX_CHATCUT_ACTIVE=1 (desktop_features.chatcut)'])
  })

  test.each([
    ['no config', null],
    ['no flag', { desktop_features: {} }],
    ['false', { desktop_features: { chatcut: false } }],
    ['a string', { desktop_features: { chatcut: 'true' } }],
    ['a number', { desktop_features: { chatcut: 1 } }],
    ['a top-level key', { chatcut: true }]
  ])('%s leaves it off', (_label, payload) => {
    const env: Record<string, string | undefined> = {}

    assert.equal(applyChatcutSwitch(env, payload), false)
    assert.equal(CHATCUT_ACTIVE_ENV in env, false)
  })

  test('this install wins in both directions', () => {
    const on: Record<string, string | undefined> = { APEXNODES_CHATCUT: '1' }
    const off: Record<string, string | undefined> = { APEXNODES_CHATCUT: '0' }

    assert.equal(applyChatcutSwitch(on, null), true)
    assert.equal(applyChatcutSwitch(off, ON), false)
    assert.equal(off[CHATCUT_ACTIVE_ENV], undefined)
  })

  test('off removes a value inherited from the environment: it is an output, never an input', () => {
    const env: Record<string, string | undefined> = { [CHATCUT_ACTIVE_ENV]: '1' }

    applyChatcutSwitch(env, null)

    assert.equal(CHATCUT_ACTIVE_ENV in env, false)
  })

  test('the launch settles it with the other switches', () => {
    const env: Record<string, string | undefined> = {}

    assert.deepEqual(applyDesktopFeatureSwitches(env, ON), [CHATCUT_ACTIVE_ENV])
    assert.equal(env[CHATCUT_ACTIVE_ENV], '1')
  })
})

const ENTRY = [
  '  chatcut:',
  '    url: https://api.chatcut.io/api/external-mcp/mcp',
  '    auth: oauth',
  '    headers:',
  '      x-chatcut-mcp-client: apex_desktop',
  '    oauth:',
  '      client_name: APEX Desktop',
  '    tools:',
  '      include:',
  '      - read_script'
]

describe('taking the entry out of config.yaml', () => {
  test('every other byte stays, comments and order included', () => {
    const before = ['# my notes', 'model:', '  default: x', 'mcp_servers:', '  other:', '    url: https://o.invalid', '']
    const text = [...before.slice(0, -1), ...ENTRY, '# trailing comment', 'memory:', '  enabled: true', ''].join('\n')

    expect(withoutChatcutEntry(text)).toBe(
      [...before.slice(0, -1), '# trailing comment', 'memory:', '  enabled: true', ''].join('\n')
    )
  })

  test('the only server: mcp_servers goes with it', () => {
    const text = ['model:', '  default: x', 'mcp_servers:', ...ENTRY, 'memory:', '  enabled: true', ''].join('\n')

    expect(withoutChatcutEntry(text)).toBe(['model:', '  default: x', 'memory:', '  enabled: true', ''].join('\n'))
  })

  test('an entry listed before another server leaves that server in place', () => {
    const text = ['mcp_servers:', ...ENTRY, '  other:', '    url: https://o.invalid', ''].join('\n')

    expect(withoutChatcutEntry(text)).toBe(['mcp_servers:', '  other:', '    url: https://o.invalid', ''].join('\n'))
  })

  test.each([
    ['no mcp_servers', 'model:\n  default: x\n'],
    ['other servers only', 'mcp_servers:\n  other:\n    url: https://o.invalid\n'],
    ['a server of that name elsewhere', 'mcp_servers:\n  chatcut:\n    url: https://mine.invalid/mcp\n'],
    ['the word in a value', 'note: chatcut\nmcp_servers:\n  other:\n    url: https://chatcut.invalid\n']
  ])('%s: nothing to do', (_label, text) => {
    assert.equal(withoutChatcutEntry(text), null)
  })
})

describe('when the APEX account leaves', () => {
  const made: string[] = []

  afterEach(() => {
    for (const dir of made.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true })
    }
  })

  function assistant(home: string, config = ['mcp_servers:', ...ENTRY, ''].join('\n')) {
    fs.mkdirSync(path.join(home, 'mcp-tokens'), { recursive: true })
    fs.mkdirSync(path.join(home, 'apex'), { recursive: true })
    fs.writeFileSync(path.join(home, 'config.yaml'), config)
    fs.writeFileSync(path.join(home, 'mcp-tokens', 'chatcut.json'), '{"access_token":"SECRET-TOKEN"}')
    fs.writeFileSync(path.join(home, 'mcp-tokens', 'chatcut.client.json'), '{"client_id":"c"}')
    fs.writeFileSync(path.join(home, 'mcp-tokens', 'chatcut.meta.json'), '{}')
    fs.writeFileSync(path.join(home, 'mcp-tokens', 'notion.json'), '{"access_token":"KEEP"}')
    fs.writeFileSync(path.join(home, 'apex', 'chatcut-upload-consent.json'), '{}')
  }

  function root() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-chatcut-'))

    made.push(dir)
    assistant(dir)
    assistant(path.join(dir, 'profiles', 'helper'))

    return dir
  }

  /** Every byte under the directory: the check does not reuse the scrub's idea of where things live. */
  function bytesUnder(dir: string): string {
    return fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
      .join('\n')
  }

  test('every assistant loses its sign-in, its entry and its consent', () => {
    const dir = root()

    assert.deepEqual(scrubChatcutConnections(dir), [dir, path.join(dir, 'profiles', 'helper')])

    const left = bytesUnder(dir)

    assert.equal(left.includes('SECRET-TOKEN'), false)
    assert.equal(left.includes('api.chatcut.io'), false)

    for (const home of [dir, path.join(dir, 'profiles', 'helper')]) {
      assert.deepEqual(fs.readdirSync(path.join(home, 'mcp-tokens')), ['notion.json'], 'another server keeps its tokens')
      assert.equal(fs.existsSync(path.join(home, 'apex', 'chatcut-upload-consent.json')), false)
    }
  })

  test('nothing there: nothing touched, and it says so', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-chatcut-'))

    made.push(dir)
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'model:\n  default: x\n')

    const before = fs.statSync(path.join(dir, 'config.yaml')).mtimeMs

    assert.deepEqual(scrubChatcutConnections(dir), [])
    assert.equal(fs.statSync(path.join(dir, 'config.yaml')).mtimeMs, before)
  })

  test('a developer’s own server of that name keeps its entry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-chatcut-'))
    const config = 'mcp_servers:\n  chatcut:\n    url: https://mine.invalid/mcp\n'

    made.push(dir)
    fs.writeFileSync(path.join(dir, 'config.yaml'), config)
    scrubChatcutConnections(dir)

    assert.equal(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8'), config)
  })

  test('both exits run it: the sign-out and the account change share this one call', () => {
    const dir = root()

    clearAccountPromptMirrors(dir)

    assert.equal(bytesUnder(dir).includes('SECRET-TOKEN'), false)
    assert.equal(fs.existsSync(path.join(dir, 'mcp-tokens', 'chatcut.json')), false)
  })

  test('main calls it on both exits', () => {
    const main = fs
      .readFileSync(path.join(import.meta.dirname, 'main.ts'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')

    assert.equal(main.split('clearAccountPromptMirrors(HERMES_HOME)').length - 1, 2)
    assert.match(main.slice(main.indexOf('function clearManagedRelayCredential')), /clearAccountPromptMirrors\(HERMES_HOME\)/)
  })
})
