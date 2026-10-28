import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { test } from 'vitest'

import { RuntimeUpdateBusy } from './runtime-update-busy'

// hc-473: keep this suite hermetic regardless of how it's invoked (npm run
// test:desktop:platforms already sets this too, but this file must not rely
// on that -- a bare `npx vitest run electron/shell-updater.test.ts` must never
// let createShellUpdater's default sendTelemetry touch the real network).
// Tests that assert on beacon content inject their own fake sendTelemetry,
// which always takes priority over this env var.
process.env.APEXNODES_TELEMETRY = 'off'

import {
  createShellUpdater,
  normalizeReleaseNotes,
  SHELL_UPDATE_EVENT_CHANNEL,
  SHELL_UPDATE_FEED_BASE,
  shellUpdateFeedUrl
} from './shell-updater'

// ---------------------------------------------------------------------------
// 假件:ipcMain 只要 .handle;autoUpdater 是 EventEmitter + 可数的 stub。
// ---------------------------------------------------------------------------

function fakeIpcMain() {
  const handlers = new Map()

  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => {
      const fn = handlers.get(channel)

      if (!fn) {throw new Error(`no handler for ${channel}`)}

      return fn({}, ...args)
    },
    handlers
  }
}

function fakeAutoUpdater() {
  const updater: any = new EventEmitter()
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

function harness({ isPackaged = true, autoUpdater = fakeAutoUpdater(), ...rest }: any = {}) {
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

test('requested shell install waits for busy engine owners and automatically installs after release', async () => {
  let busy = true
  let preflights = 0
  const h = harness({ beforeInstall: async () => {
    preflights += 1
    if (busy) {throw new RuntimeUpdateBusy()}
  }, installRetryMs: 10 })
  try {
    h.autoUpdater.emit('update-downloaded', { version: '0.17.57' })
    const results = await Promise.all([h.ipcMain.invoke('hermes:shell-update:install'), h.ipcMain.invoke('hermes:shell-update:install')])
    assert.deepEqual(results, [{ ok: true, deferred: true }, { ok: true, deferred: true }])
    assert.equal(h.autoUpdater.autoInstallOnAppQuit, false, 'normal quit cannot bypass process preflight')
    assert.equal(preflights, 1)
    assert.deepEqual(h.autoUpdater.installCalls, [])
    assert.equal(h.updater.getState().phase, 'downloaded')
    assert.equal(h.updater.getState().error, null)
    await h.updater.checkNow()
    assert.equal(h.autoUpdater.checkCalls, 0, 'preserve the already requested version')
    busy = false
    await waitUntil(() => h.autoUpdater.installCalls.length === 1)
    assert.deepEqual(h.autoUpdater.installCalls, [[true, true]])
  } finally { h.updater.dispose() }
})

test.each(['throw', 'event', 'dispose'])('shell handoff holds its fence, coalesces clicks, and releases on %s', async mode => {
  let releases = 0
  let preparations = 0
  const h = harness({ beforeInstall: async () => {
    preparations += 1
    return { release: () => { releases += 1 } }
  } })
  try {
    h.autoUpdater.emit('update-downloaded', { version: '0.17.57' })
    if (mode === 'throw') {h.autoUpdater.quitAndInstall = () => {throw new Error('install failed')}}
    await h.ipcMain.invoke('hermes:shell-update:install')
    await h.ipcMain.invoke('hermes:shell-update:install')
    assert.equal(preparations, 1)
    assert.equal(releases, 0)
    await flushImmediate()
    if (mode === 'event') {h.autoUpdater.emit('error', new Error('installer failed'))}
    if (mode === 'dispose') {h.updater.dispose()}
    assert.equal(releases, 1)
    if (mode !== 'dispose') {
      await h.updater.checkNow()
      assert.equal(h.autoUpdater.checkCalls, 1, 'failed handoff can check again')
    }
  } finally {h.updater.dispose()}
  assert.equal(releases, 1)
})

test('unverified ownership does not install or masquerade as a temporary conflict', async () => {
  const h = harness({ beforeInstall: async () => {throw new Error('identity probe failed')} })
  try {
    h.autoUpdater.emit('update-downloaded', { version: '0.17.57' })
    assert.deepEqual(await h.ipcMain.invoke('hermes:shell-update:install'), { ok: false, error: 'identity probe failed' })
    await flushImmediate()
    assert.deepEqual(h.autoUpdater.installCalls, [])
  } finally { h.updater.dispose() }
})

test('a deferred install never hands off a different version downloaded meanwhile', async () => {
  let busy = true

  const h = harness({
    beforeInstall: async () => {
      if (busy) {throw new RuntimeUpdateBusy()}
    },
    installRetryMs: 10
  })

  try {
    h.autoUpdater.emit('update-downloaded', { version: '0.17.57' })
    assert.deepEqual(await h.ipcMain.invoke('hermes:shell-update:install'), { ok: true, deferred: true })
    h.autoUpdater.emit('update-downloaded', { version: '0.17.58' })
    busy = false
    await waitUntil(() => h.updater.getState().phase === 'error')
    assert.equal(h.updater.getState().error, 'shell_target_changed')
    assert.equal(h.updater.getState().deferred, false, 'a failed retry no longer claims to wait')
    assert.deepEqual(h.autoUpdater.installCalls, [], 'the user asked for 0.17.57, not whatever is downloaded now')
  } finally { h.updater.dispose() }
})

test('a deferred install logs what it waits for once per reason and tells the renderer (hc-1030)', async () => {
  const holders = { 1347: { name: 'python3.12', ppid: 1, exe: '/u/.apexnodes/hermes-agent/venv/bin/python3.12', argv: [] } }
  let busy: Error | null = Object.assign(new RuntimeUpdateBusy('Waiting for engine workers: 1347', 'engine_holders'), { idleProof: { holders } })
  let preflights = 0
  const h = harness({ beforeInstall: async () => {
    preflights += 1
    if (busy) {throw busy}
  }, installRetryMs: 10 })
  const deferrals = () => h.logs.filter(line => line.startsWith('[shell-update] install deferred'))
  try {
    h.autoUpdater.emit('update-downloaded', { version: '0.17.62' })
    assert.deepEqual(await h.ipcMain.invoke('hermes:shell-update:install'), { ok: true, deferred: true })
    assert.equal(h.updater.getState().deferredReason, 'engine_holders')
    assert.equal(h.broadcasts.at(-1).payload.deferredReason, 'engine_holders')
    await waitUntil(() => preflights >= 3)
    assert.deepEqual(deferrals(), [
      '[shell-update] install deferred (version=0.17.62): engine_holders: Waiting for engine workers: 1347 [1347 python3.12 (/u/.apexnodes/hermes-agent/venv/bin/python3.12)]'
    ], 'retries with the same reason add no lines')
    busy = new RuntimeUpdateBusy()
    await waitUntil(() => deferrals().length === 2)
    assert.equal(deferrals()[1], '[shell-update] install deferred (version=0.17.62): active_work: Waiting for existing APEX work to finish.')
    assert.equal(h.updater.getState().deferredReason, 'active_work')
    busy = null
    await waitUntil(() => h.autoUpdater.installCalls.length === 1)
    assert.equal(h.updater.getState().deferred, false)
    assert.equal(h.updater.getState().deferredReason, null)
  } finally { h.updater.dispose() }
})

test('hc-1094: a wait on classified holders tells the renderer who they are, and clears it once installing', async () => {
  const holders = {
    1347: { name: 'python3.11', ppid: 1, exe: '/e/venv/bin/python', argv: ['/e/venv/bin/python', '-m', 'hermes_cli.main', 'gateway', 'run', '--replace'], created: 7.5, kind: 'leftover_gateway', endable: true },
    2001: { name: 'python3.11', ppid: 700, exe: '/e/venv/bin/python', argv: ['/e/venv/bin/python', '/e/venv/bin/hermes'], created: 8.5, kind: 'terminal_hermes', endable: false }
  }

  let busy: Error | null = Object.assign(new RuntimeUpdateBusy('Waiting for engine workers: 1347, 2001', 'engine_holders'), { idleProof: { holders } })
  const h = harness({ beforeInstall: async () => { if (busy) {throw busy} }, installRetryMs: 10 })

  try {
    h.autoUpdater.emit('update-downloaded', { version: '0.17.67' })
    assert.deepEqual(await h.ipcMain.invoke('hermes:shell-update:install'), { ok: true, deferred: true })
    assert.deepEqual(h.broadcasts.at(-1).payload.deferredHolders, [
      { pid: 1347, kind: 'leftover_gateway', name: 'hermes', created: 7.5, endable: true },
      { pid: 2001, kind: 'terminal_hermes', name: 'hermes', created: 8.5, endable: false }
    ])
    assert.ok(h.logs.includes('[shell-update] install deferred (version=0.17.67): engine_holders: Waiting for engine workers: 1347, 2001 [1347 python3.11 (/e/venv/bin/python) leftover_gateway endable; 2001 python3.11 (/e/venv/bin/python) terminal_hermes]'))
    busy = null
    await waitUntil(() => h.autoUpdater.installCalls.length === 1)
    assert.equal(h.updater.getState().deferredHolders, null, 'installing names no holders')
  } finally { h.updater.dispose() }
})

test('hc-1094: a wait for another reason drops the holders it named before', async () => {
  const holders = { 1347: { name: 'python3.11', ppid: 1, exe: '/e/venv/bin/python', argv: [], created: 7.5, kind: 'leftover_gateway', endable: true } }
  let busy: Error = Object.assign(new RuntimeUpdateBusy('Waiting for engine workers: 1347', 'engine_holders'), { idleProof: { holders } })
  const h = harness({ beforeInstall: async () => {throw busy}, installRetryMs: 10 })

  try {
    h.autoUpdater.emit('update-downloaded', { version: '0.17.67' })
    await h.ipcMain.invoke('hermes:shell-update:install')
    assert.equal(h.updater.getState().deferredHolders?.length, 1)
    busy = new RuntimeUpdateBusy()
    await waitUntil(() => h.updater.getState().deferredReason === 'active_work')
    assert.equal(h.updater.getState().deferredHolders, null)
  } finally { h.updater.dispose() }
})

test('hc-1094: ending leftovers passes only whole PID + start-time pairs and reports what ended', async () => {
  const calls: unknown[] = []

  const h = harness({ beforeInstall: async () => {}, endLeftovers: async (confirmed: unknown) => { calls.push(confirmed);

 return { 1347: 'terminated' } } })

  try {
    assert.deepEqual(await h.ipcMain.invoke('hermes:shell-update:end-leftovers', [{ pid: 1347, created: 7.5 }, { pid: '9', created: 1 }, { pid: 3 }]), { ok: true, ended: { 1347: 'terminated' } })
    assert.deepEqual(calls, [[{ pid: 1347, created: 7.5 }]])
    assert.deepEqual(h.autoUpdater.installCalls, [], 'ending never installs by itself; the renderer asks again')
  } finally { h.updater.dispose() }
})

test('hc-1094: a failed end request is returned and logged; without the gate or packaged it is refused', async () => {
  const failing = harness({ endLeftovers: async () => {throw new Error('scan failed')} })
  const missing = harness()
  const unpackaged = harness({ isPackaged: false, endLeftovers: async () => ({}) })

  try {
    assert.deepEqual(await failing.ipcMain.invoke('hermes:shell-update:end-leftovers', []), { ok: false, error: 'scan failed' })
    assert.ok(failing.logs.includes('[shell-update] ending leftovers failed: scan failed'))
    assert.deepEqual(await missing.ipcMain.invoke('hermes:shell-update:end-leftovers', []), { ok: false, error: 'unsupported' })
    assert.deepEqual(await unpackaged.ipcMain.invoke('hermes:shell-update:end-leftovers', []), { ok: false, error: 'disabled' })
  } finally {
    failing.updater.dispose()
    missing.updater.dispose()
    unpackaged.updater.dispose()
  }
})

test('a gate failure that is not busy is logged, not only returned (hc-1030)', async () => {
  const h = harness({ beforeInstall: async () => {throw new Error('identity probe failed')} })
  try {
    h.autoUpdater.emit('update-downloaded', { version: '0.17.62' })
    assert.deepEqual(await h.ipcMain.invoke('hermes:shell-update:install'), { ok: false, error: 'identity probe failed' })
    assert.ok(h.logs.includes('[shell-update] install blocked before quitAndInstall: identity probe failed'))
    assert.equal(h.updater.getState().deferred, undefined)
  } finally { h.updater.dispose() }
})

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs

  while (!predicate()) {
    if (Date.now() > deadline) {throw new Error('waitUntil timed out')}
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

// hc-435 命门:feed 必须落在 <base>/<os>-<arch> 子目录,永远比 base 深一层。
// 根 desktop/ 下故意为空(404);一旦 feed 塌回 base,updater 就去读 404 的根
// feed → 自更新静默失效。这条守住「绝不等于 base、也绝不是 base 的直接前缀段」。
test('shellUpdateFeedUrl never collapses to the bare (empty) root base', () => {
  for (const arch of ['arm64', 'x64']) {
    for (const platform of ['darwin', 'win32', 'linux']) {
      const url = shellUpdateFeedUrl({ platform, arch })
      assert.notEqual(url, SHELL_UPDATE_FEED_BASE, `${platform}/${arch} must not equal the root base`)
      assert.ok(url.startsWith(`${SHELL_UPDATE_FEED_BASE}/`), `${platform}/${arch} must live under the base`)
      assert.match(url, /\/(mac|win|linux)-(arm64|x64)$/, `${platform}/${arch} must end with an os-arch segment`)
    }
  }
})

// 空 arch(理论回归:某处把 arch 显式传成空串,或 process.arch 拿到空值)不能
// 悄悄拼出 base+空段的根 feed —— 直接抛,让上层兜成 disabled 而不是去读根 404。
// (arch 属性缺省/undefined 走默认 process.arch,真机上非空,不在此守;这里守的
// 是「拿到了但为空」这个会塌向根目录的危险值。)
test('shellUpdateFeedUrl throws on an empty arch instead of yielding a root-ish feed', () => {
  assert.throws(() => shellUpdateFeedUrl({ platform: 'darwin', arch: '' }), /missing arch/)
  assert.throws(() => shellUpdateFeedUrl({ platform: 'win32', arch: '' }), /missing arch/)
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
    error: null,
    releaseNotes: null
  })

  const install = await ipcMain.invoke('hermes:shell-update:install')
  assert.deepEqual(install, { ok: false, error: 'disabled' })
  assert.deepEqual(await ipcMain.invoke('hermes:shell-update:check'), {
    ok: false,
    error: 'disabled',
    state: {
      phase: 'disabled',
      version: null,
      percent: null,
      error: null,
      releaseNotes: null
    }
  })
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
  assert.deepEqual(autoUpdater.feed, {
    provider: 'generic',
    url: `${SHELL_UPDATE_FEED_BASE}/mac-arm64`,
    useMultipleRangeRequest: false
  })
})

test('manual check IPC reuses the updater check and returns the latest snapshot', async () => {
  const { ipcMain, autoUpdater } = harness()

  const result = await ipcMain.invoke('hermes:shell-update:check')

  assert.equal(autoUpdater.checkCalls, 1)
  assert.equal(result.ok, true)
  assert.equal(result.state.phase, 'idle')
})

// hc-435:packaged 但 arch 拿不到时,宁可整体停用也不 setFeedURL 到根 feed,
// 更不能把 initShellUpdater 带崩(startup 契约:自更新故障绝不拦启动)。
test('packaged build with an unresolvable arch degrades to disabled, never feeds the root', () => {
  const { updater, autoUpdater, logs } = harness({ arch: '' })

  assert.equal(updater.getState().phase, 'disabled')
  // 从未配过 feed(没有塌向根目录),也没崩。
  assert.equal(autoUpdater.feed, null)
  assert.ok(logs.some(line => line.includes('cannot resolve per-arch feed URL')))
})

// ---------------------------------------------------------------------------
// 事件流 → 状态机 + IPC 广播
// ---------------------------------------------------------------------------

test('autoUpdater event flow drives the state machine and broadcasts each transition', async () => {
  const { updater, ipcMain, broadcasts, autoUpdater } = harness()

  autoUpdater.emit('checking-for-update')
  assert.equal(updater.getState().phase, 'checking')

  autoUpdater.emit('update-available', { version: '0.16.1' })
  assert.deepEqual(updater.getState(), { phase: 'available', version: '0.16.1', percent: null, error: null, releaseNotes: null })

  autoUpdater.emit('download-progress', { percent: 42.5 })
  assert.equal(updater.getState().phase, 'downloading')
  assert.equal(updater.getState().percent, 42.5)

  autoUpdater.emit('update-downloaded', { version: '0.16.1' })
  assert.deepEqual(updater.getState(), { phase: 'downloaded', version: '0.16.1', percent: 100, error: null, releaseNotes: null })

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
    error: null,
    releaseNotes: null
  })
})

