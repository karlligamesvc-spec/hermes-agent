import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

const electron = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), sendSync: vi.fn(() => ({})) }))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke, sendSync: electron.sendSync },
  webFrame: {},
  webUtils: {}
}))

test('the actual preload carries frozen runtime targets to Electron without changing ordinary no-target calls', async () => {
  await import('./preload')
  const bridge = electron.expose.mock.calls.find(([name]) => name === 'hermesDesktop')?.[1]
  const expectedTarget = { expectedKey: 'a'.repeat(40), expectedVersion: 'v2026.10.1-fork.fixture' }

  assert.ok(bridge)
  await bridge.runtime.applyUpdate(expectedTarget)
  assert.deepEqual(electron.invoke.mock.calls[0], ['hermes:runtime:apply-update', expectedTarget])
  await bridge.runtime.applyUpdate()
  assert.deepEqual(electron.invoke.mock.calls[1], ['hermes:runtime:apply-update', undefined])
})
