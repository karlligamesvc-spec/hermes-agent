import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import {
  createQuitConfirm,
  type DialogParent,
  ENDING_MS,
  engineWorkCount,
  type LocalEngine,
  localEnginesOf,
  type QuitConfirmDeps,
  type QuitDialogOptions
} from './apex-quit-confirm'
import type { ActiveWork } from './quit-guard'

// Shapes `GET /api/health/idle` answers with (tests/hermes_cli/test_web_server_idle_proof.py).
const IDLE = { ok: true, idle: true, reason: null }
const TWO_CHATS = { ok: true, idle: false, reason: 'turn_in_flight', detail: 'session:s1,s2' }
const CRON = { ok: true, idle: false, reason: 'turn_in_flight', detail: 'cron:live-idle-proof-job' }
const WAITING_ON_USER = { ok: true, idle: false, reason: 'awaiting_human_input' }
const UNPROVABLE = { ok: true, idle: null, reason: 'turn_probe_unavailable' }

describe('engineWorkCount', () => {
  test.each([
    ['idle', IDLE, 0],
    ['two chats mid-turn', TWO_CHATS, 2],
    ['a cron run', CRON, 1],
    ['a prompt waiting on the user', WAITING_ON_USER, 1],
    ['an engine that cannot prove it is idle', UNPROVABLE, 1],
    ['an empty session ledger', { ok: true, idle: false, reason: 'turn_in_flight', detail: 'session:' }, 1],
    [
      'the retirement admission',
      { ok: true, idle: false, reason: 'turn_in_flight', detail: 'retirement_admission' },
      1
    ],
    ['no answer', undefined, 0],
    ['null', null, 0],
    ['a string', 'busy', 0],
    ['a snapshot without ok', { idle: false }, 0],
    ['a refused snapshot', { ok: false, idle: false }, 0],
    ['an unknown idle value', { ok: true, idle: 'no' }, 0]
  ])('%s', (_name, snapshot, count) => {
    assert.equal(engineWorkCount(snapshot), count)
  })
})

describe('localEnginesOf', () => {
  const pooled = [
    { port: 9101, process: {}, token: 'pool-a' },
    { port: null, process: null, token: null }, // a remote descriptor
    { port: 9102, process: null, token: 'gone' }, // its child already exited
    { port: 9103, process: {}, token: 'pool-b' }
  ]

  const local = { baseUrl: 'http://127.0.0.1:9100', mode: 'local', token: 'primary' }

  test('the primary engine Desktop spawned, then every pooled engine with a child', async () => {
    assert.deepEqual(await localEnginesOf({ connection: Promise.resolve(local), owned: true }, pooled), [
      { baseUrl: 'http://127.0.0.1:9100', token: 'primary' },
      { baseUrl: 'http://127.0.0.1:9101', token: 'pool-a' },
      { baseUrl: 'http://127.0.0.1:9103', token: 'pool-b' }
    ])
  })

  test.each([
    ['adopted, not spawned by Desktop', () => ({ connection: Promise.resolve(local), owned: false })],
    ['still booting', () => ({ connection: null, owned: true })],
    ['remote', () => ({ connection: Promise.resolve({ ...local, mode: 'remote' }), owned: true })],
    ['failed to connect', () => ({ connection: Promise.reject(new Error('boot failed')), owned: true })]
  ])('leaves out a primary engine that is %s', async (_name, primary) => {
    assert.deepEqual(await localEnginesOf(primary(), []), [])
  })
})

interface Harness {
  confirm: ReturnType<typeof createQuitConfirm<FakeWindow>>
  dialogs: { options: QuitDialogOptions; parent: FakeWindow | null; respond: (response: number) => void }[]
  events: string[]
  probes: string[]
  quits: () => number
  tick: (ms: number) => void
}

class FakeWindow implements DialogParent {
  constructor(
    readonly name: string,
    private readonly visible = true,
    private readonly destroyed = false
  ) {}

  isDestroyed = () => this.destroyed
  isVisible = () => this.visible
}

interface Setup {
  isMac?: boolean
  skip?: boolean
  reporters?: number
  work?: ActiveWork
  parent?: FakeWindow | null
  engines?: LocalEngine[] | Error
  answers?: Record<string, (() => Promise<unknown>) | unknown>
  probeDeadlineMs?: number
  log?: (line: string) => void
}

const ENGINE_A = { baseUrl: 'http://127.0.0.1:9100', token: 'a' }
const ENGINE_B = { baseUrl: 'http://127.0.0.1:9101', token: 'b' }

