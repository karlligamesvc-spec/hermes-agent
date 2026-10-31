/**
 * hc-1115: with several assistants off, the main engine starts as APEX and
 * active-profile.json is never set to another assistant; with them on (or
 * single-thread off) nothing changes.
 *
 * Run with: npx vitest run electron/apex-startup-profile.test.ts --project electron
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test } from 'vitest'

import { applyDesktopFeatureSwitches } from './apex-model-tiers'
import {
  apexOnlyStartup,
  migrateStartupProfileIfMissing,
  readStoredDesktopProfile,
  startupProfileFor,
  startupProfileWritable
} from './apex-startup-profile'
import type { MigrationDeps } from './profile-migration'

// main.ts's PROFILE_NAME_RE (hermes_cli.profiles._PROFILE_ID_RE).
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const isValidProfileName = (name: string) => PROFILE_NAME_RE.test(name)

const BOTH_ON = { desktop_features: { multi_bot: true, single_thread: true } }

/** The env main settles before app.whenReady, from this install's switches and the platform's client config. */
function launchEnv(install: Record<string, string>, payload: unknown): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...install }

  applyDesktopFeatureSwitches(env, payload)

  return env
}

const LAUNCHES = {
  // QA b67's `--multi-bot-off`: APEXNODES_MULTI_BOT=0 while the platform has both on.
  'several assistants forced off': launchEnv({ APEXNODES_MULTI_BOT: '0' }, BOTH_ON),
  'several assistants off on the platform': launchEnv({}, { desktop_features: { single_thread: true } }),
  'several assistants on': launchEnv({}, BOTH_ON),
  'single-thread off': launchEnv({ APEXNODES_SINGLE_THREAD: '0' }, BOTH_ON),
  'nothing on': launchEnv({}, null)
} as const

type Launch = keyof typeof LAUNCHES

const OFF: Launch[] = ['several assistants forced off', 'several assistants off on the platform']
const PASS_THROUGH: Launch[] = ['several assistants on', 'single-thread off', 'nothing on']

describe('which launches show APEX alone', () => {
  test.each(Object.keys(LAUNCHES) as Launch[])('%s', launch => {
    assert.equal(apexOnlyStartup(LAUNCHES[launch]), OFF.includes(launch))
  })
})

describe('the startup profile every reader gets', () => {
  test.each(OFF.flatMap(launch => [null, 'default', 'apex-bot-2', 'work'].map(stored => [launch, stored] as const)))(
    '%s, stored %s → APEX',
    (launch, stored) => {
      assert.equal(startupProfileFor(stored, LAUNCHES[launch]), 'default')
    }
  )

  test.each(
    PASS_THROUGH.flatMap(launch => [null, 'default', 'apex-bot-2', 'work'].map(stored => [launch, stored] as const))
  )('%s, stored %s → as stored', (launch, stored) => {
    assert.equal(startupProfileFor(stored, LAUNCHES[launch]), stored)
  })
})

describe('what may be recorded as the startup profile', () => {
  test.each([
    ['several assistants forced off', 'apex-bot-2', false],
    ['several assistants forced off', 'work', false],
    ['several assistants forced off', 'default', true],
    ['several assistants forced off', '', true],
    ['several assistants forced off', null, true],
    ['several assistants off on the platform', 'apex-bot-3', false],
    ['several assistants on', 'apex-bot-2', true],
    ['single-thread off', 'work', true],
    ['nothing on', 'apex-bot-2', true]
  ] as const)('%s: %s → %s', (launch, profile, writable) => {
    const lines: string[] = []

    assert.equal(
      startupProfileWritable(profile, LAUNCHES[launch], line => lines.push(line)),
      writable
    )
    assert.deepEqual(
      lines,
      writable ? [] : [`[multi-bot] off: not recording "${profile}" as the startup profile (it stays APEX's)`]
    )
  })
})

describe('reading active-profile.json (moved from main.ts unchanged)', () => {
  test.each([
    ['a named profile', '{"profile":"apex-bot-2"}', 'apex-bot-2'],
    ['a heuristic pick', '{"profile":"apex-bot-2","_migrated":true}', 'apex-bot-2'],
    ['default', '{"profile":"default"}', 'default'],
    ['surrounding blanks', '{"profile":"  work "}', 'work'],
    ['cleared', '{"profile":null}', null],
    ['an empty name', '{"profile":""}', null],
    ['a name the engine would reject', '{"profile":"Bad Name"}', null],
    ['not a string', '{"profile":3}', null],
    ['malformed', '{"profile":', null],
    ['not an object', '"apex-bot-2"', null]
  ])('%s', (_label, raw, expected) => {
    assert.equal(
      readStoredDesktopProfile('active-profile.json', isValidProfileName, () => raw),
      expected
    )
  })

  test('a missing file is no preference', () => {
    const missing = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }

    assert.equal(readStoredDesktopProfile('active-profile.json', isValidProfileName, missing), null)
  })
})

