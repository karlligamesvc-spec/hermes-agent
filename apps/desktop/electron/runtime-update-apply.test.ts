import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import { checkForRuntimeUpdate, derivePinFromLatest, resolveLatestRuntimePin } from './apex-runtime-latest'
import { applyRuntimeUpdateToLatest } from './runtime-update-apply'

const checked = { upstream_commit: 'a'.repeat(40), version: 'v2026.10.1-fork.fixture' }
const changed = { ...checked, upstream_commit: 'b'.repeat(40) }

test.each([changed, { ...checked, version: 'v2026.10.2-fork.fixture' }])(
  'a changed checked target is rejected before any bundle, override or marker mutation (%j)',
  async actualLatest => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-update-target-'))

    const files = {
      marker: path.join(home, '.hermes-bootstrap-complete'),
      override: path.join(home, '.apexnodes-runtime-override.json'),
      bundle: path.join(home, '.apexnodes-runtime-current.json')
    }

    const writes: string[] = []
    let latest = checked
    let fetches = 0

    const fetchJson = async () => {
      fetches += 1

      return latest
    }

    for (const [name, file] of Object.entries(files)) {
      fs.writeFileSync(file, `original-${name}`)
    }

    const before = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.readFileSync(file)]))

    try {
      const check = await checkForRuntimeUpdate({
        apiBase: 'https://fixture.invalid',
        fetchJson,
        marker: { pinnedCommit: 'c'.repeat(40) }
      })

      assert.equal(check.latest.key, checked.upstream_commit)
      latest = actualLatest

      const result = await applyRuntimeUpdateToLatest(
        {
          expectedKey: check.latest.key,
          expectedVersion: check.latest.version
        },
        {
          updatesAllowed: () => true,
          resolveLatest: () => resolveLatestRuntimePin({ apiBase: 'https://fixture.invalid', fetchJson }),
          applyResolved: async pin => {
            // These authoritative writes are reachable only through the production apply gate.
            writes.push('bundle', 'override', 'marker')
            fs.writeFileSync(files.bundle, JSON.stringify({ key: pin.key }))
            fs.writeFileSync(files.override, JSON.stringify(pin))
            fs.rmSync(files.marker)

            return { ok: true, applied: true }
          }
        }
      )

      assert.deepEqual(result, {
        ok: false,
        error: 'runtime_target_changed',
        latest: { key: actualLatest.upstream_commit, version: actualLatest.version }
      })
      assert.equal(fetches, 2, 'Check and apply really resolved two different latest responses')
      assert.deepEqual(writes, [])

      for (const [name, file] of Object.entries(files)) {
        assert.deepEqual(fs.readFileSync(file), before[name], `${name} must remain byte-identical`)
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
)

test('matching frozen targets and ordinary unpinned updates retain their apply policy', async () => {
  const pin = derivePinFromLatest(changed)!
  const applied: string[] = []

  const dependencies = {
    updatesAllowed: () => true,
    resolveLatest: async () => pin,
    applyResolved: async target => {
      applied.push(target.key)

      return { ok: true, applied: true }
    }
  }

  for (const expected of [
    undefined,
    { expectedKey: pin.key, expectedVersion: pin.version },
    { expectedKey: pin.key },
    { expectedVersion: pin.version }
  ]) {
    assert.deepEqual(await applyRuntimeUpdateToLatest(expected, dependencies), { ok: true, applied: true })
  }

  assert.deepEqual(applied, [pin.key, pin.key, pin.key, pin.key])

  for (const expected of [{}, { expectedKey: 123, expectedVersion: pin.version }, { expectedKey: '' }, []]) {
    const result = await applyRuntimeUpdateToLatest(expected, dependencies)

    assert.deepEqual(result, {
      ok: false,
      error: 'runtime_target_changed',
      latest: { key: pin.key, version: pin.version }
    })
  }

  assert.equal(applied.length, 4)
  assert.deepEqual(await applyRuntimeUpdateToLatest(undefined, { ...dependencies, updatesAllowed: () => false }), {
    ok: false,
    error: 'diagnostic-trial-updates-disabled'
  })
  assert.deepEqual(await applyRuntimeUpdateToLatest(undefined, { ...dependencies, resolveLatest: async () => null }), {
    ok: false,
    error: 'no_admin_latest_available'
  })
  assert.equal(applied.length, 4)
})
