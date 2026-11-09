/**
 * Tests for electron/apex-platform-skills-refresh.ts (hc-1205): the platform skills keep up while
 * the app stays open.
 *
 * Real temp homes (a root plus profiles/<name>) and a real stored-state file; a stub fetchJson (no
 * network), a hand-driven clock and timer, and stub activity probes. What they pin: a running check
 * asks at most once per CHECK_EVERY_MS of wall-clock time, from focus or the timer, and an unchanged
 * manifest costs that one request and no write; a new manifest lands in the root and every profile
 * the way boot installs it, but only once no window, engine or IM gateway runs a turn, without a
 * second request; boot and sign-in drop a manifest still waiting; runs never overlap; and nothing
 * installs once the quit teardown starts.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { PLATFORM_SKILLS_CATEGORY } from './apex-platform-skills'
import { BUSY_RETRY_MS, CHECK_EVERY_MS, createPlatformSkillsRefresh, TICK_MS } from './apex-platform-skills-refresh'
import { PROFILE_SKILLS_STAMP } from './apex-platform-skills-sync'

const T0 = 1_762_700_000_000
const JWT = 'jwt-current'

const skill = (name: string, version: string) => ({
  files: [
    { content: `---\nname: ${name}\nversion: ${version}\n---\n${name} ${version}`, path: 'SKILL.md' },
    { content: `checklist ${version}`, path: 'references/checklist.md' }
  ],
  hash: `h-${name}-${version}`,
  name,
  version
})

const M1 = {
  manifest_hash: 'm1',
  skills: [skill('short-video-review', '1.0.0'), skill('douyin-video-transcript', '2.0.0')]
}

const M2 = {
  manifest_hash: 'm2',
  skills: [skill('short-video-review', '1.1.1'), skill('douyin-video-transcript', '2.0.0')]
}

const M3 = { manifest_hash: 'm3', skills: [skill('short-video-review', '1.2.0')] }
const UNCHANGED = (hash: string) => ({ manifest_hash: hash, unchanged: true })

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

function writeFile(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

/** Every file under dir as relpath → content, or {} when dir is missing. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}

  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name)

      if (entry.isDirectory()) {
        walk(abs)
      } else {
        out[path.relative(dir, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8')
      }
    }
  }

  if (fs.existsSync(dir)) {
    walk(dir)
  }

  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

const deferred = <T>() => {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(done => {
    resolve = done
  })

  return { promise, resolve }
}

interface Activity {
  gateway: null | string
  snapshot: unknown
  windowTurns: number
}

const IDLE_SNAPSHOT = { idle: true, ok: true, reason: null }

/**
 * A root home with two assistants, the stored state, a server, a clock, a timer and what runs.
 * `boot()` installs M1 the way a launch does; the test then drives focus, ticks and the clock.
 */