// ── the heuristic, on a real HERMES_HOME ─────────────────────────────────────

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 29, 12)
const homes: string[] = []

afterEach(() => {
  for (const dir of homes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** QA b67's layout: APEX's state.db older and smaller than an assistant's, which the heuristic then picks. */
function installWithAssistants(): { file: string; deps: MigrationDeps } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc1115-'))
  const home = path.join(root, 'hermes-home')
  const file = path.join(root, 'user-data', 'active-profile.json')

  homes.push(root)

  const stateDb = (dir: string, bytes: number, ageDays: number) => {
    fs.mkdirSync(dir, { recursive: true })
    const db = path.join(dir, 'state.db')
    fs.writeFileSync(db, Buffer.alloc(bytes))
    const at = new Date(NOW - ageDays * DAY)
    fs.utimesSync(db, at, at)
  }

  stateDb(home, 4_096, 3)
  stateDb(path.join(home, 'profiles', 'apex-bot-2'), 2_000_000, 0)
  stateDb(path.join(home, 'profiles', 'apex-bot-3'), 8_192, 1)

  return {
    file,
    // main.ts's migrateActiveProfileIfMissing() deps, on plain fs.
    deps: {
      legacyActivePath: path.join(home, 'active_profile'),
      hermesHome: home,
      profilesRoot: path.join(home, 'profiles'),
      existsSync: p => fs.existsSync(p),
      readFileSync: (p, enc) => fs.readFileSync(p, enc),
      statSync: p => fs.statSync(p),
      readdirSync: (p, opts) => fs.readdirSync(p, opts as { withFileTypes: true }),
      isHermesProcess: () => false,
      now: () => NOW,
      writeJson: (target, decision) => {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, JSON.stringify(decision, null, 2))
      },
      isValidProfileName: p => PROFILE_NAME_RE.test(p)
    }
  }
}

function stored(file: string): unknown {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : 'missing'
}

function writeStored(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

describe('the first-boot seed and re-score', () => {
  test.each(PASS_THROUGH)('%s: the heuristic picks the busiest assistant, as before', launch => {
    const { file, deps } = installWithAssistants()
    const lines: string[] = []

    assert.equal(
      migrateStartupProfileIfMissing(file, deps, LAUNCHES[launch], line => lines.push(line)),
      true
    )
    assert.deepEqual(stored(file), { profile: 'apex-bot-2', _migrated: true })
    assert.deepEqual(lines, [])
  })

  test.each(OFF)('%s: no file is created', launch => {
    const { file, deps } = installWithAssistants()
    const lines: string[] = []

    assert.equal(
      migrateStartupProfileIfMissing(file, deps, LAUNCHES[launch], line => lines.push(line)),
      false
    )
    assert.equal(stored(file), 'missing')
    assert.equal(startupProfileFor(readStoredDesktopProfile(file, isValidProfileName), LAUNCHES[launch]), 'default')
    assert.deepEqual(lines, [
      '[multi-bot] off: the main engine starts as APEX; active-profile.json (no profile) left as it is'
    ])
  })

  // QA b67: setting the heuristic's pick back to APEX by hand was undone on the next launch.
  test.each(OFF)('%s: a hand edit back to APEX stays', launch => {
    const { file, deps } = installWithAssistants()

    writeStored(file, { profile: 'default', _migrated: true })
    migrateStartupProfileIfMissing(file, deps, LAUNCHES[launch], () => undefined)

    assert.deepEqual(stored(file), { profile: 'default', _migrated: true })
  })

  test.each(OFF)('%s: an earlier pick of an assistant is left alone and not used', launch => {
    const { file, deps } = installWithAssistants()
    const lines: string[] = []

    writeStored(file, { profile: 'apex-bot-3', _migrated: true })
    migrateStartupProfileIfMissing(file, deps, LAUNCHES[launch], line => lines.push(line))

    assert.deepEqual(stored(file), { profile: 'apex-bot-3', _migrated: true })
    assert.equal(startupProfileFor(readStoredDesktopProfile(file, isValidProfileName), LAUNCHES[launch]), 'default')
    assert.deepEqual(lines, [
      '[multi-bot] off: the main engine starts as APEX; active-profile.json (apex-bot-3) left as it is'
    ])
  })

  test('off, then on again: the launch with several assistants on does what it would have done', () => {
    const offThenOn = installWithAssistants()
    const onOnly = installWithAssistants()

    for (const install of [offThenOn, onOnly]) {
      writeStored(install.file, { profile: 'apex-bot-3', _migrated: true })
    }

    migrateStartupProfileIfMissing(offThenOn.file, offThenOn.deps, LAUNCHES['several assistants forced off'], () => {})

    for (const install of [offThenOn, onOnly]) {
      migrateStartupProfileIfMissing(install.file, install.deps, LAUNCHES['several assistants on'], () => {})
    }

    assert.deepEqual(stored(offThenOn.file), stored(onOnly.file))
    assert.deepEqual(stored(onOnly.file), { profile: 'apex-bot-2', _migrated: true })
  })
})

// ── main.ts wiring ───────────────────────────────────────────────────────────

const code = fs.readFileSync(path.join(import.meta.dirname, 'main.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '')

function body(signature: string): string {
  const start = code.indexOf(signature)

  assert.ok(start >= 0, `${signature} is missing from main.ts`)

  return code.slice(start, code.indexOf('\n}\n', start) + 2)
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('main.ts reads and writes the startup profile only through this module', () => {
  test('active-profile.json is touched only by the reader, the writer and the seed', () => {
    const owners = [
      'function readActiveDesktopProfile(',
      'function writeActiveDesktopProfile(',
      'function migrateActiveProfileIfMissing('
    ]

    const inOwners = owners.reduce((sum, owner) => sum + count(body(owner), 'DESKTOP_PROFILE_CONFIG_PATH'), 0)

    // + 1: the const itself.
    assert.equal(count(code, 'DESKTOP_PROFILE_CONFIG_PATH'), inOwners + 1)
  })

  test('the reader answers through startupProfileFor, and is the only one', () => {
    assert.match(
      body('function readActiveDesktopProfile('),
      /return startupProfileFor\(\s*readStoredDesktopProfile\(DESKTOP_PROFILE_CONFIG_PATH, [^)]*\)\),\s*process\.env\s*\)/
    )
    assert.equal(count(code, 'readStoredDesktopProfile('), 1)
  })

  test('the writer asks startupProfileWritable before it writes', () => {
    const write = body('function writeActiveDesktopProfile(')
    const gate = write.indexOf('if (!startupProfileWritable(value, process.env, rememberLog)) {')

    assert.ok(gate > 0, 'gate missing')
    assert.ok(gate < write.indexOf('writeFileAtomic(DESKTOP_PROFILE_CONFIG_PATH'), 'gate after the write')
    assert.match(write.slice(gate), /^[^\n]*\n\s*return readActiveDesktopProfile\(\)\n/)
  })

  test('the seed runs through migrateStartupProfileIfMissing with this launch env', () => {
    const seed = body('function migrateActiveProfileIfMissing(')

    assert.match(seed, /migrateStartupProfileIfMissing\(DESKTOP_PROFILE_CONFIG_PATH, \{/)
    assert.match(seed, /\}, process\.env, rememberLog\)\n\}/)
    assert.doesNotMatch(code, /import \{[^}]*\bmigrateActiveProfileIfMissing\b[^}]*\} from '\.\/profile-migration'/)
  })

  test('every exit that picks the main engine profile reads readActiveDesktopProfile', () => {
    const start = body('async function runHermesStart(')

    // The primary's `--profile` and its routing pin.
    assert.match(
      start,
      /const activeProfile = readActiveDesktopProfile\(\)\n\s*\n\s*if \(activeProfile\) \{\n\s*backendArgs\.unshift\('--profile', activeProfile\)/
    )
    assert.match(
      start,
      /migrateActiveProfileIfMissing\(\)\n[\s\S]*const primaryProfile = primaryProfileKey\(\)\n[\s\S]*primaryProfilePin\.pin\(primaryProfile\)/
    )
    assert.match(body('function primaryProfileKey('), /return primaryProfilePin\.resolve\(readActiveDesktopProfile\)/)
    // The renderer's adoptPrimaryProfile, the local IM gateway, plugin roots (fs-ipc).
    assert.match(
      code,
      /ipcMain\.handle\('hermes:profile:get', async \(\) => \(\{ profile: readActiveDesktopProfile\(\) \}\)\)/
    )
    assert.match(
      body('async function reconcileMessagingGateway('),
      /const activeProfile = readActiveDesktopProfile\(\) \|\| null/
    )
    assert.match(code, /await startMessagingGateway\(readActiveDesktopProfile\(\)\)/)
    assert.match(code, /registerFsIpc\(\{[^}]*\breadActiveDesktopProfile,/)
    // remember / set (the developer rail, ⌘1–9 and ⌘⇧[ ⌘⇧]) go through the guarded writer.
    assert.match(
      code,
      /'hermes:profile:remember', async \(_event, name\) => \(\{\n\s*profile: writeActiveDesktopProfile\(name\)/
    )
    assert.match(
      code,
      /'hermes:profile:set', async \(_event, name\) => \{\n\s*assertCanMutateManagedPrimaryRouting\(\)\n\s*const next = writeActiveDesktopProfile\(name\)/
    )
  })
})
