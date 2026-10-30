/**
 * Tests for electron/apex-version-state.ts (hc-1095 版本照实说). Main mirrors
 * the app version, the shipped engine and the shell updater's state into
 * <HERMES_HOME>/apex/desktop-version.json for the engine to word. These pin the
 * status each updater state maps to, that the real updater's event sequences
 * land in the file, that progress ticks never rewrite it, and that the relay
 * to the windows is unchanged.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, test } from 'vitest'

import {
  createDesktopVersionMirror,
  type DesktopUpdateFacts,
  nextUpdateFacts,
  versionStatePath
} from './apex-version-state'
import { RuntimeUpdateBusy } from './runtime-update-busy'
import { createShellUpdater, SHELL_UPDATE_EVENT_CHANNEL } from './shell-updater'

process.env.APEXNODES_TELEMETRY = 'off'

const PIN = { commit: 'aa8e554e3878d08d3448474290bc0eb07a1e3f78', version: 'v2026.10.27-fork.aa8e554e' }
const UNCHECKED: DesktopUpdateFacts = { reason: null, status: 'unchecked', version: null }

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'apex-version-state-'))
})

afterEach(() => {
  rmSync(home, { force: true, recursive: true })
})

function readState() {
  return JSON.parse(readFileSync(versionStatePath(home), 'utf8'))
}

function fakeWindow(destroyed = false) {
  const sent: Array<[string, unknown]> = []

  return { isDestroyed: () => destroyed, sent, webContents: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) } }
}

function mirror(overrides: Record<string, unknown> = {}) {
  const logs: string[] = []
  const windows = [fakeWindow(), fakeWindow(true)]

  const created = createDesktopVersionMirror({
    appVersion: '0.17.63',
    enginePin: () => PIN,
    hermesHome: home,
    log: line => logs.push(line),
    windows: () => windows,
    ...overrides
  })

  return { ...created, logs, windows }
}

const downloaded = (version: string): DesktopUpdateFacts => ({ reason: null, status: 'downloaded', version })

test.each([
  ['the launch state', UNCHECKED, null, { phase: 'idle' }, UNCHECKED],
  ['a check that found nothing', UNCHECKED, 'checking', { phase: 'idle' }, { reason: null, status: 'latest', version: null }],
  ['a check in flight', downloaded('0.17.66'), 'downloaded', { phase: 'checking' }, downloaded('0.17.66')],
  ['a newer version found', UNCHECKED, 'checking', { phase: 'available', version: '0.17.66' }, { reason: null, status: 'downloading', version: '0.17.66' }],
  ['download progress', UNCHECKED, 'available', { percent: 40, phase: 'downloading', version: '0.17.66' }, { reason: null, status: 'downloading', version: '0.17.66' }],
  ['the download done', UNCHECKED, 'downloading', { phase: 'downloaded', version: '0.17.66' }, downloaded('0.17.66')],
  ['an install put off', downloaded('0.17.66'), 'downloaded', { deferred: true, deferredReason: 'gateway_busy', phase: 'downloaded', version: '0.17.66' }, { reason: 'gateway_busy', status: 'deferred', version: '0.17.66' }],
  ['an install put off without a reason', downloaded('0.17.66'), 'downloaded', { deferred: true, phase: 'downloaded', version: '0.17.66' }, { reason: 'active_work', status: 'deferred', version: '0.17.66' }],
  ['a recheck finding the cached download', downloaded('0.17.66'), 'checking', { phase: 'available', version: '0.17.66' }, downloaded('0.17.66')],
  ['a recheck finding a newer one', downloaded('0.17.66'), 'checking', { phase: 'available', version: '0.17.67' }, { reason: null, status: 'downloading', version: '0.17.67' }],
  ['a failed check or download', downloaded('0.17.66'), 'checking', { error: 'net::ERR', phase: 'error', version: '0.17.66' }, { reason: null, status: 'error', version: null }],
  ['a build that never updates', UNCHECKED, null, { phase: 'disabled' }, { reason: null, status: 'unavailable', version: null }],
  ['a phase this module does not know', downloaded('0.17.66'), 'downloaded', { phase: 'resuming' }, downloaded('0.17.66')]
])('%s', (_name, previous, lastPhase, shell, expected) => {
  assert.deepEqual(nextUpdateFacts(previous as DesktopUpdateFacts, lastPhase as null | string, shell), expected)
})

test('the file carries the app version, the shipped engine and the update facts', () => {
  const m = mirror()

  m.follow({ phase: 'idle' })

  assert.deepEqual(readState(), {
    app_version: '0.17.63',
    engine: PIN,
    schema: 1,
    update: UNCHECKED
  })
})

test('an engine pin that cannot be read leaves the engine out and says why', () => {
  const m = mirror({ enginePin: () => { throw new Error('The installer is missing a valid bundled engine release descriptor.') } })
  const unpackaged = mirror({ enginePin: () => null })

  m.follow({ phase: 'idle' })
  assert.equal(readState().engine, null)
  assert.match(m.logs.join('\n'), /\[version-state\] shipped engine unreadable: The installer is missing/)
  unpackaged.follow({ phase: 'disabled' })
  assert.deepEqual(readState(), { app_version: '0.17.63', engine: null, schema: 1, update: { reason: null, status: 'unavailable', version: null } })
})

test('broadcast relays to every live window and follows only shell-update events', () => {
  const m = mirror()

  m.follow({ phase: 'idle' })
  m.broadcast('hermes:something-else', { phase: 'downloaded', version: '9.9.9' })
  assert.equal(readState().update.status, 'unchecked')
  m.broadcast(SHELL_UPDATE_EVENT_CHANNEL, { phase: 'downloaded', version: '0.17.66' })

  assert.deepEqual(readState().update, downloaded('0.17.66'))
  assert.deepEqual(m.windows[0].sent, [
    ['hermes:something-else', { phase: 'downloaded', version: '9.9.9' }],
    [SHELL_UPDATE_EVENT_CHANNEL, { phase: 'downloaded', version: '0.17.66' }]
  ])
  assert.deepEqual(m.windows[1].sent, [], 'a destroyed window gets nothing')
})

test('progress ticks that change no fact never rewrite the file', () => {
  const m = mirror()

  m.follow({ phase: 'idle' })
  m.follow({ phase: 'checking' })
  m.follow({ phase: 'available', version: '0.17.66' })
  writeFileSync(versionStatePath(home), 'sentinel')
  m.follow({ percent: 12, phase: 'downloading', version: '0.17.66' })
  m.follow({ percent: 85, phase: 'downloading', version: '0.17.66' })
  assert.equal(readFileSync(versionStatePath(home), 'utf8'), 'sentinel')

  m.follow({ percent: 100, phase: 'downloaded', version: '0.17.66' })
  assert.deepEqual(readState().update, downloaded('0.17.66'))
})

test('a write that fails is logged, never thrown', () => {
  const blocker = join(home, 'not-a-dir')

  writeFileSync(blocker, '')
  const m = mirror({ hermesHome: blocker })

  assert.doesNotThrow(() => m.broadcast(SHELL_UPDATE_EVENT_CHANNEL, { phase: 'downloaded', version: '0.17.66' }))
  assert.match(m.logs.join('\n'), /\[version-state\] write failed/)
  assert.deepEqual(m.windows[0].sent, [[SHELL_UPDATE_EVENT_CHANNEL, { phase: 'downloaded', version: '0.17.66' }]])
})

test('main hands the updater the mirror as its broadcast and follows its launch state', () => {
  const main = readFileSync(join(__dirname, 'main.ts'), 'utf8')
  const start = main.indexOf('function initShellUpdater()')
  const body = main.slice(start, main.indexOf('\n}\n', start))

  assert.match(body, /createDesktopVersionMirror\(\{[^\n]*hermesHome: HERMES_HOME[^\n]*\}\)/)
  assert.match(body, /versionMirror\.follow\(createShellUpdater\(\{[\s\S]*broadcast: versionMirror\.broadcast\s*\}\)\.getState\(\)\)/)
  assert.doesNotMatch(body, /win\.webContents\.send/, 'one relay, in the mirror')
})

// The real updater, a fake electron-updater: the event sequences main sees land in the file.
function fakeAutoUpdater() {
  const updater: any = new EventEmitter()

  updater.setFeedURL = () => undefined
  updater.checkForUpdates = async () => undefined
  updater.installCalls = []
  updater.quitAndInstall = (...args: unknown[]) => updater.installCalls.push(args)

  return updater
}

function wiredUpdater(beforeInstall: () => Promise<unknown>) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const autoUpdater = fakeAutoUpdater()
  const m = mirror()

  const updater = createShellUpdater({
    arch: 'arm64',
    autoUpdater,
    beforeInstall,
    broadcast: m.broadcast,
    initialDelayMs: 60_000,
    installRetryMs: 10,
    ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) },
    isPackaged: true,
    platform: 'darwin',
    recheckIntervalMs: 60_000
  })

  m.follow(updater.getState())

  return { autoUpdater, install: () => handlers.get('hermes:shell-update:install')!({}), updater }
}

test('the real updater: launch, nothing newer, then a download that waits for 安装并重启', () => {
  const w = wiredUpdater(async () => undefined)

  try {
    assert.deepEqual(readState().update, UNCHECKED)
    w.autoUpdater.emit('checking-for-update')
    w.autoUpdater.emit('update-not-available', {})
    assert.equal(readState().update.status, 'latest')
    w.autoUpdater.emit('checking-for-update')
    w.autoUpdater.emit('update-available', { version: '0.17.66' })
    w.autoUpdater.emit('download-progress', { percent: 50 })
    assert.deepEqual(readState().update, { reason: null, status: 'downloading', version: '0.17.66' })
    w.autoUpdater.emit('update-downloaded', { version: '0.17.66' })
    assert.deepEqual(readState().update, downloaded('0.17.66'))
  } finally {
    w.updater.dispose()
  }
})

test('the real updater: an install put off for a busy gateway, then the error after a failed retry', async () => {
  let busy = true

  const w = wiredUpdater(async () => {
    if (busy) {throw new RuntimeUpdateBusy('Waiting for the messaging gateway.', 'gateway_busy')}
  })

  try {
    w.autoUpdater.emit('update-downloaded', { version: '0.17.66' })
    assert.partialDeepStrictEqual(await w.install(), { deferred: true, ok: true })
    assert.deepEqual(readState().update, { reason: 'gateway_busy', status: 'deferred', version: '0.17.66' })
    w.autoUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
    assert.deepEqual(readState().update, { reason: null, status: 'error', version: null })
    busy = false
  } finally {
    w.updater.dispose()
  }
})
