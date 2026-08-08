/**
 * Tests for electron/apex-config-arrival.ts.
 *
 * Run with: npx vitest run --project electron electron/apex-config-arrival
 *
 * The regression these hold: on a brand-new HERMES_HOME config.yaml does not
 * exist yet when the boot-time product-defaults guard runs, so the guard
 * early-returns, the runtime creates the file itself moments later with
 * UPSTREAM defaults, and the shell opens in English because /api/config answers
 * `en` out of its merged defaults for a file that never mentions
 * display.language. The first test is that exact timeline end to end — no file
 * at start, file created later, product defaults present afterwards — driven
 * through the real ensureProductDefaultsYaml healer, not a stub.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { guardConfigYamlOnArrival } from './apex-config-arrival'
import { APEX_PRODUCT_DEFAULTS, ensureProductDefaultsYaml } from './apex-managed'

const tempHomes: string[] = []

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-config-arrival-'))
  tempHomes.push(home)

  return home
}

afterEach(() => {
  while (tempHomes.length) {
    fs.rmSync(tempHomes.pop() as string, { recursive: true, force: true })
  }
})

// The production guard, reduced to the one healer these tests are about: read
// whatever is on disk, fill only the keys it does not mention, write back.
function healProductDefaults(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8')
  const { changed, next } = ensureProductDefaultsYaml(raw)

  if (changed) {
    fs.writeFileSync(configPath, next, { encoding: 'utf8' })
  }
}

test('a config.yaml created AFTER boot still gets the product defaults', async () => {
  const home = makeHome()
  const configPath = path.join(home, 'config.yaml')

  // The state a fresh HERMES_HOME is actually in when ensureRuntime runs.
  assert.equal(fs.existsSync(configPath), false)

  const waiter = guardConfigYamlOnArrival({
    configPath,
    guard: () => healProductDefaults(configPath),
    pollMs: 5
  })

  // …and the state it reaches a moment later, when the runtime writes its own
  // config.yaml: a `model:` block, a version stamp, no display block at all.
  // Exactly what was found on the machine that opened in English.
  setTimeout(() => {
    fs.writeFileSync(configPath, 'model:\n  default: hermes-4\n_config_version: 33\n', { encoding: 'utf8' })
  }, 30)

  assert.equal(await waiter.done, 'guarded')

  const healed = fs.readFileSync(configPath, 'utf8')
  assert.match(healed, /^ {2}language: zh$/m)
  assert.match(healed, /^ {2}show_reasoning: true$/m)
  assert.match(healed, /^ {2}image_input_mode: auto$/m)
  assert.match(healed, /^ {2}max_turns: 90$/m)
  assert.match(healed, /^ {2}max_iterations: 50$/m)
  assert.match(healed, /^ {2}max_lines: 2000$/m)
  assert.match(healed, /^session_reset:\n {2}mode: none$/m)
  assert.match(healed, /^approvals:\n {2}mode: manual$/m)
  assert.match(healed, /^memory:\n {2}nudge_interval: 0$/m)
  assert.match(healed, /^skills:\n {2}creation_nudge_interval: 0$/m)
  assert.match(healed, /^proxy:\n {2}enabled: false$/m)
  assert.match(healed, /^timezone: ''$/m)
  // The other writer's content survives — this is a fill, not a replacement.
  assert.match(healed, /^ {2}default: hermes-4$/m)
  assert.match(healed, /^_config_version: 33$/m)
})

test('a value the late writer DID set is left alone', async () => {
  const home = makeHome()
  const configPath = path.join(home, 'config.yaml')

  const waiter = guardConfigYamlOnArrival({
    configPath,
    guard: () => healProductDefaults(configPath),
    pollMs: 5
  })

  setTimeout(() => {
    fs.writeFileSync(configPath, 'display:\n  language: en\n', { encoding: 'utf8' })
  }, 20)

  assert.equal(await waiter.done, 'guarded')

  const healed = fs.readFileSync(configPath, 'utf8')
  // An explicit `en` on disk is somebody's answer, never ours to overrule.
  assert.match(healed, /^ {2}language: en$/m)
  assert.doesNotMatch(healed, /language: zh/)
  // The keys that WERE missing still get filled.
  assert.match(healed, /^ {2}show_reasoning: true$/m)
})

test('the guard runs once, not once per poll, after the file arrives', async () => {
  const home = makeHome()
  const configPath = path.join(home, 'config.yaml')
  let guards = 0

  const waiter = guardConfigYamlOnArrival({
    configPath,
    guard: () => {
      guards += 1
    },
    pollMs: 5
  })

  fs.writeFileSync(configPath, 'model:\n  default: hermes-4\n', { encoding: 'utf8' })
  await waiter.done
  await new Promise(resolve => setTimeout(resolve, 40))

  assert.equal(guards, 1)
})

test('the live watcher is armed BEFORE the guard writes', async () => {
  const home = makeHome()
  const configPath = path.join(home, 'config.yaml')
  const order: string[] = []

  const waiter = guardConfigYamlOnArrival({
    configPath,
    guard: () => order.push('guard'),
    watch: () => order.push('watch'),
    pollMs: 5
  })

  fs.writeFileSync(configPath, 'model:\n  default: hermes-4\n', { encoding: 'utf8' })
  await waiter.done

  // The guard yields its write when a racing writer changed the file mid-pass,
  // and an already-armed watcher is what turns that into a retry rather than a
  // silently dropped heal.
  assert.deepEqual(order, ['watch', 'guard'])
})

test('gives up on a file that never arrives instead of polling forever', async () => {
  const home = makeHome()
  let guards = 0
  const logs: string[] = []

  const waiter = guardConfigYamlOnArrival({
    configPath: path.join(home, 'config.yaml'),
    guard: () => {
      guards += 1
    },
    pollMs: 5,
    timeoutMs: 20,
    log: line => logs.push(line)
  })

  assert.equal(await waiter.done, 'timeout')
  assert.equal(guards, 0)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /never appeared/)
})

test('cancel stops the wait without ever running the guard', async () => {
  const home = makeHome()
  const configPath = path.join(home, 'config.yaml')
  let guards = 0

  const waiter = guardConfigYamlOnArrival({
    configPath,
    guard: () => {
      guards += 1
    },
    pollMs: 5
  })

  waiter.cancel()
  assert.equal(await waiter.done, 'cancelled')

  // The file arriving after a cancel must not resurrect the waiter.
  fs.writeFileSync(configPath, 'model:\n  default: hermes-4\n', { encoding: 'utf8' })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(guards, 0)
})

test('a throwing guard is logged, never left hanging', async () => {
  const home = makeHome()
  const configPath = path.join(home, 'config.yaml')
  const logs: string[] = []

  const waiter = guardConfigYamlOnArrival({
    configPath,
    guard: () => {
      throw new Error('disk went away')
    },
    pollMs: 5,
    log: line => logs.push(line)
  })

  fs.writeFileSync(configPath, 'model:\n  default: hermes-4\n', { encoding: 'utf8' })

  assert.equal(await waiter.done, 'guarded')
  assert.equal(logs.length, 1)
  assert.match(logs[0], /disk went away/)
})

test('every product default the seed pins is one the arrival heal can fill', async () => {
  const home = makeHome()
  const configPath = path.join(home, 'config.yaml')

  const waiter = guardConfigYamlOnArrival({
    configPath,
    guard: () => healProductDefaults(configPath),
    pollMs: 5
  })

  fs.writeFileSync(configPath, 'model:\n  default: hermes-4\n', { encoding: 'utf8' })
  await waiter.done

  const healed = fs.readFileSync(configPath, 'utf8')

  // Guards the pairing itself: a key added to APEX_PRODUCT_DEFAULTS that this
  // path cannot land would otherwise pass unnoticed.
  for (const dotted of Object.keys(APEX_PRODUCT_DEFAULTS)) {
    const leaf = dotted.split('.').pop()
    assert.match(healed, new RegExp(`^\\s*${leaf}:`, 'm'), `${dotted} was not filled`)
  }
})
