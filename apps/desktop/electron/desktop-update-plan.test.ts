import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import {
  clearDesktopUpdatePlan,
  normalizeDesktopUpdatePlan,
  readDesktopUpdatePlan,
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
  assert.deepEqual(readDesktopUpdatePlan(filePath), written)
})

test('desktop update plan rejects unknown schemas and clears idempotently', () => {
  const filePath = planPath()

  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 2, kind: 'runtime-after-shell' }))
  assert.equal(readDesktopUpdatePlan(filePath), null)
  assert.equal(normalizeDesktopUpdatePlan({ schemaVersion: 1, kind: 'other', requestedAt: 'now' }), null)

  clearDesktopUpdatePlan(filePath)
  clearDesktopUpdatePlan(filePath)
  assert.equal(fs.existsSync(filePath), false)
})

test('desktop update plan treats a truncated write as absent instead of blocking startup', () => {
  const filePath = planPath()

  fs.writeFileSync(filePath, '{"schemaVersion":1,"kind":')

  assert.equal(readDesktopUpdatePlan(filePath), null)
})