function makeRig(options: { env?: Record<string, string>; probeDeadlineMs?: number; token?: () => string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-skills-refresh-'))
  temps.push(root)
  const writer = path.join(root, 'profiles', 'writer')
  const editor = path.join(root, 'profiles', 'editor')

  for (const home of [root, writer, editor]) {
    writeFile(
      path.join(home, 'skills', 'my-stuff', 'my-skill', 'SKILL.md'),
      `---\nname: my-skill\n---\nmine in ${home}`
    )
    writeFile(path.join(home, 'SOUL.md'), 'soul')
  }

  const statePath = path.join(root, 'userdata', 'apex-platform-skills.json')
  const gatewayStatePath = path.join(root, 'gateway_state.json')
  const lines: string[] = []
  const calls: { bearer: unknown; url: string }[] = []
  const timers: { cancelled: boolean; ms: number; run: () => void }[] = []
  const controller = new AbortController()

  let reply: () => unknown = () => M1

  let focusListener = () => {}
  let clock = T0

  const activity: Activity = { gateway: null, snapshot: IDLE_SNAPSHOT, windowTurns: 0 }
  let probes = 0

  const refresher = createPlatformSkillsRefresh({
    apiBase: () => 'https://apex-nodes.com',
    engines: async () => [{ baseUrl: 'http://127.0.0.1:41001', token: 'engine-token' }],
    env: options.env ?? {},
    fetchJson: async (url: string, opts: any) => {
      calls.push({ bearer: opts?.bearer, url })

      return reply()
    },
    gatewayState: () => (activity.gateway === null ? null : gatewayStatePath),
    homes: () => [
      { home: root, profile: 'default' },
      { home: writer, profile: 'writer' },
      { home: editor, profile: 'editor' }
    ],
    log: line => lines.push(line),
    now: () => clock,
    onFocus: listener => {
      focusListener = listener
    },
    probe: async () => {
      probes += 1

      return activity.snapshot === 'never' ? new Promise(() => {}) : activity.snapshot
    },
    probeDeadlineMs: options.probeDeadlineMs ?? 1_000,
    readFile: file => {
      assert.equal(file, gatewayStatePath)

      return String(activity.gateway)
    },
    setTimer: (run, ms) => {
      const timer = { cancelled: false, ms, run }
      timers.push(timer)

      return timer
    },
    clearTimer: timer => {
      ;(timer as { cancelled: boolean }).cancelled = true
    },
    signal: controller.signal,
    skillsRoot: path.join(root, 'skills'),
    statePath,
    token: options.token ?? (() => JWT),
    windowTurns: () => activity.windowTurns,
    writeFileAtomic: (file, text) => fs.writeFileSync(file, text, 'utf8')
  })

  const liveTimers = () => timers.filter(timer => !timer.cancelled)

  const rig = {
    activity,
    calls,
    controller,
    editor,
    lines,
    refresher,
    root,
    statePath,
    writer,
    /** The installed platform category of one home, the profile stamp left out. */
    category: (home: string) =>
      Object.fromEntries(
        Object.entries(tree(path.join(home, 'skills', PLATFORM_SKILLS_CATEGORY))).filter(
          ([rel]) => rel !== PROFILE_SKILLS_STAMP
        )
      ),
    /** Every file of every home and the stored state: what "writes nothing" compares. */
    everything: () => ({ files: tree(root) }),
    stamp: (home: string) =>
      fs.readFileSync(path.join(home, 'skills', PLATFORM_SKILLS_CATEGORY, PROFILE_SKILLS_STAMP), 'utf8'),
    stored: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    probes: () => probes,
    serve: (next: () => unknown) => {
      reply = next
    },
    advance: (ms: number) => {
      clock += ms
    },
    async boot() {
      reply = () => M1
      await refresher.refresh('boot')
      calls.length = 0
      lines.length = 0
    },
    async focus() {
      focusListener()
      await refresher.settled()
      await refresher.settled()
    },
    /** Fire the one live timer, as its time came. */
    async tick() {
      const live = liveTimers()
      assert.equal(live.length, 1, `one live timer expected, found ${live.length}`)
      live[0].cancelled = true
      live[0].run()
      await refresher.settled()
      await refresher.settled()
    },
    liveTimers
  }

  return rig
}

const reviewVersion = (files: Record<string, string>) =>
  files['short-video-review/SKILL.md']?.match(/version: (\S+)/)?.[1]

// ── one request, and nothing written, while the manifest is the same ─────────

test.each([
  ['the server says unchanged', () => UNCHANGED('m1'), '[platform-skills] manifest m1 unchanged (focus)'],
  [
    'the server re-sends the same manifest',
    () => M1,
    '[platform-skills] manifest matches installed; no re-apply (focus)'
  ],
  [
    'the stored login JWT gets a 401',
    () => {
      const error: any = new Error('401: {"detail":"登录状态无效，请重新登录。"}')
      error.statusCode = 401
      throw error
    },
    '[platform-skills] fetch unavailable (401: {"detail":"登录状态无效，请重新登录。"}); keeping installed set'
  ],
  [
    'the network is down',
    () => {
      throw new Error('ECONNRESET')
    },
    '[platform-skills] fetch unavailable (ECONNRESET); keeping installed set'
  ],
  [
    'the body is garbage',
    () => '<html>bad gateway</html>',
    '[platform-skills] response body malformed; keeping installed set'
  ]
])('when %s, a running check costs one request and writes nothing', async (_label, reply, line) => {
  const rig = makeRig()
  await rig.boot()
  const before = rig.everything()

  rig.serve(reply)
  rig.advance(CHECK_EVERY_MS)
  await rig.focus()

  assert.equal(rig.calls.length, 1)
  assert.equal(rig.calls[0].bearer, JWT)
  assert.match(rig.calls[0].url, /\/api\/v1\/desktop\/platform-skills\?caps=[^&]+&known_hash=m1$/)
  assert.deepEqual(rig.everything(), before)
  assert.deepEqual(rig.lines, [line])
  assert.equal(rig.probes(), 0, 'nothing to install, so nobody is asked what runs')
})

// ── a new manifest, installed between turns ──────────────────────────────────

test('a new manifest lands in the root and every profile at once when nothing runs, like boot', async () => {
  const rig = makeRig()
  await rig.boot()
  assert.equal(reviewVersion(rig.category(rig.root)), '1.0.0')

  rig.serve(() => M2)
  rig.advance(CHECK_EVERY_MS)
  await rig.tick()

  for (const home of [rig.root, rig.writer, rig.editor]) {
    assert.equal(reviewVersion(rig.category(home)), '1.1.1', home)
    assert.equal(rig.category(home)['short-video-review/references/checklist.md'], 'checklist 1.1.1', home)
  }

  assert.deepEqual(rig.category(rig.writer), rig.category(rig.root))
  assert.equal(rig.stamp(rig.writer), 'm2\n')
  assert.equal(rig.stamp(rig.editor), 'm2\n')
  assert.deepEqual(rig.stored(), { count: 2, installedAt: T0 + CHECK_EVERY_MS, manifestHash: 'm2' })
  assert.equal(rig.calls.length, 1)
  assert.ok(rig.lines.includes('[platform-skills] installed 2 skill(s) manifest=m2 (interval)'), rig.lines.join('\n'))
  // The user's own skills stay as they were.
  assert.match(fs.readFileSync(path.join(rig.writer, 'skills', 'my-stuff', 'my-skill', 'SKILL.md'), 'utf8'), /mine in/)
})

test.each([
  ['a window runs a chat', (a: Activity) => (a.windowTurns = 1), '1 chat(s) running in a window'],
  [
    'an engine runs a turn',
    (a: Activity) => (a.snapshot = { detail: 'session:s1', idle: false, ok: true, reason: 'turn_in_flight' }),
    '1 of 1 engine(s) not idle (turn_in_flight)'
  ],
  [
    'an engine waits on the user',
    (a: Activity) => (a.snapshot = { idle: false, ok: true, reason: 'awaiting_human_input' }),
    '1 of 1 engine(s) not idle (awaiting_human_input)'
  ],
  [
    'an engine cannot prove it is idle',
    (a: Activity) => (a.snapshot = { idle: null, ok: true, reason: 'turn_probe_unavailable' }),
    '1 of 1 engine(s) not idle (turn_probe_unavailable)'
  ],
  [
    'an engine does not answer in time',
    (a: Activity) => (a.snapshot = 'never'),
    '1 of 1 engine(s) not idle (no answer)'
  ],
  [
    'the IM gateway has an agent at work',
    (a: Activity) => (a.gateway = JSON.stringify({ active_agents: 1, gateway_state: 'running' })),
    'messaging gateway busy (1 active)'
  ],
  [
    'the IM gateway state is unreadable',
    (a: Activity) => (a.gateway = '{"active_agents": '),
    'messaging gateway unreadable-state'
  ]
])(
  'while %s, a new manifest waits, then installs once it ends, without asking the server again',
  async (_label, busy, why) => {
    const rig = makeRig({ probeDeadlineMs: 20 })
    await rig.boot()
    const before = rig.everything()

    busy(rig.activity)
    rig.serve(() => M2)
    rig.advance(CHECK_EVERY_MS)
    await rig.focus()

    assert.deepEqual(rig.everything(), before, 'nothing is replaced under a running turn')
    assert.deepEqual(rig.lines, [`[platform-skills] manifest m2 waits until no turn runs: ${why} (focus)`])

    // It keeps asking every BUSY_RETRY_MS, quietly, and installs nothing while the turn runs.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.deepEqual(
        rig.liveTimers().map(timer => timer.ms),
        [BUSY_RETRY_MS]
      )
      await rig.tick()
    }

    assert.deepEqual(rig.everything(), before)
    assert.equal(rig.lines.length, 1)

    // The turn ends: the next retry installs what was fetched.
    Object.assign(rig.activity, { gateway: null, snapshot: IDLE_SNAPSHOT, windowTurns: 0 })
    await rig.tick()

    for (const home of [rig.root, rig.writer, rig.editor]) {
      assert.equal(reviewVersion(rig.category(home)), '1.1.1', home)
    }

    assert.equal(rig.stored().manifestHash, 'm2')
    assert.equal(rig.calls.length, 1, 'the wait costs no request')
    assert.ok(rig.lines.includes('[platform-skills] installed 2 skill(s) manifest=m2 (focus)'), rig.lines.join('\n'))
    assert.deepEqual(
      rig.liveTimers().map(timer => timer.ms),
      [TICK_MS],
      'back to the slow tick'
    )
  }
)

