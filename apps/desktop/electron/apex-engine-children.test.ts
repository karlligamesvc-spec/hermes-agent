import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { afterEach, describe, test } from 'vitest'

import {
  endEngineChildren,
  type EngineChild,
  type EngineChildrenDeps,
  engineDescendants,
  isMessagingGateway,
  nodeEngineChildrenDeps,
  parseProcessRows,
  snapshotEngineChildren
} from './apex-engine-children'

const AT = 'Tue Oct 28 10:01:07 2026'
const LATER = 'Tue Oct 28 10:09:59 2026'

const ENGINE =
  '/Users/u/.apexnodes/hermes-agent/venv/bin/python -m hermes_cli.main --profile clip serve --host 127.0.0.1 --port 0'

const GATEWAY = '/Users/u/.apexnodes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run --replace'

/** `ps -A -ww -o pid=,ppid=,pgid=,lstart=,args=` as macOS prints it (day of month padded). */
function ps(rows: Array<[pid: number, ppid: number, pgid: number, command: string, started?: string]>): string {
  return rows
    .map(
      ([pid, ppid, pgid, command, started = AT]) =>
        `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(pgid).padStart(5)} ${started}     ${command}`
    )
    .join('\n')
}

// Desktop 100 (its own group) → engine 200 (setsid by Desktop) → background shell 300
// (setsid by the engine) → ffmpeg 301; a foreground command 400 in its own group with 401
// under it; an MCP server 500 in the engine's group; the gateway 600 and its tool 601.
const TREE = ps([
  [1, 0, 1, '/sbin/launchd'],
  [100, 1, 100, '/Applications/APEX.app/Contents/MacOS/APEX'],
  [200, 100, 200, ENGINE],
  [300, 200, 300, '/bin/zsh -lic set +m; ffmpeg -i qa-20min.mp4 out.mp4'],
  [301, 300, 300, '/Users/u/.apexnodes/hermes-agent/bin/ffmpeg -i qa-20min.mp4 out.mp4'],
  [400, 200, 400, '/bin/zsh -lic sleep 300'],
  [401, 400, 400, 'sleep 300'],
  [500, 200, 200, 'node mcp-server.js'],
  [600, 100, 600, GATEWAY],
  [601, 600, 601, '/bin/zsh -lic ffmpeg -version'],
  [700, 1, 700, '/usr/bin/some-other-app']
])

describe('who the engines started', () => {
  test('reads macOS and Linux lstart rows, padded days included', () => {
    const rows = parseProcessRows(ps([[42, 1, 42, '/bin/sh -c x', 'Thu Oct  8 06:01:02 2026']]))

    assert.deepEqual(rows, [
      { command: '/bin/sh -c x', pgid: 42, pid: 42, ppid: 1, started: 'Thu Oct  8 06:01:02 2026' }
    ])
  })

  test('every descendant of the engines, with whether it leads its own group', () => {
    const found = engineDescendants(parseProcessRows(TREE), [200], 100)

    assert.deepEqual(
      found.map(child => [child.pid, child.leadsGroup, child.name]),
      [
        [300, true, 'zsh'],
        [400, true, 'zsh'],
        [500, false, 'node'],
        [301, false, 'ffmpeg'],
        [401, false, 'sleep']
      ]
    )
  })

  test('never the messaging gateway, nor anything under it, even when an engine started it', () => {
    const tree = parseProcessRows(TREE).map(row => (row.pid === 600 ? { ...row, ppid: 200 } : row))
    const pids = engineDescendants(tree, [200], 100).map(child => child.pid)

    assert.ok(!pids.includes(600))
    assert.ok(!pids.includes(601))
  })

  test('never this Desktop or its process group', () => {
    const tree = parseProcessRows(
      ps([
        [100, 1, 100, 'APEX'],
        [200, 100, 200, ENGINE],
        [250, 200, 100, 'odd child in the Desktop group']
      ])
    )

    assert.deepEqual(engineDescendants(tree, [200], 100), [])
  })

  test.each([
    [GATEWAY, true],
    ['/v/bin/python -m hermes_cli.main --profile clip gateway run --replace', true],
    ['/v/bin/hermes -p clip gateway run', true],
    ['/v/bin/hermes gateway status', true],
    [ENGINE, false],
    ['/v/bin/python -m hermes_cli.main serve --host 127.0.0.1 --port 0', false],
    ['/bin/zsh -lic echo gateway', false],
    ['ffmpeg -i gateway.mp4 out.mp4', false]
  ])('isMessagingGateway(%s) = %s', (command, expected) => {
    assert.equal(isMessagingGateway(command), expected)
  })

  test('Windows: nothing to snapshot, taskkill /T already ends the tree', () => {
    let listed = false

    const children = snapshotEngineChildren([{ pid: 200 }], {
      ...fakeDeps(TREE),
      listProcesses: () => {
        listed = true

        return TREE
      },
      platform: 'win32'
    })

    assert.deepEqual(children, [])
    assert.equal(listed, false)
  })

  test('no live engine, or ps failing, is an empty snapshot rather than an error', () => {
    assert.deepEqual(snapshotEngineChildren([null, { pid: undefined }, { pid: 1 }], fakeDeps(TREE)), [])
    assert.deepEqual(
      snapshotEngineChildren([{ pid: 200 }], {
        ...fakeDeps(TREE),
        listProcesses: () => {
          throw new Error('ps: not found')
        }
      }),
      []
    )
  })
})