// ---------------------------------------------------------------------------
// hc-447: releaseNotes normalization + propagation
// ---------------------------------------------------------------------------

test('normalizeReleaseNotes passes through a trimmed plain string', () => {
  assert.equal(normalizeReleaseNotes('Faster startup, fixed a crash.'), 'Faster startup, fixed a crash.')
  assert.equal(normalizeReleaseNotes('  padded  \n'), 'padded')
})

test('normalizeReleaseNotes collapses an empty/whitespace-only string to null', () => {
  assert.equal(normalizeReleaseNotes(''), null)
  assert.equal(normalizeReleaseNotes('   '), null)
})

test('normalizeReleaseNotes joins a multi-version { version, note } array (electron-updater\'s multi-hop shape)', () => {
  const joined = normalizeReleaseNotes([
    { version: '0.16.15', note: 'Fixed a crash on launch.' },
    { version: '0.16.16', note: 'Faster startup.' }
  ])

  assert.equal(joined, 'Fixed a crash on launch.\n\nFaster startup.')
})

test('normalizeReleaseNotes drops empty/garbage entries from a multi-version array', () => {
  assert.equal(
    normalizeReleaseNotes([{ version: '0.16.15', note: '' }, { version: '0.16.16', note: null }, 'garbage']),
    null
  )
  assert.equal(
    normalizeReleaseNotes([{ version: '0.16.15', note: '' }, { version: '0.16.16', note: 'Faster startup.' }]),
    'Faster startup.'
  )
})

