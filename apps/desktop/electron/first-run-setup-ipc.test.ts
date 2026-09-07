import assert from 'node:assert/strict'

import { test } from 'vitest'

import { createFirstRunSetupGate } from './first-run-setup-gate'
import { continueLocalBootstrapIpc } from './first-run-setup-ipc'

const bootstrapBackend = {
  activeRoot: '/tmp/hermes-home/hermes-agent',
  kind: 'bootstrap-needed',
  platform: 'linux'
}

test('continue-local IPC releases an existing first-run waiter', async () => {
  const gate = createFirstRunSetupGate({ stuckAfterMs: 0 })
  const pending = gate.wait(bootstrapBackend)

  assert.equal(gate.hasWaiter(), true)
  assert.deepEqual(await continueLocalBootstrapIpc(gate.continueLocal), { ok: true })
  assert.equal(await pending, 'continue-local')
  assert.equal(gate.hasWaiter(), false)
  assert.equal(gate.isLocalBootstrapConfirmed(), true)
})
