import type * as childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { assertPackagedRuntimeIdle } from './packaged-runtime'
import { isRuntimeUpdateBusy } from './runtime-update-busy'

// Desktop's half of the idle probe contract: the busy proof it builds from the probe's report.
// The probe itself scans real processes natively in packaged-runtime.test.ts. A holder can be any
// process on the machine, so the proof names it without a credential from its argv.
const probe = vi.hoisted(() => {
  const report = { pid: 0, stdout: '' }

  // assertPackagedRuntimeIdle takes its own scanner's PID from the promisified execFile's child.
  const execFile = Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: () =>
      Object.assign(Promise.resolve({ stdout: report.stdout, stderr: '' }), { child: { pid: report.pid } })
  })

  return { execFile, report }
})

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof childProcess>()),
  execFile: probe.execFile
}))

let activeRoot: string

beforeEach(() => {
  activeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-idle-proof-'))
})

afterEach(() => {
  fs.rmSync(activeRoot, { recursive: true, force: true })
})

test('a busy proof names each holder without the secrets in its argv', async () => {
  const python = '/opt/tools/bin/python3'
  const node = '/usr/local/bin/node'
  probe.report.pid = 900
  probe.report.stdout = JSON.stringify({
    // The scanner itself (900) and a gateway the switch retires (950) are not holders.
    holders: [900, 950, 4242, 4343, 4444],
    details: {
      950: { name: 'python3', ppid: 1, exe: python, argv: [python, '-m', 'hermes_cli.main', 'gateway', 'run'] },
      4242: { name: 'python3', ppid: 1, exe: python, argv: [python, 'mcp_server.py', '--api-key', 'fixture-secret', '--port', '8642'] },
      4343: { name: 'node', ppid: 4242, exe: node, argv: [node, 'worker.js', 'OPENAI_API_KEY=fixture-secret'] }
      // 4444 denied the probe access to its details.
    },
    workerPid: 901
  })

  const failure = await assertPackagedRuntimeIdle(activeRoot, activeRoot, { retiringGatewayPids: [950] }).catch(error => error)

  expect(isRuntimeUpdateBusy(failure)).toBe(true)
  expect(failure.message).toBe('Waiting for engine workers: 4242, 4343, 4444')
  expect(failure.reason).toBe('engine_holders')
  expect(failure.idleProof).toEqual({
    ownedProbePid: 900,
    workerPid: 901,
    rawHolderPids: [900, 950, 4242, 4343, 4444],
    holderPids: [4242, 4343, 4444],
    holders: {
      4242: { name: 'python3', ppid: 1, exe: python, argv: [python, 'mcp_server.py', '--api-key', '[REDACTED]', '--port', '8642'], kind: 'other', endable: false },
      4343: { name: 'node', ppid: 4242, exe: node, argv: [node, 'worker.js', 'OPENAI_API_KEY=[REDACTED]'], kind: 'other', endable: false },
      4444: undefined
    }
  })
  expect(JSON.stringify(failure.idleProof)).not.toContain('fixture-secret')
})

test('hc-1094: the busy proof sorts each holder into what the user is told and what APEX may end', async () => {
  const root = path.join(activeRoot, 'venv', 'bin', 'python')
  const gateway = [root, '-m', 'hermes_cli.main', 'gateway', 'run', '--replace']
  const base = { name: 'python3.11', exe: root, engineExe: true, created: 1_761_600_000.5 }
  probe.report.pid = 900
  probe.report.stdout = JSON.stringify({
    holders: [900, 1347, 1400, 2001, process.pid + 1],
    details: {
      1347: { ...base, ppid: 1, parent: 1, argv: gateway, ancestors: [{ pid: 1, name: 'launchd' }] },
      1400: { ...base, name: 'node', exe: '/usr/local/bin/node', engineExe: false, ppid: 1347, parent: 1347, argv: ['/usr/local/bin/node', 'mcp.js', '--token', 'fixture-secret'], ancestors: [{ pid: 1347, name: 'python3.11' }, { pid: 1, name: 'launchd' }] },
      2001: { ...base, ppid: 700, parent: 700, argv: [root, path.join(activeRoot, 'venv', 'bin', 'hermes'), 'chat'], ancestors: [{ pid: 700, name: '-zsh' }, { pid: 1, name: 'launchd' }] },
      [process.pid + 1]: { ...base, ppid: process.pid, parent: process.pid, argv: [root, '-m', 'hermes_cli.main', 'serve', '--host', '127.0.0.1', '--port', '0'], ancestors: [{ pid: process.pid, name: 'APEX' }] }
    },
    workerPid: 901
  })

  const failure = await assertPackagedRuntimeIdle(activeRoot, activeRoot).catch(error => error)
  const kinds = Object.fromEntries(Object.entries(failure.idleProof.holders).map(([pid, holder]: [string, any]) => [pid, [holder.kind, holder.endable, holder.leftover]]))

  expect(failure.reason).toBe('engine_holders')
  expect(kinds).toEqual({
    1347: ['leftover_gateway', true, undefined],
    1400: ['leftover_gateway', true, 1347],
    2001: ['terminal_hermes', false, undefined],
    [process.pid + 1]: ['apex_running', false, undefined]
  })
  expect(JSON.stringify(failure.idleProof)).not.toContain('fixture-secret')
})