test('normalizeReleaseNotes degrades null/undefined/garbage to null (a release with no authored notes is not an error)', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.equal(normalizeReleaseNotes(bad), null)
  }
})

test('update-available carries hand-authored releaseNotes from latest.yml through to state', () => {
  const { updater, autoUpdater } = harness()

  autoUpdater.emit('update-available', { version: '0.16.16', releaseNotes: 'You can now see human-readable release notes.' })

  assert.equal(updater.getState().releaseNotes, 'You can now see human-readable release notes.')
})

test('update-downloaded falls back to the notes already captured at update-available when its own payload omits them', () => {
  const { updater, autoUpdater } = harness()

  autoUpdater.emit('update-available', { version: '0.16.16', releaseNotes: 'Faster startup.' })
  // electron-updater's update-downloaded info sometimes omits releaseNotes even
  // though the same version's update-available carried it — must not regress.
  autoUpdater.emit('update-downloaded', { version: '0.16.16' })

  assert.equal(updater.getState().releaseNotes, 'Faster startup.')
})

test('update-downloaded releaseNotes overrides a stale value when its own payload carries a fresher one', () => {
  const { updater, autoUpdater } = harness()

  autoUpdater.emit('update-available', { version: '0.16.16', releaseNotes: 'stale' })
  autoUpdater.emit('update-downloaded', { version: '0.16.16', releaseNotes: 'fresh' })

  assert.equal(updater.getState().releaseNotes, 'fresh')
})