// ── when a check is due ──────────────────────────────────────────────────────

test('focus and the timer ask the server at most once per CHECK_EVERY_MS of wall-clock time', async () => {
  const rig = makeRig()
  await rig.boot()
  rig.serve(() => UNCHANGED('m1'))

  assert.deepEqual(
    rig.liveTimers().map(timer => timer.ms),
    [TICK_MS]
  )

  // Within the hour after boot: neither a focus nor a tick asks.
  rig.advance(CHECK_EVERY_MS - 1)
  await rig.focus()
  await rig.tick()
  assert.equal(rig.calls.length, 0)

  // Due: the first focus asks, the focus and tick right after do not.
  rig.advance(1)
  await rig.focus()
  await rig.focus()
  await rig.tick()
  assert.equal(rig.calls.length, 1)

  // A night asleep counts: the first tick after it asks.
  rig.advance(8 * CHECK_EVERY_MS)
  await rig.tick()
  assert.equal(rig.calls.length, 2)

  // A clock set back does not stall the checks.
  rig.advance(-3 * CHECK_EVERY_MS)
  await rig.tick()
  assert.equal(rig.calls.length, 3)
})

test('a burst of focus events while a check runs costs one request', async () => {
  const rig = makeRig()
  await rig.boot()
  const answer = deferred<unknown>()
  rig.serve(() => answer.promise)
  rig.advance(CHECK_EVERY_MS)

  const first = rig.focus()
  const more = [rig.focus(), rig.focus(), rig.focus()]
  answer.resolve(UNCHANGED('m1'))
  await Promise.all([first, ...more])

  assert.equal(rig.calls.length, 1)
})

