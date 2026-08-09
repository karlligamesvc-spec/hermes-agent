import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import {
  clearDesktopUpdatePlan,
  normalizeDesktopUpdatePlan,
  readDesktopUpdatePlan,
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