test('a release shipped with no authored notes leaves releaseNotes null (not an error, not a placeholder)', () => {
  const { updater, autoUpdater } = harness()

  autoUpdater.emit('update-available', { version: '0.16.16' })
  assert.equal(updater.getState().releaseNotes, null)

  autoUpdater.emit('update-downloaded', { version: '0.16.16' })
  assert.equal(updater.getState().releaseNotes, null)
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

  assert.deepEqual(await updater.checkNow(), { ok: false, error: 'feed unreachable' })

  assert.ok(logs.some(line => line.includes('[shell-update] check failed (silent): feed unreachable')))
  assert.equal(updater.getState().phase, 'error')
})

test('a failed auto-download handed back by the check is not an unhandled rejection', async () => {
  const { updater, logs, autoUpdater } = harness()
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)

  // electron-updater's shape: the check succeeds, the download it started fails, 'error' fires,
  // and the same failure is rethrown in result.downloadPromise.
  autoUpdater.checkForUpdates = async () => {
    const downloadPromise = (async () => {
      autoUpdater.emit('error', new Error('ENOENT: app-update.yml'))
      throw new Error('ENOENT: app-update.yml')
    })()

    return { updateInfo: { version: '0.17.57' }, downloadPromise }
  }

  process.on('unhandledRejection', onUnhandled)

  try {
    assert.deepEqual(await updater.checkNow(), { ok: true })
    await flushImmediate()
    await flushImmediate()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }

  assert.deepEqual(unhandled, [])
  assert.ok(logs.some(line => line.includes('[shell-update] error (silent): ENOENT: app-update.yml')))
  assert.equal(updater.getState().phase, 'error')
})