test.each([
  ['signed out (no login JWT)', { token: () => '' }],
  ['the platform skills switch is off', { env: { APEXNODES_PLATFORM_SKILLS: '0' } }]
])('%s, the running check asks nothing and logs nothing', async (_label, options) => {
  const rig = makeRig(options)
  rig.serve(() => M2)
  rig.advance(CHECK_EVERY_MS)
  await rig.focus()
  rig.advance(CHECK_EVERY_MS)
  await rig.tick()

  assert.equal(rig.calls.length, 0)
  assert.deepEqual(rig.lines, [])
})

// ── boot, sign-in and the running check take turns ───────────────────────────

test('a sign-in refresh drops a manifest still waiting, and the older one never lands over it', async () => {
  const rig = makeRig()
  await rig.boot()
  rig.activity.windowTurns = 1
  rig.serve(() => M2)
  rig.advance(CHECK_EVERY_MS)
  await rig.focus()
  assert.equal(rig.stored().manifestHash, 'm1')

  // Sign-in installs at once, as before, whatever runs.
  rig.serve(() => M3)
  await rig.refresher.refresh('sign-in')
  assert.equal(reviewVersion(rig.category(rig.root)), '1.2.0')

  rig.activity.windowTurns = 0
  await rig.tick()

  assert.equal(rig.stored().manifestHash, 'm3')

  for (const home of [rig.root, rig.writer, rig.editor]) {
    assert.equal(reviewVersion(rig.category(home)), '1.2.0', home)
  }

  assert.equal(rig.lines.filter(line => / skill\(s\) manifest=/.test(line)).length, 1)
  assert.equal(rig.calls.length, 2)
  assert.match(rig.calls[1].url, /known_hash=m1$/, 'sign-in fetched against what was installed')
})

