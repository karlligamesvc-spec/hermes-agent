import { describe, expect, it } from 'vitest'

import {
  classifyEngineHolders,
  describeRuntimeUpdateBusy,
  endableTargets,
  type EngineHolderDetail,
  engineHolderIdentities,
  summarizeEngineHolders
} from './engine-holders'
import { RuntimeUpdateBusy } from './runtime-update-busy'

// hc-1094: which engine holders APEX may end. Only its own lost spawns: the exact gateway or engine
// command line Desktop runs, from the engine's interpreter, with the parent gone, plus what hangs
// off such a leftover. Every other shape is named and left alone.
const DESKTOP = 5000
const MAC_PY = '/Users/u/.apexnodes/hermes-agent/venv/bin/python'
const WIN_REDIRECTOR = 'C:\\Users\\u\\.apexnodes\\hermes-agent\\venv\\Scripts\\python.exe'
const WIN_WORKER = 'C:\\Users\\u\\.apexnodes\\hermes-agent\\.runtime\\py\\cpython-3.11.15\\python.exe'
const GATEWAY = ['-m', 'hermes_cli.main', 'gateway', 'run', '--replace']
const ENGINE = ['-m', 'hermes_cli.main', 'serve', '--host', '127.0.0.1', '--port', '0']

function holder(argv: string[], overrides: Partial<EngineHolderDetail> = {}): EngineHolderDetail {
  return { name: 'python3.11', ppid: 1, exe: argv[0]!, argv, created: 1_761_600_000.25, parent: 1, engineExe: true, ancestors: [{ pid: 1, name: 'launchd' }], ...overrides }
}

const shell = (name: string) => ({ parent: 700, ppid: 700, ancestors: [{ pid: 700, name }, { pid: 600, name: 'Terminal' }] })

describe('classifyEngineHolders on macOS', () => {
  it.each<[string, EngineHolderDetail, string, boolean]>([
    ['an orphaned Desktop gateway', holder([MAC_PY, ...GATEWAY]), 'leftover_gateway', true],
    ['an orphaned Desktop gateway for a profile', holder([MAC_PY, '-m', 'hermes_cli.main', '--profile', 'work', 'gateway', 'run', '--replace']), 'leftover_gateway', true],
    ['an orphaned Desktop engine', holder([MAC_PY, ...ENGINE]), 'leftover_engine', true],
    ['an orphaned pool engine for a profile', holder([MAC_PY, '-m', 'hermes_cli.main', '--profile', 'bot-2', ...ENGINE.slice(2)]), 'leftover_engine', true],
    ['an orphan whose parent psutil could not see', holder([MAC_PY, ...GATEWAY], { parent: null, ppid: 77 }), 'leftover_gateway', true],
    ['the same command run by another interpreter', holder(['/usr/bin/python3', ...GATEWAY], { engineExe: false }), 'other', false],
    ['the gateway command with one more argument', holder([MAC_PY, ...GATEWAY, '--verbose']), 'other', false],
    ['the gateway command without --replace', holder([MAC_PY, '-m', 'hermes_cli.main', 'gateway', 'run']), 'other', false],
    ['an engine on another port', holder([MAC_PY, '-m', 'hermes_cli.main', 'serve', '--host', '127.0.0.1', '--port', '8642']), 'other', false],
    ['an orphan without a start time', holder([MAC_PY, ...GATEWAY], { created: undefined }), 'other', false],
    ['a scan that did not report the parent', holder([MAC_PY, ...GATEWAY], { parent: undefined }), 'other', false],
    ['the Desktop gateway command typed in a terminal', holder([MAC_PY, ...GATEWAY], shell('zsh')), 'terminal_hermes', false],
    ['hermes chat in a login shell', holder([MAC_PY, '/Users/u/.apexnodes/hermes-agent/venv/bin/hermes', 'chat'], shell('-zsh')), 'terminal_hermes', false],
    ['hermes under tmux', holder([MAC_PY, '-m', 'hermes_cli.main', 'gateway', 'run'], { parent: 900, ancestors: [{ pid: 900, name: 'tmux' }, { pid: 1, name: 'launchd' }] }), 'terminal_hermes', false],
    ['a hermes command whose terminal is gone', holder([MAC_PY, '/Users/u/.local/bin/hermes', 'chat']), 'other', false],
    ['the Desktop gateway under another live APEX', holder([MAC_PY, ...GATEWAY], { parent: 4100, ancestors: [{ pid: 4100, name: 'APEX' }] }), 'other', false],
    ['an editor with its working directory in the engine', holder(['/Applications/Code.app/Contents/MacOS/Electron'], { name: 'Electron', engineExe: false, parent: 300, ancestors: [{ pid: 300, name: 'launchd' }] }), 'other', false],
    ['a child of this Desktop', holder([MAC_PY, ...ENGINE], { parent: DESKTOP, ancestors: [{ pid: DESKTOP, name: 'APEX' }] }), 'apex_running', false],
    ['a tool under this Desktop\'s engine', holder(['/bin/zsh', '-c', 'ls'], { parent: 5100, ancestors: [{ pid: 5100, name: 'python3.11' }, { pid: DESKTOP, name: 'APEX' }] }), 'apex_running', false]
  ])('%s', (_label, detail, kind, endable) => {
    expect(classifyEngineHolders({ 4242: detail }, { desktopPid: DESKTOP, platform: 'darwin' })[4242]).toEqual({ kind, endable })
  })

  it('a holder that hangs off a leftover belongs to it, through any depth', () => {
    const kinds = classifyEngineHolders(
      {
        4242: holder([MAC_PY, ...ENGINE]),
        4300: holder(['/usr/local/bin/node', '/Users/u/.apexnodes/hermes-agent/node_modules/mcp/server.js'], { parent: 4242, engineExe: false }),
        4301: holder(['/bin/sh', '-c', 'npx tool'], { parent: 4300, engineExe: false })
      },
      { desktopPid: DESKTOP, platform: 'darwin' }
    )

    expect(kinds).toEqual({
      4242: { kind: 'leftover_engine', endable: true },
      4300: { kind: 'leftover_engine', endable: true, leftover: 4242 },
      4301: { kind: 'leftover_engine', endable: true, leftover: 4242 }
    })
  })

  it('a child is not a leftover when its parent is not, or when it has no start time', () => {
    const kinds = classifyEngineHolders(
      {
        4242: holder([MAC_PY, ...GATEWAY], shell('zsh')),
        4300: holder(['/usr/local/bin/node', 'x.js'], { parent: 4242, engineExe: false }),
        4400: holder([MAC_PY, ...GATEWAY]),
        4401: holder(['/usr/local/bin/node', 'y.js'], { parent: 4400, engineExe: false, created: undefined })
      },
      { desktopPid: DESKTOP, platform: 'darwin' }
    )

    expect(kinds[4300]).toEqual({ kind: 'other', endable: false })
    expect(kinds[4401]).toEqual({ kind: 'other', endable: false })
  })

  it('a parent cycle in a stale scan ends the walk instead of looping', () => {
    const kinds = classifyEngineHolders(
      { 10: holder(['/x/node'], { parent: 11, engineExe: false }), 11: holder(['/x/node'], { parent: 10, engineExe: false }) },
      { desktopPid: DESKTOP, platform: 'darwin' }
    )

    expect(kinds).toEqual({ 10: { kind: 'other', endable: false }, 11: { kind: 'other', endable: false } })
  })

  it('a holder the scan could not inspect is another program', () => {
    expect(classifyEngineHolders({ 4444: undefined }, { desktopPid: DESKTOP, platform: 'darwin' })).toEqual({ 4444: { kind: 'other', endable: false } })
  })
})