function harness(setup: Setup = {}): Harness {
  let clock = 1_000_000
  let quits = 0
  const events: string[] = []
  const probes: string[] = []
  const dialogs: Harness['dialogs'] = []

  const deps: QuitConfirmDeps<FakeWindow> = {
    isMac: setup.isMac ?? true,
    skip: () => setup.skip ?? false,
    windowWork: () => ({ reporters: setup.reporters ?? 0, work: setup.work ?? { count: 0, titles: [] } }),
    parent: () => (setup.parent === undefined ? null : setup.parent),
    engines: async () => {
      if (setup.engines instanceof Error) {
        throw setup.engines
      }

      return setup.engines ?? [ENGINE_A]
    },
    probe: async engine => {
      probes.push(engine.baseUrl)
      const answer = setup.answers?.[engine.baseUrl]

      return typeof answer === 'function' ? (answer as () => Promise<unknown>)() : answer
    },
    showMessageBox: (parent, options) =>
      new Promise(resolve => dialogs.push({ options, parent, respond: response => resolve({ response }) })),
    focusApp: () => events.push('focus'),
    quit: () => {
      quits += 1
      events.push('quit')
    },
    log: setup.log ?? (() => undefined),
    now: () => clock,
    probeDeadlineMs: setup.probeDeadlineMs
  }

  return {
    confirm: createQuitConfirm(deps),
    dialogs,
    events,
    probes,
    quits: () => quits,
    tick: ms => {
      clock += ms
    }
  }
}