test('a sign-in asked while a retry is queued: the manifest that waited never installs', async () => {
  const rig = makeRig()
  await rig.boot()
  rig.activity.windowTurns = 1
  rig.serve(() => M2)
  rig.advance(CHECK_EVERY_MS)
  await rig.focus()

  // The turn ends and a retry is queued; the sign-in is asked before that retry runs.
  rig.activity.windowTurns = 0
  rig.serve(() => M3)
  const retry = rig.focus()
  const signIn = rig.refresher.refresh('sign-in')
  await Promise.all([retry, signIn])

  assert.deepEqual(
    rig.lines.filter(line => / skill\(s\) manifest=/.test(line)),
    ['[platform-skills] installed 1 skill(s) manifest=m3 (sign-in)']
  )
  assert.equal(rig.stored().manifestHash, 'm3')
})

test('a manifest whose base changed while it waited is dropped, not installed over the newer set', async () => {
  const rig = makeRig()
  await rig.boot()
  rig.activity.windowTurns = 1
  rig.serve(() => M2)
  rig.advance(CHECK_EVERY_MS)
  await rig.focus()

  // Another install lands meanwhile (the stored state moves on).
  fs.writeFileSync(rig.statePath, JSON.stringify({ count: 1, installedAt: 1, manifestHash: 'm3' }), 'utf8')
  rig.activity.windowTurns = 0
  await rig.tick()

  assert.equal(reviewVersion(rig.category(rig.root)), '1.0.0')
  assert.equal(rig.stored().manifestHash, 'm3')
  assert.ok(
    rig.lines.includes('[platform-skills] manifest m2 dropped: another install landed first (focus)'),
    rig.lines.join('\n')
  )
})

test('runs never overlap: a sign-in asked during a check fetches after it, against what it installed', async () => {
  const rig = makeRig()
  await rig.boot()
  const answer = deferred<unknown>()
  rig.serve(() => answer.promise)
  rig.advance(CHECK_EVERY_MS)

  const check = rig.focus()
  await Promise.resolve()
  const signIn = rig.refresher.refresh('sign-in')

  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(rig.calls.length, 1, 'the sign-in waits for the check in flight')

  rig.serve(() => UNCHANGED('m2'))
  answer.resolve(M2)
  await Promise.all([check, signIn])

  assert.equal(rig.calls.length, 2)
  assert.match(rig.calls[1].url, /known_hash=m2$/)
  assert.equal(rig.stored().manifestHash, 'm2')
})

test('a quit that starts while the engines are being asked stops the install', async () => {
  const rig = makeRig()
  await rig.boot()
  const answer = deferred<unknown>()
  rig.activity.snapshot = answer.promise
  rig.serve(() => M2)
  rig.advance(CHECK_EVERY_MS)

  const check = rig.focus()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(rig.probes(), 1, 'the engines are being asked')

  rig.controller.abort()
  answer.resolve(IDLE_SNAPSHOT)
  await check

  assert.equal(rig.stored().manifestHash, 'm1')
  assert.equal(reviewVersion(rig.category(rig.root)), '1.0.0')
})

test('once the quit teardown starts, a waiting manifest never installs and no timer is left', async () => {
  const rig = makeRig()
  await rig.boot()
  rig.activity.windowTurns = 1
  rig.serve(() => M2)
  rig.advance(CHECK_EVERY_MS)
  await rig.focus()

  rig.controller.abort()
  rig.activity.windowTurns = 0
  assert.deepEqual(rig.liveTimers(), [])

  rig.advance(CHECK_EVERY_MS)
  await rig.focus()

  assert.equal(rig.stored().manifestHash, 'm1')
  assert.equal(reviewVersion(rig.category(rig.root)), '1.0.0')
  assert.equal(rig.calls.length, 1)
  assert.deepEqual(rig.liveTimers(), [])
})

test('the M2 profile entry reads the same homes and the stored manifest, now', async () => {
  const rig = makeRig()
  await rig.boot()
  const args = rig.refresher.fillArgs()

  assert.equal(args.manifestHash, 'm1')
  assert.equal(args.skillsRoot, path.join(rig.root, 'skills'))
  assert.deepEqual(
    (args.homes as { profile: string }[]).map(home => home.profile),
    ['default', 'writer', 'editor']
  )
})
