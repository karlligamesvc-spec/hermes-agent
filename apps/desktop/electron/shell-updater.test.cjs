'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')

const {
  SHELL_UPDATE_EVENT_CHANNEL,
  SHELL_UPDATE_FEED_BASE,
  createShellUpdater,
  shellUpdateFeedUrl
} = require('./shell-updater.cjs')

// ---------------------------------------------------------------------------
// 假件:ipcMain 只要 .handle;autoUpdater 是 EventEmitter + 可数的 stub。
// ---------------------------------------------------------------------------

function fakeIpcMain() {
  const handlers = new Map()
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`no handler for ${channel}`)
      return fn({}, ...args)
    },
    handlers
  }
}

function fakeAutoUpdater() {
  const updater = new EventEmitter()
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowDowngrade = true
  updater.feed = null
  updater.checkCalls = 0
  updater.installCalls = []
  updater.setFeedURL = options => {
    updater.feed = options
  }
  updater.checkForUpdates = async () => {
    updater.checkCalls += 1
  }
  updater.quitAndInstall = (...args) => {
    updater.installCalls.push(args)
  }
  return updater
}

function harness({ isPackaged = true, autoUpdater = fakeAutoUpdater(), ...rest } = {}) {
  const ipcMain = fakeIpcMain()
  const broadcasts = []
  const logs = []
  const updater = createShellUpdater({
    autoUpdater,
    ipcMain,
    isPackaged,
    log: msg => logs.push(String(msg)),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    platform: 'darwin',
    arch: 'arm64',
    // 长到测试内永不触发;定时行为单独用短值测。
    initialDelayMs: 60_000,
    recheckIntervalMs: 60_000,
    ...rest
  })
  return { updater, ipcMain, broadcasts, logs, autoUpdater }
}

const flushImmediate = () => new Promise(resolve => setImmediate(resolve))

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

// ---------------------------------------------------------------------------
// shellUpdateFeedUrl:平台-架构分目录(mac 双架构 latest-mac.yml 同名,平铺会互覆)
// ---------------------------------------------------------------------------

test('shellUpdateFeedUrl keys the feed by platform-arch under the COS base', () => {
  assert.equal(shellUpdateFeedUrl({ platform: 'darwin', arch: 'arm64' }), `${SHELL_UPDATE_FEED_BASE}/mac-arm64`)
  assert.equal(shellUpdateFeedUrl({ platform: 'darwin', arch: 'x64' }), `${SHELL_UPDATE_FEED_BASE}/mac-x64`)
  assert.equal(shellUpdateFeedUrl({ platform: 'win32', arch: 'x64' }), `${SHELL_UPDATE_FEED_BASE}/win-x64`)
  assert.equal(shellUpdateFeedUrl({ platform: 'linux', arch: 'x64' }), `${SHELL_UPDATE_FEED_BASE}/linux-x64`)
  assert.equal(shellUpdateFeedUrl({ base: 'https://cdn.example/d', platform: 'win32', arch: 'arm64' }), 'https://cdn.example/d/win-arm64')
})

// ---------------------------------------------------------------------------
// dev / 未打包:整体停用,但 IPC 面仍在(renderer 无需探测)
// ---------------------------------------------------------------------------

test('unpackaged build: disabled state, install refused, autoUpdater untouched', async () => {
  const { updater, ipcMain, broadcasts, autoUpdater } = harness({ isPackaged: false })

  assert.equal(updater.getState().phase, 'disabled')
  assert.deepEqual(await ipcMain.invoke('hermes:shell-update:get'), {
    phase: 'disabled',
    version: null,
    percent: null,
    error: null
  })

  const install = await ipcMain.invoke('hermes:shell-update:install')
  assert.deepEqual(install, { ok: false, error: 'disabled' })
  await flushImmediate()
  assert.equal(autoUpdater.installCalls.length, 0)
  // 停用态没配置过 updater,也不该有任何状态广播。
  assert.equal(autoUpdater.feed, null)
  assert.equal(broadcasts.length, 0)
})

test('missing autoUpdater (require failed) degrades to disabled instead of throwing', async () => {
  const { updater, ipcMain } = harness({ autoUpdater: null })

  assert.equal(updater.getState().phase, 'disabled')
  assert.deepEqual(await ipcMain.invoke('hermes:shell-update:install'), { ok: false, error: 'disabled' })
})

// ---------------------------------------------------------------------------
// packaged:接线配置(静默下载 + 退出即装 + per-arch generic feed)
// ---------------------------------------------------------------------------

test('packaged build wires silent-download config and the per-arch generic feed', () => {
  const { autoUpdater } = harness()

  assert.equal(autoUpdater.autoDownload, true)
  assert.equal(autoUpdater.autoInstallOnAppQuit, true)
  assert.equal(autoUpdater.allowDowngrade, false)
  assert.deepEqual(autoUpdater.feed, { provider: 'generic', url: `${SHELL_UPDATE_FEED_BASE}/mac-arm64` })
})

