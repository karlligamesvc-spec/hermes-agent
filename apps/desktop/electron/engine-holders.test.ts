import { describe, expect, it } from 'vitest'

import {
  type ClassifiedHolder,
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

// hc-1117: what an engine background command looks like once the engine is gone. zsh execs a plain
// command, so the command itself is the orphan; bash or a pipeline keeps the shell in between.
const MAC_FFMPEG = '/Users/u/.apexnodes/versions/abc/.runtime/bin/ffmpeg'
const MAC_REAL_PY = '/Users/u/.apexnodes/versions/abc/.runtime/py/cpython-3.14.7-macos-aarch64-none/bin/python3.14'
const command = (argv: string[], overrides: Partial<EngineHolderDetail> = {}) => holder(argv, { name: 'python3.14', engineRuntime: true, ...overrides })
const underShells = (...names: string[]) => ({ parent: 700, ppid: 700, ancestors: [...names.map((name, index) => ({ pid: 700 + index, name })), { pid: 1, name: 'launchd' }, { pid: 0, name: 'kernel_task' }] })
const LOST_ZSH = { name: 'zsh', exe: '/bin/zsh', argv: ['/bin/zsh', '-lic', 'set +m; python3 render.py | cat'], engineExe: false, engineRuntime: false }

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

  it.each<[string, EngineHolderDetail, string, boolean]>([
    ['an orphaned script on the engine interpreter', command([MAC_PY, 'render.py']), 'leftover_child', true],
    ['an orphan whose argv[0] is a bare name, by its bundled executable', command(['python3', 'render.py'], { exe: MAC_REAL_PY }), 'leftover_child', true],
    ['an orphan psutil found no parent for', command([MAC_PY, 'render.py'], { parent: null, ppid: 77 }), 'leftover_child', true],
    ['an orphaned bundled tool', command([MAC_FFMPEG, '-i', 'a.mp4', 'b.mp4'], { name: 'ffmpeg', exe: MAC_FFMPEG }), 'leftover_child', true],
    ['a command under the engine\'s lost shell', command([MAC_PY, 'render.py'], underShells('zsh')), 'leftover_child', true],
    ['a command under a login-style lost shell', command([MAC_PY, 'render.py'], underShells('-bash')), 'leftover_child', true],
    ['a command under nested lost shells', command([MAC_PY, 'render.py'], underShells('sh', 'bash')), 'leftover_child', true],
    ['a command under a lost shell where nothing is listed above init', command([MAC_PY, 'render.py'], { parent: 700, ancestors: [{ pid: 700, name: 'bash' }, { pid: 1, name: 'init' }] }), 'leftover_child', true],
    ['another interpreter, orphaned', holder(['/usr/bin/python3', 'render.py'], { engineExe: false }), 'other', false],
    ['a file elsewhere in the engine, orphaned', holder(['/Users/u/.apexnodes/hermes-agent/node_modules/.bin/esbuild'], { name: 'esbuild' }), 'other', false],
    ['an engine command with no start time', command([MAC_PY, 'render.py'], { created: undefined }), 'other', false],
    ['an engine command whose parent the scan did not report', command([MAC_PY, 'render.py'], { parent: undefined, ancestors: undefined }), 'other', false],
    ['an engine command in a terminal', command([MAC_PY, 'render.py'], { ...underShells('-zsh', 'login', 'Terminal') }), 'other', false],
    ['an engine command in tmux', command([MAC_PY, 'render.py'], underShells('zsh', 'tmux')), 'other', false],
    ['an engine command over ssh', command([MAC_PY, 'render.py'], underShells('zsh', 'sshd')), 'other', false],
    ['an engine command under a live program', command([MAC_PY, 'render.py'], { parent: 800, ancestors: [{ pid: 800, name: 'node' }, { pid: 1, name: 'launchd' }] }), 'other', false],
    ['an engine command under a shell under a live program', command([MAC_PY, 'render.py'], underShells('zsh', 'Code Helper')), 'other', false],
    ['an engine command under another live APEX', command([MAC_PY, 'render.py'], { parent: 4100, ancestors: [{ pid: 4100, name: 'APEX' }] }), 'other', false],
    ['an engine command whose ancestors the scan cut off', command([MAC_PY, 'render.py'], { parent: 700, ancestors: [{ pid: 700, name: 'zsh' }, { pid: 701, name: 'zsh' }, { pid: 702, name: 'zsh' }, { pid: 703, name: 'zsh' }] }), 'other', false],
    ['a background command of this Desktop\'s own engine', command([MAC_PY, 'render.py'], { parent: 700, ancestors: [{ pid: 700, name: 'zsh' }, { pid: 701, name: 'python3.14' }, { pid: DESKTOP, name: 'APEX' }] }), 'apex_running', false],
    ['hermes typed in a terminal stays the terminal\'s', command([MAC_PY, '/Users/u/.apexnodes/hermes-agent/venv/bin/hermes', 'chat'], shell('-zsh')), 'terminal_hermes', false],
    ['hermes under a lost shell is not ended', command([MAC_PY, '-m', 'hermes_cli.main', 'chat'], underShells('zsh')), 'terminal_hermes', false],
    ['an orphaned hermes service is not ended', command([MAC_PY, '-m', 'hermes_cli.main', 'gateway', 'run']), 'other', false],
    ['the gateway command with one more argument, on the engine runtime', command([MAC_PY, ...GATEWAY, '--verbose']), 'other', false]
  ])('hc-1117: %s', (_label, detail, kind, endable) => {
    expect(classifyEngineHolders({ 4242: detail }, { desktopPid: DESKTOP, platform: 'darwin' })[4242]).toEqual({ kind, endable })
  })

  it('hc-1117: what a leftover command started goes with it, through a process that holds nothing', () => {
    const kinds = classifyEngineHolders(
      {
        4242: command([MAC_PY, 'render.py']),
        4243: holder(['/usr/local/bin/ffmpeg', '-i', 'a.mp4'], { name: 'ffmpeg', engineExe: false, parent: 4242 }),
        4244: holder(['/usr/local/bin/node', 'x.js'], { name: 'node', engineExe: false, parent: 4300, ancestors: [{ pid: 4300, name: 'sh' }, { pid: 4242, name: 'python3.14' }, { pid: 1, name: 'launchd' }] })
      },
      { desktopPid: DESKTOP, platform: 'darwin' }
    )

    expect(kinds).toEqual({
      4242: { kind: 'leftover_child', endable: true },
      4243: { kind: 'leftover_child', endable: true, leftover: 4242 },
      4244: { kind: 'leftover_child', endable: true, leftover: 4242 }
    })
  })

  it('hc-1117: the lost shell and a pipeline neighbour, holding the engine by their working directory, go with the command', () => {
    const kinds = classifyEngineHolders(
      {
        700: holder(LOST_ZSH.argv, LOST_ZSH),
        701: command([MAC_PY, 'render.py'], underShells('zsh')),
        702: holder(['cat'], { name: 'cat', exe: '/bin/cat', engineExe: false, ...underShells('zsh') })
      },
      { desktopPid: DESKTOP, platform: 'darwin' }
    )

    expect(kinds).toEqual({
      700: { kind: 'leftover_child', endable: true, leftover: 701 },
      701: { kind: 'leftover_child', endable: true },
      702: { kind: 'leftover_child', endable: true, leftover: 701 }
    })
  })

  it('hc-1117: a lost shell with no engine command under it is only named', () => {
    expect(classifyEngineHolders({ 700: holder(LOST_ZSH.argv, LOST_ZSH) }, { desktopPid: DESKTOP, platform: 'darwin' })[700]).toEqual({ kind: 'other', endable: false })
  })

  it('hc-1117: a lost shell without a start time is only named, while the command under it is a leftover', () => {
    const kinds = classifyEngineHolders(
      { 700: holder(LOST_ZSH.argv, { ...LOST_ZSH, created: undefined }), 701: command([MAC_PY, 'render.py'], underShells('zsh')) },
      { desktopPid: DESKTOP, platform: 'darwin' }
    )

    expect(kinds).toEqual({ 700: { kind: 'other', endable: false }, 701: { kind: 'leftover_child', endable: true } })
  })

  it('hc-1117: a shell in a terminal, and the engine command in it, are nobody\'s leftover', () => {
    const terminal = { parent: 600, ppid: 600, ancestors: [{ pid: 600, name: 'Terminal' }, { pid: 1, name: 'launchd' }] }
    const kinds = classifyEngineHolders(
      { 700: holder(LOST_ZSH.argv, { ...LOST_ZSH, ...terminal }), 701: command([MAC_PY, 'render.py'], { parent: 700, ppid: 700, ancestors: [{ pid: 700, name: 'zsh' }, ...terminal.ancestors] }) },
      { desktopPid: DESKTOP, platform: 'darwin' }
    )

    expect(kinds).toEqual({ 700: { kind: 'other', endable: false }, 701: { kind: 'other', endable: false } })
  })

  it('hc-1117: whatever else a stale scan lists above a leftover command is not swept along', () => {
    const kinds = classifyEngineHolders(
      { 1: holder(['/sbin/launchd'], { name: 'launchd', exe: '/sbin/launchd', engineExe: false, parent: null, ancestors: [] }), 701: command([MAC_PY, 'render.py']) },
      { desktopPid: DESKTOP, platform: 'darwin' }
    )

    expect(kinds).toEqual({ 1: { kind: 'other', endable: false }, 701: { kind: 'leftover_child', endable: true } })
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

  it('hc-1117: an orphaned command is a leftover, its redirector\'s worker with it', () => {
    const kinds = classifyEngineHolders(
      {
        700: command([WIN_REDIRECTOR, 'render.py'], { name: 'python.exe', parent: null, ppid: 640, ancestors: [] }),
        701: command([WIN_WORKER, 'render.py'], { name: 'python.exe', parent: 700, ppid: 700, ancestors: [{ pid: 700, name: 'python.exe' }] })
      },
      { desktopPid: DESKTOP, platform: 'win32' }
    )

    expect(kinds).toEqual({ 700: { kind: 'leftover_child', endable: true }, 701: { kind: 'leftover_child', endable: true, leftover: 700 } })
  })

  it.each<[string, Partial<EngineHolderDetail>, string, boolean]>([
    ['under Git Bash with the engine gone', { parent: 800, ancestors: [{ pid: 800, name: 'bash.exe' }, { pid: 790, name: 'bash.exe' }] }, 'leftover_child', true],
    ['in a console window', { parent: 800, ancestors: [{ pid: 800, name: 'cmd.exe' }, { pid: 790, name: 'WindowsTerminal.exe' }] }, 'other', false],
    ['in a console whose host is gone', { parent: 800, ancestors: [{ pid: 800, name: 'cmd.exe' }] }, 'other', false],
    ['in PowerShell whose host is gone', { parent: 800, ancestors: [{ pid: 800, name: 'pwsh.exe' }] }, 'other', false],
    ['under bash under a live program', { parent: 800, ancestors: [{ pid: 800, name: 'bash.exe' }, { pid: 790, name: 'Code.exe' }] }, 'other', false],
    ['under shells the scan cut off', { parent: 800, ancestors: [800, 801, 802, 803].map(pid => ({ pid, name: 'bash.exe' })) }, 'other', false],
    ['with pid 1 as a live parent', { parent: 1, ancestors: [{ pid: 1, name: 'svchost.exe' }] }, 'other', false],
    ['under bash under a live pid 1', { parent: 800, ancestors: [{ pid: 800, name: 'bash.exe' }, { pid: 1, name: 'svchost.exe' }] }, 'other', false]
  ])('hc-1117: a command %s', (_label, overrides, kind, endable) => {
    const detail = command([WIN_REDIRECTOR, 'render.py'], { name: 'python.exe', ...overrides })

    expect(classifyEngineHolders({ 701: detail }, { desktopPid: DESKTOP, platform: 'win32' })[701]).toEqual({ kind, endable })
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
      `engine_holders: Waiting for engine workers: 700, 701, 702 [700 python3.11 (~/.apexnodes/hermes-agent/venv/bin/python) leftover_gateway endable argv=[~/.apexnodes/hermes-agent/venv/bin/python ${GATEWAY.join(' ')}]; 701 node (/x/node) leftover_gateway endable of 700 argv=[/x/node]; 702 ?]`
    )
  })

  it('hc-1117: logs and summarizes a leftover command by its own name', () => {
    const error = busy({
      700: { ...command([MAC_PY, 'render.py']), kind: 'leftover_child', endable: true },
      701: { ...holder(['/x/ffmpeg']), name: 'ffmpeg', exe: '/x/ffmpeg', kind: 'leftover_child', endable: true, leftover: 700 }
    })

    expect(describeRuntimeUpdateBusy(error)).toBe(
      'engine_holders: Waiting for engine workers: 700, 701 [700 python3.14 (~/.apexnodes/hermes-agent/venv/bin/python) leftover_child endable argv=[~/.apexnodes/hermes-agent/venv/bin/python render.py]; 701 ffmpeg (/x/ffmpeg) leftover_child endable of 700 argv=[/x/ffmpeg]]'
    )
    expect(summarizeEngineHolders(error)).toEqual([
      { pid: 700, kind: 'leftover_child', name: 'python3.14', created: 1_761_600_000.25, endable: true },
      { pid: 701, kind: 'leftover_child', name: 'ffmpeg', created: 1_761_600_000.25, endable: true }
    ])
  })

  // The holder a stuck Mac logged on 10-30 as `other`: PPID 1, exe in `versions/<key>/.runtime`.
  it('hc-1117: the shape from the field is a leftover, and its line says so without the user name', () => {
    const exe = '/Users/jo/.apexnodes/versions/d6af670cd6a9/.runtime/py/cpython-3.14.7-macos-aarch64-none/bin/python3.14'
    const detail = command(['/Users/jo/.apexnodes/hermes-agent/venv/bin/python', '/Users/jo/Movies/render.py', '--api-key', '[REDACTED]'], { exe })
    const kinds = classifyEngineHolders({ 65414: detail }, { desktopPid: DESKTOP, platform: 'darwin' })

    expect(kinds[65414]).toEqual({ kind: 'leftover_child', endable: true })
    expect(describeRuntimeUpdateBusy(busy({ 65414: { ...detail, ...kinds[65414] } }))).toBe(
      'engine_holders: Waiting for engine workers: 65414 [65414 python3.14 (~/.apexnodes/versions/d6af670cd6a9/.runtime/py/cpython-3.14.7-macos-aarch64-none/bin/python3.14) leftover_child endable argv=[~/.apexnodes/hermes-agent/venv/bin/python ~/Movies/render.py --api-key [REDACTED]]]'
    )
  })

  it.each<[string, Partial<ClassifiedHolder>, string[], null | string]>([
    ['another program: its command line is not this log\'s business', { engineExe: false, kind: 'other', endable: false }, ['/Applications/Code.app/Code', '/Users/jo/work/secret-project'], null],
    ['hermes typed in a terminal: nor is that', { engineExe: true, kind: 'terminal_hermes', endable: false }, [MAC_PY, '/u/venv/bin/hermes', 'chat', '-q', 'what I typed'], null],
    ['an engine process with a live parent', { engineExe: true, kind: 'other', endable: false }, ['/e/venv/bin/python', 'x.py'], '/e/venv/bin/python x.py'],
    ['a tool that belongs to a leftover', { engineExe: false, kind: 'leftover_child', endable: true, leftover: 9 }, ['/usr/bin/ffmpeg', '-i', 'a.mp4'], '/usr/bin/ffmpeg -i a.mp4'],
    ['a Windows path', { engineExe: true, kind: 'other', endable: false }, ['C:\\Users\\jo\\.apexnodes\\hermes-agent\\venv\\Scripts\\python.exe', 'x.py'], '~\\.apexnodes\\hermes-agent\\venv\\Scripts\\python.exe x.py'],
    ['a Linux path', { engineExe: true, kind: 'other', endable: false }, ['/home/jo/.apexnodes/hermes-agent/venv/bin/python'], '~/.apexnodes/hermes-agent/venv/bin/python'],
    ['a bare token nothing names', { engineExe: true, kind: 'other', endable: false }, ['/e/python', 'x.py', 'sk-abcdefghijklmnopqrstuvwxyz0123456789'], '/e/python x.py [REDACTED]'],
    ['more arguments than the line keeps', { engineExe: true, kind: 'other', endable: false }, ['/e/python', ...Array.from({ length: 12 }, (_, index) => `a${index}`)], '/e/python a0 a1 a2 a3 a4 a5 a6'],
    ['a long argument', { engineExe: true, kind: 'other', endable: false }, ['/e/python', '-c', `${'import a; '.repeat(20)}`], `/e/python -c ${'import a; '.repeat(8)}`]
  ])('hc-1117: the log line for %s', (_label, overrides, argv, logged) => {
    const line = describeRuntimeUpdateBusy(busy({ 700: { ...holder(argv), exe: '/x', ...overrides } as ClassifiedHolder }))

    if (logged === null) {
      expect(line).not.toContain('argv=')
      expect(line).not.toContain(argv[1]!)
    } else {
      expect(line).toContain(` argv=[${logged}]`)
    }
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