interface Signal {
  pid: number
  signal: NodeJS.Signals
}

function fakeDeps(text: string, onKill?: (signal: Signal) => void): EngineChildrenDeps & { signals: Signal[] } {
  const signals: Signal[] = []

  return {
    kill: (pid, signal) => {
      signals.push({ pid, signal })
      onKill?.({ pid, signal })
    },
    listProcesses: () => text,
    platform: 'darwin',
    selfPid: 100,
    signals,
    sleep: async () => undefined
  }
}

describe('ending them once the engines are down', () => {
  const orphaned = (rows: string) => rows.replace(/^(\s*30[01]\s+)200/m, '$1    1')

  test('a group leader is signalled as its group, a lone child by itself; gone after SIGTERM, no SIGKILL', async () => {
    const snapshot = engineDescendants(parseProcessRows(TREE), [200], 100)
    let rows = orphaned(TREE)
    const deps = fakeDeps('', () => (rows = ps([[1, 0, 1, '/sbin/launchd']])))
    deps.listProcesses = () => rows

    const logged: string[] = []
    const ended = await endEngineChildren(snapshot, line => logged.push(line), deps)

    assert.deepEqual(
      deps.signals.map(({ pid, signal }) => `${signal} ${pid}`),
      ['SIGTERM -300', 'SIGTERM -400', 'SIGTERM 500', 'SIGTERM 301', 'SIGTERM 401']
    )
    assert.equal(ended.length, 5)
    assert.match(
      logged[0],
      /ending 5 process\(es\) the engines started: zsh\(300\), zsh\(400\), node\(500\), ffmpeg\(301\)/
    )
  })

  test('what ignores SIGTERM gets SIGKILL after the grace period', async () => {
    const snapshot: EngineChild[] = [{ leadsGroup: true, name: 'zsh', pid: 300, started: AT }]
    const deps = fakeDeps(ps([[300, 1, 300, '/bin/zsh -lic trap "" TERM; sleep 600']]))

    await endEngineChildren(snapshot, undefined, deps, 300)

    assert.deepEqual(
      deps.signals.map(({ pid, signal }) => `${signal} ${pid}`),
      ['SIGTERM -300', 'SIGKILL -300']
    )
  })

  test('a pid now held by another process (other start time) is left alone', async () => {
    const snapshot: EngineChild[] = [{ leadsGroup: true, name: 'zsh', pid: 300, started: AT }]
    const deps = fakeDeps(ps([[300, 1, 300, '/usr/bin/unrelated', LATER]]))

    assert.deepEqual(await endEngineChildren(snapshot, undefined, deps), [])
    assert.deepEqual(deps.signals, [])
  })

  test('nothing left: no signal, no log line', async () => {
    const logged: string[] = []
    const deps = fakeDeps(ps([[1, 0, 1, '/sbin/launchd']]))

    assert.deepEqual(await endEngineChildren([], line => logged.push(line), deps), [])
    assert.deepEqual(
      await endEngineChildren(
        [{ leadsGroup: true, name: 'zsh', pid: 300, started: AT }],
        line => logged.push(line),
        deps
      ),
      []
    )
    assert.deepEqual(deps.signals, [])
    assert.deepEqual(logged, [])
  })
})

// The bug itself, with real processes: an "engine" starts a background shell in a
// session of its own (what `terminal(background=true)` does), the engine's group is
// killed the way the quit teardown kills it, and the shell lives on under pid 1.
describe.skipIf(process.platform === 'win32')('real processes', () => {
  const started: number[] = []

  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  })

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)

      return true
    } catch {
      return false
    }
  }

  async function until(check: () => boolean, ms = 5000) {
    for (let waited = 0; waited < ms && !check(); waited += 50) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    return check()
  }

  test('the background shell outlives the engine group kill, and the sweep ends it', async () => {
    const engineScript = [
      "const { spawn } = require('node:child_process')",
      "const bg = spawn('/bin/sh', ['-c', 'sleep 120 & wait'], { detached: true, stdio: 'ignore' })",
      'process.stdout.write(String(bg.pid) + "\\n")',
      'setInterval(() => {}, 1000)'
    ].join('; ')

    const engine = spawn(process.execPath, ['-e', engineScript], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })

    started.push(engine.pid!)

    const shellPid = await new Promise<number>(resolve =>
      engine.stdout!.once('data', chunk => resolve(Number(String(chunk).trim())))
    )

    started.push(shellPid)
    assert.ok(await until(() => snapshotEngineChildren([engine]).some(child => child.name === 'sleep')))

    const snapshot = snapshotEngineChildren([engine])
    assert.ok(
      snapshot.some(child => child.pid === shellPid && child.leadsGroup),
      JSON.stringify(snapshot)
    )
    const sleeper = snapshot.find(child => child.name === 'sleep')
    assert.ok(sleeper, JSON.stringify(snapshot))

    process.kill(-engine.pid!, 'SIGTERM')
    assert.ok(await until(() => !alive(engine.pid!)))
    assert.ok(alive(shellPid), 'the background shell survives its engine, as the M7 ffmpeg did')
    assert.ok(alive(sleeper.pid))

    const ended = await endEngineChildren(snapshot, undefined, nodeEngineChildrenDeps())

    assert.ok(ended.some(child => child.pid === shellPid))
    assert.ok(await until(() => !alive(shellPid) && !alive(sleeper.pid)))
  })
})