// ---------------------------------------------------------------------------
// 事件流 → 状态机 + IPC 广播
// ---------------------------------------------------------------------------

test('autoUpdater event flow drives the state machine and broadcasts each transition', async () => {
  const { updater, ipcMain, broadcasts, autoUpdater } = harness()

  autoUpdater.emit('checking-for-update')
  assert.equal(updater.getState().phase, 'checking')

  autoUpdater.emit('update-available', { version: '0.16.1' })
  assert.deepEqual(updater.getState(), { phase: 'available', version: '0.16.1', percent: null, error: null })

  autoUpdater.emit('download-progress', { percent: 42.5 })
  assert.equal(updater.getState().phase, 'downloading')
  assert.equal(updater.getState().percent, 42.5)

  autoUpdater.emit('update-downloaded', { version: '0.16.1' })
  assert.deepEqual(updater.getState(), { phase: 'downloaded', version: '0.16.1', percent: 100, error: null })

  // 每次迁移都推 renderer;载荷是快照不是引用。
  assert.deepEqual(
    broadcasts.map(b => b.channel),
    Array(4).fill(SHELL_UPDATE_EVENT_CHANNEL)
  )
  assert.deepEqual(
    broadcasts.map(b => b.payload.phase),
    ['checking', 'available', 'downloading', 'downloaded']
  )
  broadcasts[3].payload.phase = 'tampered'
  assert.equal(updater.getState().phase, 'downloaded')

  // renderer 挂载后主动拉一次,拿到的是当前快照。
  assert.deepEqual(await ipcMain.invoke('hermes:shell-update:get'), {
    phase: 'downloaded',
    version: '0.16.1',
    percent: 100,
    error: null
  })
})

test('update-not-available returns to idle silently', () => {
  const { updater, autoUpdater } = harness()

  autoUpdater.emit('checking-for-update')
  autoUpdater.emit('update-not-available', { version: '0.16.0' })

  assert.equal(updater.getState().phase, 'idle')
  assert.equal(updater.getState().error, null)
})

test('updater errors stay silent: logged + state only, no throw', () => {
  const { updater, logs, autoUpdater } = harness()

  // 没挂 error 监听的话这里会直接 throw(EventEmitter 语义),等于主进程崩溃。
  autoUpdater.emit('error', new Error('ECONNRESET'))

  assert.equal(updater.getState().phase, 'error')
  assert.equal(updater.getState().error, 'ECONNRESET')
  assert.ok(logs.some(line => line.includes('[shell-update] error (silent): ECONNRESET')))
})

// ---------------------------------------------------------------------------
// quitAndInstall IPC
// ---------------------------------------------------------------------------

test('install IPC refuses before downloaded and installs (silent+relaunch) after', async () => {
  const { ipcMain, autoUpdater } = harness()

  assert.deepEqual(await ipcMain.invoke('hermes:shell-update:install'), { ok: false, error: 'not_downloaded' })
  await flushImmediate()
  assert.equal(autoUpdater.installCalls.length, 0)

  autoUpdater.emit('update-downloaded', { version: '0.16.1' })
  assert.deepEqual(await ipcMain.invoke('hermes:shell-update:install'), { ok: true })
  await flushImmediate()
  // win: isSilent + isForceRunAfter;mac(Squirrel.Mac)忽略参数。
  assert.deepEqual(autoUpdater.installCalls, [[true, true]])
})

test('a throwing quitAndInstall is caught and surfaced as error state, not a crash', async () => {
  const { updater, ipcMain, logs, autoUpdater } = harness()
  autoUpdater.quitAndInstall = () => {
    throw new Error('spawn failed')
  }

  autoUpdater.emit('update-downloaded', { version: '0.16.1' })
  assert.deepEqual(await ipcMain.invoke('hermes:shell-update:install'), { ok: true })
  await flushImmediate()

  assert.equal(updater.getState().phase, 'error')
  assert.ok(logs.some(line => line.includes('quitAndInstall failed: spawn failed')))
})

// ---------------------------------------------------------------------------
// 检查调度:延迟首查 + 周期重查;失败静默
// ---------------------------------------------------------------------------

test('schedules the delayed initial check and periodic rechecks; dispose stops them', async () => {
  const { updater, autoUpdater } = harness({ initialDelayMs: 1, recheckIntervalMs: 5 })

  await waitUntil(() => autoUpdater.checkCalls >= 2)

  updater.dispose()
  const settled = autoUpdater.checkCalls
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(autoUpdater.checkCalls, settled)
})

test('a rejecting checkForUpdates is swallowed and logged (no unhandled rejection)', async () => {
  const { updater, logs, autoUpdater } = harness()
  autoUpdater.checkForUpdates = async () => {
    throw new Error('feed unreachable')
  }

  await updater.checkNow()

  assert.ok(logs.some(line => line.includes('[shell-update] check failed (silent): feed unreachable')))
})