test('manual check IPC reports a rejected feed instead of claiming the app is current', async () => {
  const { ipcMain, autoUpdater } = harness()

  autoUpdater.checkForUpdates = async () => {
    throw new Error('latest.yml unavailable')
  }

  const result = await ipcMain.invoke('hermes:shell-update:check')

  assert.equal(result.ok, false)
  assert.equal(result.error, 'latest.yml unavailable')
  assert.equal(result.state.phase, 'error')
})

// ---------------------------------------------------------------------------
// hc-473: anonymous shell-update telemetry
// ---------------------------------------------------------------------------

function telemetryHarness(extra: any = {}) {
  const telemetryEvents = []
  const h = harness({ appVersion: '0.16.7', sendTelemetry: ev => telemetryEvents.push(ev), ...extra })

  return { ...h, telemetryEvents }
}

test('update-available fires a shell_update start beacon', () => {
  const { autoUpdater, telemetryEvents } = telemetryHarness()

  autoUpdater.emit('update-available', { version: '0.16.1' })

  assert.deepEqual(telemetryEvents, [
    { platform: 'mac', arch: 'arm64', app_version: '0.16.7', stage: 'shell_update', status: 'start' }
  ])
})

test('update-downloaded fires a shell_update success beacon', () => {
  const { autoUpdater, telemetryEvents } = telemetryHarness()

  autoUpdater.emit('update-available', { version: '0.16.1' })
  autoUpdater.emit('update-downloaded', { version: '0.16.1' })

  assert.deepEqual(
    telemetryEvents.map(ev => ev.status),
    ['start', 'success']
  )
  assert.ok(telemetryEvents.every(ev => ev.stage === 'shell_update'))
})