describe('classifyEngineHolders on Windows', () => {
  it('the venv redirector and its worker are one leftover once Electron is gone', () => {
    const kinds = classifyEngineHolders(
      {
        700: holder([WIN_REDIRECTOR, ...GATEWAY], { name: 'python.exe', parent: null, ppid: 640, ancestors: [] }),
        701: holder([WIN_WORKER, ...GATEWAY], { name: 'python.exe', parent: 700, ppid: 700, ancestors: [{ pid: 700, name: 'python.exe' }] })
      },
      { desktopPid: DESKTOP, platform: 'win32' }
    )

    expect(kinds).toEqual({ 700: { kind: 'leftover_gateway', endable: true }, 701: { kind: 'leftover_gateway', endable: true, leftover: 700 } })
  })

  it('a worker whose redirector was ended is a leftover by itself', () => {
    expect(classifyEngineHolders({ 701: holder([WIN_WORKER, ...ENGINE], { name: 'python.exe', parent: null }) }, { desktopPid: DESKTOP, platform: 'win32' })[701]).toEqual({ kind: 'leftover_engine', endable: true })
  })

  it('pid 1 is no orphan marker on Windows', () => {
    expect(classifyEngineHolders({ 701: holder([WIN_WORKER, ...ENGINE], { name: 'python.exe', parent: 1 }) }, { desktopPid: DESKTOP, platform: 'win32' })[701]).toEqual({ kind: 'other', endable: false })
  })

  it.each(['cmd.exe', 'powershell.exe', 'pwsh.exe'])('hermes under %s is the user\'s terminal', name => {
    const detail = holder([WIN_WORKER, 'C:\\Users\\u\\.apexnodes\\hermes-agent\\venv\\Scripts\\hermes.exe', 'chat'], { name: 'python.exe', parent: 800, ancestors: [{ pid: 800, name }, { pid: 790, name: 'WindowsTerminal.exe' }] })

    expect(classifyEngineHolders({ 701: detail }, { desktopPid: DESKTOP, platform: 'win32' })[701]).toEqual({ kind: 'terminal_hermes', endable: false })
  })

  it('a live Desktop child stays APEX\'s running work', () => {
    const detail = holder([WIN_REDIRECTOR, ...ENGINE], { name: 'python.exe', parent: DESKTOP, ancestors: [{ pid: DESKTOP, name: 'APEX.exe' }] })

    expect(classifyEngineHolders({ 701: detail }, { desktopPid: DESKTOP, platform: 'win32' })[701]).toEqual({ kind: 'apex_running', endable: false })
  })
})