function beforeQuit(h: Harness): boolean {
  let prevented = false
  const held = h.confirm.hold({ preventDefault: () => (prevented = true) })

  assert.equal(prevented, held, 'a held quit must be prevented, and only a held one')

  return held
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('with a window reporting (unchanged from quit-guard)', () => {
  const window = new FakeWindow('APEX')

  test('a running turn asks on that window; Keep Running keeps the app, Quit Anyway quits once', async () => {
    const h = harness({ parent: window, reporters: 1, work: { count: 1, titles: ['剪辑'] } })

    assert.equal(beforeQuit(h), true)
    assert.equal(h.dialogs.length, 1)
    assert.equal(h.dialogs[0].parent, window)
    assert.deepEqual(h.dialogs[0].options.buttons, ['Keep Running', 'Quit Anyway'])
    assert.deepEqual(
      [h.dialogs[0].options.cancelId, h.dialogs[0].options.defaultId],
      [0, 0],
      'Keep Running is the default'
    )
    assert.equal(h.dialogs[0].options.message, 'Hermes is still working on 1 chat.')
    assert.deepEqual(h.probes, [], 'the engines are not asked while a window reports')

    h.dialogs[0].respond(0)
    await settle()
    assert.equal(h.quits(), 0)

    assert.equal(beforeQuit(h), true)
    h.dialogs[1].respond(1)
    await settle()
    assert.equal(h.quits(), 1)
    assert.equal(beforeQuit(h), false, 'the quit Quit Anyway starts goes to the teardown')
    assert.deepEqual(h.events, ['quit'], 'a dialog on a window does not pull the app forward')
  })

  test('an idle window lets the quit through without asking the engines', async () => {
    const h = harness({ parent: window, reporters: 1, answers: { [ENGINE_A.baseUrl]: TWO_CHATS } })

    assert.equal(beforeQuit(h), false)
    await settle()
    assert.deepEqual(h.probes, [])
    assert.equal(h.dialogs.length, 0)
  })

  test('a window going away mid-turn lets the quit through, as before', async () => {
    const h = harness({
      parent: new FakeWindow('APEX', true, true),
      reporters: 1,
      work: { count: 1, titles: [] },
      answers: { [ENGINE_A.baseUrl]: TWO_CHATS }
    })

    assert.equal(beforeQuit(h), false)
    await settle()
    assert.deepEqual(h.probes, [])
  })

  test('a dialog that fails to show still quits', async () => {
    const h = harness({ parent: window, reporters: 1, work: { count: 1, titles: [] } })

    const confirm = createQuitConfirm({
      isMac: true,
      skip: () => false,
      windowWork: () => ({ reporters: 1, work: { count: 1, titles: [] } }),
      parent: () => window,
      engines: async () => [],
      probe: async () => undefined,
      showMessageBox: () => Promise.reject(new Error('no dialog')),
      focusApp: () => undefined,
      quit: () => h.events.push('quit'),
      log: () => undefined
    })

    assert.equal(confirm.hold({ preventDefault: () => undefined }), true)
    await settle()
    assert.deepEqual(h.events, ['quit'])
    assert.equal(confirm.hold({ preventDefault: () => undefined }), false)
  })
})

describe('on macOS with no window reporting', () => {
  test('busy engines hold the quit for the same confirmation, with no parent window, in front', async () => {
    const h = harness({
      engines: [ENGINE_A, ENGINE_B],
      answers: { [ENGINE_A.baseUrl]: TWO_CHATS, [ENGINE_B.baseUrl]: IDLE }
    })

    assert.equal(beforeQuit(h), true)
    await settle()
    assert.deepEqual(h.probes, [ENGINE_A.baseUrl, ENGINE_B.baseUrl])
    assert.equal(h.dialogs.length, 1)
    assert.equal(h.dialogs[0].parent, null)
    assert.equal(h.dialogs[0].options.message, 'Hermes is still working on 2 chats.')
    assert.match(h.dialogs[0].options.detail, /Quitting stops the agent mid-turn/)
    assert.deepEqual(h.events, ['focus'])

    h.dialogs[0].respond(0)
    await settle()
    assert.equal(h.quits(), 0, 'Keep Running leaves the app in the Dock')

    assert.equal(beforeQuit(h), true, 'the next quit asks the engines again')
    await settle()
    assert.equal(h.probes.length, 4)
    h.dialogs[1].respond(1)
    await settle()
    assert.equal(h.quits(), 1)
    assert.equal(beforeQuit(h), false)
  })

  test.each([
    ['a cron run', CRON],
    ['a prompt waiting on the user', WAITING_ON_USER],
    ['an engine that cannot prove it is idle', UNPROVABLE]
  ])('%s asks too', async (_name, answer) => {
    const h = harness({ answers: { [ENGINE_A.baseUrl]: answer } })

    assert.equal(beforeQuit(h), true)
    await settle()
    assert.equal(h.dialogs[0].options.message, 'Hermes is still working on 1 chat.')
  })

  test.each([
    ['idle engines', { answers: { [ENGINE_A.baseUrl]: IDLE } }],
    ['no engine', { engines: [] }],
    ['engines that cannot be listed', { engines: new Error('pool gone') }],
    ['an engine without the route', { answers: { [ENGINE_A.baseUrl]: () => Promise.reject(new Error('HTTP 404')) } }],
    [
      'an engine that is not listening',
      { answers: { [ENGINE_A.baseUrl]: () => Promise.reject(new Error('ECONNREFUSED')) } }
    ],
    [
      'an engine past the deadline',
      { answers: { [ENGINE_A.baseUrl]: () => new Promise(() => undefined) }, probeDeadlineMs: 5 }
    ]
  ])('%s: the quit goes ahead without asking', async (_name, setup: Setup) => {
    const h = harness(setup)

    assert.equal(beforeQuit(h), true)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(h.dialogs.length, 0)
    assert.deepEqual(h.events, ['quit'])
    assert.equal(beforeQuit(h), false, 'the quit it starts goes to the teardown')
  })

  test('a visible window that does not report yet (a reopened one still loading) carries the dialog', async () => {
    const loading = new FakeWindow('APEX')
    const h = harness({ parent: loading, answers: { [ENGINE_A.baseUrl]: TWO_CHATS } })

    assert.equal(beforeQuit(h), true)
    await settle()
    assert.equal(h.dialogs[0].parent, loading)
    assert.deepEqual(h.events, [])
  })

  test('a hidden window does not carry the dialog', async () => {
    const h = harness({ parent: new FakeWindow('helper', false), answers: { [ENGINE_A.baseUrl]: TWO_CHATS } })

    assert.equal(beforeQuit(h), true)
    await settle()
    assert.equal(h.dialogs[0].parent, null)
  })

  test('quits while the engines are asked are held, and the engines are asked once', async () => {
    let answer: (snapshot: unknown) => void = () => undefined
    const pending = new Promise(resolve => (answer = resolve))
    const h = harness({ answers: { [ENGINE_A.baseUrl]: () => pending } })

    assert.equal(beforeQuit(h), true)
    await settle()
    assert.equal(beforeQuit(h), true)
    await settle()
    assert.deepEqual(h.probes, [ENGINE_A.baseUrl])

    answer(IDLE)
    await settle()
    await settle()
    assert.deepEqual(h.events, ['quit'])
  })

  test('a hand-off quit that starts while the engines are asked goes through without the dialog', async () => {
    let answer: (snapshot: unknown) => void = () => undefined
    const pending = new Promise(resolve => (answer = resolve))
    const setup: Setup = { answers: { [ENGINE_A.baseUrl]: () => pending } }
    const h = harness(setup)

    assert.equal(beforeQuit(h), true)
    setup.skip = true
    answer(TWO_CHATS)
    await settle()
    await settle()
    assert.equal(h.dialogs.length, 0)
    assert.deepEqual(h.events, ['quit'])
  })

  test('an engine check that breaks still quits', async () => {
    const h = harness({
      answers: { [ENGINE_A.baseUrl]: TWO_CHATS },
      log: () => {
        throw new Error('log is gone')
      }
    })

    assert.equal(beforeQuit(h), true)
    await settle()
    await settle()
    assert.equal(h.dialogs.length, 0)
    assert.deepEqual(h.events, ['quit'])
  })
})

describe('quits that never ask', () => {
  test('Windows and Linux do not ask the engines (the last window closing is the quit there)', async () => {
    const h = harness({ isMac: false, answers: { [ENGINE_A.baseUrl]: TWO_CHATS } })

    assert.equal(beforeQuit(h), false)
    await settle()
    assert.deepEqual(h.probes, [])
  })

  test.each([
    [
      'with a window reporting a turn',
      { parent: new FakeWindow('APEX'), reporters: 1, work: { count: 1, titles: [] } }
    ],
    ['with busy engines', { answers: { [ENGINE_A.baseUrl]: TWO_CHATS } }]
  ])('skipped (HERMES_DESKTOP_SKIP_QUIT_CONFIRM, a hand-off quit) %s', async (_name, setup: Setup) => {
    const h = harness({ ...setup, skip: true })

    assert.equal(beforeQuit(h), false)
    await settle()
    assert.deepEqual(h.probes, [])
    assert.equal(h.dialogs.length, 0)
  })

  test.each([
    [
      'with a window reporting a turn',
      { parent: new FakeWindow('APEX'), reporters: 1, work: { count: 1, titles: [] } }
    ],
    ['with busy engines', { answers: { [ENGINE_A.baseUrl]: TWO_CHATS } }]
  ])(
    'the session ending (logout, shutdown, update install) %s, until ENDING_MS has passed',
    async (_name, setup: Setup) => {
      const h = harness(setup)

      h.confirm.sessionEnding()
      assert.equal(beforeQuit(h), false)
      await settle()
      assert.deepEqual(h.probes, [])
      assert.equal(h.dialogs.length, 0)

      h.tick(ENDING_MS)
      assert.equal(beforeQuit(h), true, 'a session that did not end asks again')
    }
  )

  test('the session starting to end while the engines are asked quits without the dialog', async () => {
    let answer: (snapshot: unknown) => void = () => undefined
    const pending = new Promise(resolve => (answer = resolve))
    const h = harness({ answers: { [ENGINE_A.baseUrl]: () => pending } })

    assert.equal(beforeQuit(h), true)
    h.confirm.sessionEnding()
    answer(TWO_CHATS)
    await settle()
    await settle()
    assert.equal(h.dialogs.length, 0)
    assert.deepEqual(h.events, ['quit'])
  })

  test('watchSessionEnd: NSWorkspaceWillPowerOff and before-quit-for-update both end the session', () => {
    const listeners: Record<string, () => void> = {}

    for (const source of ['workspace', 'updater'] as const) {
      const h = harness({ parent: new FakeWindow('APEX'), reporters: 1, work: { count: 1, titles: [] } })

      h.confirm.watchSessionEnd({
        updater: { on: (event, listener) => (listeners[`updater:${event}`] = listener) },
        workspace: {
          subscribeWorkspaceNotification: (event, callback) => {
            listeners[`workspace:${event}`] = callback

            return 1
          }
        }
      })

      listeners[
        source === 'workspace' ? 'workspace:NSWorkspaceWillPowerOffNotification' : 'updater:before-quit-for-update'
      ]()
      assert.equal(beforeQuit(h), false, `${source} did not end the session`)
    }
  })

  test('watchSessionEnd survives a source that throws, and works without the macOS one', () => {
    const lines: string[] = []
    let updaterWatched = false

    const confirm = createQuitConfirm({
      isMac: false,
      skip: () => false,
      windowWork: () => ({ reporters: 0, work: { count: 0, titles: [] } }),
      parent: () => null,
      engines: async () => [],
      probe: async () => undefined,
      showMessageBox: async () => ({ response: 0 }),
      focusApp: () => undefined,
      quit: () => undefined,
      log: line => lines.push(line)
    })

    confirm.watchSessionEnd({
      updater: { on: () => (updaterWatched = true) },
      workspace: {
        subscribeWorkspaceNotification: () => {
          throw new Error('not on this platform')
        }
      }
    })
    confirm.watchSessionEnd({ updater: { on: () => undefined } })

    assert.equal(updaterWatched, true)
    assert.equal(lines.length, 1)
  })
})
