import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { retirePackagedGateways } from './runtime-gateway-retirement'
import { isRuntimeUpdateBusy } from './runtime-update-busy'

// The wrapper's half of the RETIRE_GATEWAYS contract. The script's half (it
// prints APEX_RUNTIME_UPDATE_BUSY for a live turn and honours 'inspect') runs
// natively in runtime-gateway-retirement.test.ts. Only that marker may become
// the deferrable RuntimeUpdateBusy; any other failure stays a failure.
const execFile = vi.hoisted(() => vi.fn())

vi.mock(import('node:child_process'), async importOriginal => ({ ...(await importOriginal()), execFile }))

let activeRoot: string

beforeEach(() => {
  activeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-retire-receipt-'))
})

afterEach(() => {
  fs.rmSync(activeRoot, { recursive: true, force: true })
  execFile.mockReset()
})

function scriptExits(stderr: string) {
  execFile.mockImplementation((_file, _args, _options, callback) => {
    callback(Object.assign(new Error('Command failed'), { stderr }))
  })
}

test.each([
  [true, 'inspect'],
  [false, 'retire']
])('inspectOnly=%s runs the script in %s mode and returns its receipt', async (inspectOnly, mode) => {
  execFile.mockImplementation((_file, _args, _options, callback) => callback(null, { stderr: '', stdout: '[4242]\n' }))

  await expect(retirePackagedGateways(activeRoot, activeRoot, activeRoot, inspectOnly)).resolves.toEqual([4242])
  expect(execFile.mock.calls[0]?.[1]?.at(-1)).toBe(mode)
})

test.each([true, false])('a busy gateway defers the update (inspectOnly=%s)', async inspectOnly => {
  scriptExits('Traceback (most recent call last):\nRuntimeError: APEX_RUNTIME_UPDATE_BUSY\n')

  await expect(retirePackagedGateways(activeRoot, activeRoot, activeRoot, inspectOnly)).rejects.toMatchObject({
    code: 'runtime_update_busy'
  })
})

test('any other retirement failure is not mistaken for a busy engine', async () => {
  scriptExits('RuntimeError: Gateway identity could not be retired: PID 42\n')

  const failure = await retirePackagedGateways(activeRoot, activeRoot, activeRoot).catch(error => error)

  expect(failure).toBeInstanceOf(Error)
  expect(isRuntimeUpdateBusy(failure)).toBe(false)
})