function busy(holders: Record<number, unknown>) {
  return Object.assign(new RuntimeUpdateBusy(`Waiting for engine workers: ${Object.keys(holders).join(', ')}`, 'engine_holders'), { idleProof: { holders } })
}

describe('deferral descriptions', () => {
  it('logs each holder with its kind, endability and leftover', () => {
    const error = busy({
      700: { ...holder([MAC_PY, ...GATEWAY]), kind: 'leftover_gateway', endable: true },
      701: { ...holder(['/x/node']), name: 'node', exe: '/x/node', kind: 'leftover_gateway', endable: true, leftover: 700 },
      702: undefined
    })

    expect(describeRuntimeUpdateBusy(error)).toBe(
      `engine_holders: Waiting for engine workers: 700, 701, 702 [700 python3.11 (${MAC_PY}) leftover_gateway endable; 701 node (/x/node) leftover_gateway endable of 700; 702 ?]`
    )
  })

  it('keeps the hc-1030 line for holders the gate did not classify', () => {
    expect(describeRuntimeUpdateBusy(busy({ 1347: { name: 'python3.12', ppid: 1, exe: '/p', argv: [] } }))).toBe(
      'engine_holders: Waiting for engine workers: 1347 [1347 python3.12 (/p)]'
    )
    expect(describeRuntimeUpdateBusy(new RuntimeUpdateBusy())).toBe('active_work: Waiting for existing APEX work to finish.')
  })

  it('summarizes classified holders for the renderer, a hermes command by that name', () => {
    const error = busy({
      700: { ...holder([MAC_PY, ...GATEWAY]), kind: 'leftover_gateway', endable: true },
      800: { ...holder([MAC_PY, '/u/venv/bin/hermes', 'chat']), kind: 'terminal_hermes', endable: false },
      801: { ...holder([MAC_PY, '/u/venv/bin/hermes', 'chat']), kind: 'other', endable: false },
      900: { ...holder(['/Applications/Code.app/Contents/MacOS/Electron']), name: 'Code Helper', created: undefined, kind: 'other', endable: false },
      901: undefined
    })

    expect(summarizeEngineHolders(error)).toEqual([
      { pid: 700, kind: 'leftover_gateway', name: 'hermes', created: 1_761_600_000.25, endable: true },
      { pid: 800, kind: 'terminal_hermes', name: 'hermes', created: 1_761_600_000.25, endable: false },
      { pid: 801, kind: 'other', name: 'hermes', created: 1_761_600_000.25, endable: false },
      { pid: 900, kind: 'other', name: 'Code Helper', created: null, endable: false },
      { pid: 901, kind: 'other', name: null, created: null, endable: false }
    ])
  })

  it.each([
    ['another busy reason', new RuntimeUpdateBusy()],
    ['no holders', busy({})],
    ['holders without a kind', busy({ 1347: { name: 'python3.12', ppid: 1, exe: '/p', argv: [] } })]
  ])('summarizes nothing for %s', (_label, error) => {
    expect(summarizeEngineHolders(error)).toBeNull()
  })
})

describe('end requests', () => {
  const holders = {
    700: { ...holder([MAC_PY, ...GATEWAY]), kind: 'leftover_gateway' as const, endable: true },
    701: { ...holder(['/x/node']), exe: '/x/node', created: 5.5, kind: 'leftover_gateway' as const, endable: true, leftover: 700 },
    800: { ...holder([MAC_PY, '/u/venv/bin/hermes', 'chat']), kind: 'terminal_hermes' as const, endable: false }
  }

  it('reads only whole PID and start-time pairs from the renderer', () => {
    expect(engineHolderIdentities([{ pid: 700, created: 1.5 }, { pid: '701', created: 2 }, { pid: 0, created: 1 }, { pid: 3 }, null, { pid: 4.5, created: 1 }])).toEqual([{ pid: 700, created: 1.5 }])
    expect(engineHolderIdentities('700')).toEqual([])
  })

  it('ends only endable holders the user confirmed with the same start time, leftovers first', () => {
    expect(endableTargets(holders, [{ pid: 701, created: 5.5 }, { pid: 700, created: 1_761_600_000.25 }, { pid: 800, created: 1_761_600_000.25 }])).toEqual([
      { pid: 700, created: 1_761_600_000.25, exe: MAC_PY, kind: 'leftover_gateway', leftover: undefined },
      { pid: 701, created: 5.5, exe: '/x/node', kind: 'leftover_gateway', leftover: 700 }
    ])
  })

  it('a reused PID (another start time) is not the confirmed process', () => {
    expect(endableTargets(holders, [{ pid: 700, created: 1_761_600_999 }])).toEqual([])
  })
})