test('an updater error fires a shell_update failure beacon with a categorized error_code', () => {
  const { autoUpdater, telemetryEvents } = telemetryHarness()

  autoUpdater.emit('error', new Error('ECONNRESET'))

  assert.deepEqual(telemetryEvents, [
    {
      platform: 'mac',
      arch: 'arm64',
      app_version: '0.16.7',
      stage: 'shell_update',
      status: 'failure',
      error_code: 'shell_update:network'
    }
  ])
})

test('checking-for-update / update-not-available / download-progress fire NO telemetry (high-frequency, non-actionable)', () => {
  const { autoUpdater, telemetryEvents } = telemetryHarness()

  autoUpdater.emit('checking-for-update')
  autoUpdater.emit('update-not-available', { version: '0.16.0' })
  autoUpdater.emit('download-progress', { percent: 42.5 })

  assert.deepEqual(telemetryEvents, [])
})

test('quitAndInstall requested fires a shell_update_apply start beacon (no success beacon is possible — the process exits)', async () => {
  const { ipcMain, autoUpdater, telemetryEvents } = telemetryHarness()

  autoUpdater.emit('update-downloaded', { version: '0.16.1' })
  telemetryEvents.length = 0 // drop the update-downloaded beacon, isolate the install call
  assert.deepEqual(await ipcMain.invoke('hermes:shell-update:install'), { ok: true })
  await flushImmediate()

  assert.deepEqual(telemetryEvents, [
    { platform: 'mac', arch: 'arm64', app_version: '0.16.7', stage: 'shell_update_apply', status: 'start' }
  ])
})

test('a throwing quitAndInstall ALSO fires a shell_update_apply failure beacon', async () => {
  const { ipcMain, autoUpdater, telemetryEvents } = telemetryHarness()

  autoUpdater.quitAndInstall = () => {
    throw new Error('spawn failed')
  }

  autoUpdater.emit('update-downloaded', { version: '0.16.1' })
  telemetryEvents.length = 0
  assert.deepEqual(await ipcMain.invoke('hermes:shell-update:install'), { ok: true })
  await flushImmediate()

  assert.deepEqual(
    telemetryEvents.map(ev => ev.status),
    ['start', 'failure']
  )
  const failure = telemetryEvents.find(ev => ev.status === 'failure')
  assert.equal(failure.error_code, 'shell_update_apply:unknown')
})

test('install IPC refused before downloaded fires no telemetry at all', async () => {
  const { ipcMain, telemetryEvents } = telemetryHarness()

  assert.deepEqual(await ipcMain.invoke('hermes:shell-update:install'), { ok: false, error: 'not_downloaded' })
  await flushImmediate()

  assert.deepEqual(telemetryEvents, [])
})

test('a disabled (unpackaged) updater never touches telemetry', async () => {
  const { ipcMain, telemetryEvents } = telemetryHarness({ isPackaged: false })

  await ipcMain.invoke('hermes:shell-update:install')

  assert.deepEqual(telemetryEvents, [])
})

test('omitting sendTelemetry still drives the state machine correctly (real default, network suppressed by APEXNODES_TELEMETRY=off)', () => {
  const { updater, autoUpdater } = harness()

  autoUpdater.emit('update-available', { version: '0.16.1' })

  assert.equal(updater.getState().phase, 'available')
})
