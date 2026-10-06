import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import {
  clearDesktopUpdatePlan,
  normalizeDesktopUpdatePlan,
  readDesktopUpdatePlan,
  readPreparedDesktopUpdatePlan,
  transitionDesktopUpdatePlan,
  writeDesktopUpdatePlan
} from './desktop-update-plan'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

function planPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-update-plan-'))

  roots.push(root)

  return path.join(root, '.desktop-update-plan.json')
}

test('desktop update plan survives a process restart and keeps only bounded version labels', () => {
  const filePath = planPath()

  const written = writeDesktopUpdatePlan(filePath, {
    kind: 'runtime-after-shell',
    targetShellVersion: ' 0.18.0 ',
    targetRuntimeVersion: ' v2026.8.8-fork.abc '
  })

  assert.equal(written.targetShellVersion, '0.18.0')
  assert.equal(written.targetRuntimeVersion, 'v2026.8.8-fork.abc')
  assert.equal(written.phase, 'ready-to-restart')
  assert.ok(written.planId)
  assert.deepEqual(readDesktopUpdatePlan(filePath), written)
})

test('desktop update plan rejects unknown schemas and clears idempotently', () => {
  const filePath = planPath()

  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 2, kind: 'runtime-after-shell' }))
  assert.equal(readDesktopUpdatePlan(filePath), null)
  assert.equal(normalizeDesktopUpdatePlan({ schemaVersion: 1, kind: 'other', requestedAt: new Date().toISOString() }), null)

  clearDesktopUpdatePlan(filePath)
  clearDesktopUpdatePlan(filePath)
  assert.equal(fs.existsSync(filePath), false)
})

test('desktop update plan treats a truncated write as absent instead of blocking startup', () => {
  const filePath = planPath()

  fs.writeFileSync(filePath, '{"schemaVersion":1,"kind":')

  assert.equal(readDesktopUpdatePlan(filePath), null)
})

test('desktop update plan migrates the first-batch schema in memory', () => {
  const requestedAt = new Date().toISOString()

  assert.deepEqual(
    normalizeDesktopUpdatePlan({
      schemaVersion: 1,
      kind: 'runtime-after-shell',
      requestedAt,
      targetRuntimeVersion: 'v2026.8.8',
      targetShellVersion: '0.18.0'
    }),
    {
      schemaVersion: 1,
      planId: null,
      kind: 'runtime-after-shell',
      phase: 'ready-to-restart',
      requestedAt,
      createdAt: requestedAt,
      updatedAt: requestedAt,
      currentShellVersion: null,
      targetShellVersion: '0.18.0',
      currentRuntimeKey: null,
      currentRuntimeVersion: null,
      targetRuntimeKey: null,
      targetRuntimeVersion: 'v2026.8.8',
      attempts: 0,
      lastError: null
    }
  )
})

test('desktop update plan quarantines corrupt state instead of retrying it on every launch', () => {
  const filePath = planPath()
  const quarantined: Array<{ path: string; reason: string }> = []

  fs.writeFileSync(filePath, '{"schemaVersion":1,"kind":')

  assert.equal(
    readDesktopUpdatePlan(filePath, {
      quarantineInvalid: true,
      onQuarantine: (quarantinePath, reason) => quarantined.push({ path: quarantinePath, reason })
    }),
    null
  )
  assert.equal(fs.existsSync(filePath), false)
  assert.equal(quarantined.length, 1)
  assert.equal(quarantined[0]?.reason, 'invalid_json')
  assert.equal(fs.readFileSync(quarantined[0]!.path, 'utf8'), '{"schemaVersion":1,"kind":')
})

test('desktop update plan persists resume attempts and a bounded failure', () => {
  const filePath = planPath()

  writeDesktopUpdatePlan(filePath, {
    kind: 'shell-only',
    currentShellVersion: '0.17.14',
    targetShellVersion: '0.17.15'
  })
  const resuming = transitionDesktopUpdatePlan(filePath, { incrementAttempt: true, phase: 'resuming' })

  const failed = transitionDesktopUpdatePlan(filePath, {
    lastError: `network:${'x'.repeat(800)}`,
    phase: 'failed'
  })

  assert.equal(resuming?.attempts, 1)
  assert.equal(failed?.attempts, 1)
  assert.equal(failed?.phase, 'failed')
  assert.equal(failed?.lastError?.length, 512)
  assert.deepEqual(readDesktopUpdatePlan(filePath), failed)
})

test.each([
  { outcome: 'installed', accept: true },
  { outcome: 'current', accept: true },
  { outcome: 'preserved', accept: false },
  { outcome: 'no-install', accept: false },
  { outcome: 'marker-mismatch', accept: false },
  { outcome: 'tree-mismatch', accept: false },
  { outcome: 'older-shell', accept: false },
  { outcome: 'unknown-shell', accept: false },
  { outcome: 'explicit-engine', accept: false },
  { outcome: 'runtime-after-shell', accept: false }
] as const)('bundled shell handoff reconciles only verified activation: $outcome', async ({ outcome, accept }) => {
  const filePath = planPath()
  const oldCommit = 'a'.repeat(40)
  const newCommit = 'b'.repeat(40)

  const original = writeDesktopUpdatePlan(filePath, {
    kind: outcome === 'runtime-after-shell' ? 'runtime-after-shell' : 'shell-only',
    currentShellVersion: '0.17.46',
    targetShellVersion: '0.17.47',
    currentRuntimeKey: oldCommit,
    currentRuntimeVersion: 'old engine',
    targetRuntimeKey: outcome === 'explicit-engine' ? 'c'.repeat(40) : oldCommit,
    targetRuntimeVersion: 'old engine'
  })

  const originalBytes = fs.readFileSync(filePath, 'utf8')

  const next = await readPreparedDesktopUpdatePlan(filePath, {
    waitForRuntimePreparation: async () => {},
    preparedRuntime: async () => outcome === 'no-install' ? null : {
      status: outcome === 'preserved' ? 'preserved' : outcome === 'current' ? 'current' : 'installed',
      runtimeCommit: newCommit
    },
    desktopVersion: () => outcome === 'older-shell' ? '0.17.46' : outcome === 'unknown-shell' ? 'unknown' : '0.17.48',
    readMarker: () => ({ pinnedCommit: outcome === 'marker-mismatch' ? oldCommit : newCommit, version: 'bundled engine' }),
    readTreeCommit: () => outcome === 'tree-mismatch' ? oldCommit : newCommit
  })

  if (accept) {
    assert.equal(next?.targetRuntimeKey, newCommit)
    assert.equal(next?.targetRuntimeVersion, 'bundled engine')
    assert.equal(next?.planId, original.planId)
    assert.equal(next?.currentRuntimeKey, oldCommit)
    assert.equal(next?.requestedAt, original.requestedAt)
    assert.deepEqual(readDesktopUpdatePlan(filePath), next)
  } else {
    assert.deepEqual(next, original)
    assert.equal(fs.readFileSync(filePath, 'utf8'), originalBytes)
  }
})
