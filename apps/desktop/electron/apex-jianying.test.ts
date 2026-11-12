/**
 * hc-1219: the launch switch main settles from `desktop_features.jianying`, and
 * 「在剪映中打开」 (jianying.ts). The off path is pinned against fork main by
 * apex-jianying-identity.test.ts.
 *
 * Run with: npx vitest run electron/apex-jianying.test.ts --project electron
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'vitest'

import { applyJianyingSwitch, JIANYING_ACTIVE_ENV } from './apex-jianying'
import { applyDesktopFeatureSwitches } from './apex-model-tiers'
import {
  draftListed,
  isEngineDraftFolder,
  JIANYING_OPEN_CHANNEL,
  type JianyingDeps,
  jianyingLaunchCommand,
  type LaunchCommand,
  openDraftInJianying
} from './jianying'

const ON = { desktop_features: { jianying: true } }

describe('the launch switch', () => {
  test('the platform turns it on with a literal true, and it is logged once', () => {
    const env: Record<string, string | undefined> = {}
    const lines: string[] = []

    assert.equal(applyJianyingSwitch(env, ON, line => lines.push(line)), true)
    assert.equal(env[JIANYING_ACTIVE_ENV], '1')
    assert.deepEqual(lines, ['[client-config] APEX_JIANYING_ACTIVE=1 (desktop_features.jianying)'])
  })

  test.each([
    ['no config', null],
    ['false', { desktop_features: { jianying: false } }],
    ['a string', { desktop_features: { jianying: 'true' } }],
    ['a top-level key', { jianying: true }]
  ])('%s leaves it off', (_label, payload) => {
    const env: Record<string, string | undefined> = { [JIANYING_ACTIVE_ENV]: '1' }

    assert.equal(applyJianyingSwitch(env, payload), false)
    assert.equal(JIANYING_ACTIVE_ENV in env, false)
  })

  test('this install wins in both directions', () => {
    assert.equal(applyJianyingSwitch({ APEXNODES_JIANYING: '1' }, null), true)
    assert.equal(applyJianyingSwitch({ APEXNODES_JIANYING: '0' }, ON), false)
  })

  test('the launch settles it with the other switches', () => {
    const env: Record<string, string | undefined> = {}

    assert.deepEqual(applyDesktopFeatureSwitches(env, ON), [JIANYING_ACTIVE_ENV])
    assert.equal(env[JIANYING_ACTIVE_ENV], '1')
  })
})

const ROOT = '/Users/u/Movies/JianyingPro/User Data/Projects/com.lveditor.draft'
const DRAFT = `${ROOT}/夏日 vlog`

function deps(overrides: Partial<JianyingDeps> = {}, files: Record<string, string> = {}): JianyingDeps {
  const dirs = new Set([ROOT, DRAFT])
  const present = new Set([`${DRAFT}/draft_info.json`, `${DRAFT}/draft_meta_info.json`, ...Object.keys(files)])

  return {
    env: {},
    exists: target => present.has(target),
    isDirectory: target => dirs.has(target),
    launch: async () => '',
    log: () => undefined,
    platform: 'darwin',
    readText: target => files[target] ?? null,
    sleep: async () => undefined,
    waitMs: 0,
    ...overrides
  }
}

const listing = (entries: unknown[]) => ({ [`${ROOT}/root_meta_info.json`]: JSON.stringify({ all_draft_store: entries }) })
const ENTRY = { draft_fold_path: DRAFT, draft_json_file: `${DRAFT}/draft_info.json`, tm_duration: 14_000_000 }

describe('「在剪映中打开」', () => {
  test.each([
    ['a relative path', '夏日 vlog'],
    ['not a string', 42],
    ['a folder without the draft files', ROOT],
    ['a path that is not there', '/tmp/nothing']
  ])('%s is not a draft, and nothing starts', async (_label, folder) => {
    const launched: LaunchCommand[] = []
    const result = await openDraftInJianying(folder, deps({ launch: async c => (launched.push(c), '') }))

    assert.deepEqual(result, { ok: false, reason: 'not_a_draft' })
    assert.deepEqual(launched, [])
  })

  test('macOS starts 剪映 by its bundle id and finds the draft on its list', async () => {
    const launched: LaunchCommand[] = []

    const result = await openDraftInJianying(
      DRAFT,
      deps({ launch: async c => (launched.push(c), '') }, { ...listing([ENTRY]), [ENTRY.draft_json_file]: '' })
    )

    assert.deepEqual(launched, [{ file: 'open', args: ['-b', 'com.lemon.lvpro'] }])
    assert.deepEqual(result, { ok: true, listed: true })
  })

  test('a draft 剪映 does not list in time is said, not hidden', async () => {
    const result = await openDraftInJianying(DRAFT, deps({}, listing([{ ...ENTRY, tm_duration: 0 }])))

    assert.deepEqual(result, { ok: true, listed: false })
  })

  test('macOS without 剪映: LaunchServices refuses, which reads as not installed', async () => {
    const result = await openDraftInJianying(DRAFT, deps({ launch: async () => 'Unable to find application' }))

    assert.deepEqual(result, { ok: false, reason: 'not_installed' })
  })

  test('Windows starts the launcher under LOCALAPPDATA, detached', () => {
    const launcher = path.win32.join('C:\\Users\\u\\AppData\\Local', 'JianyingPro', 'Apps', 'JianyingPro.exe')
    const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }

    assert.deepEqual(jianyingLaunchCommand({ env, exists: target => target === launcher, platform: 'win32' }), {
      file: launcher,
      args: [],
      detached: true
    })
    assert.equal(jianyingLaunchCommand({ env, exists: () => false, platform: 'win32' }), null)
    assert.equal(jianyingLaunchCommand({ env: {}, exists: () => true, platform: 'win32' }), null)
  })

  test('other platforms have no 剪映', async () => {
    assert.deepEqual(await openDraftInJianying(DRAFT, deps({ platform: 'linux' })), {
      ok: false,
      reason: 'unsupported'
    })
  })

  test('the list is matched by folder, judged by its timeline and duration, and Windows paths fold case', () => {
    const exists = (target: string) => target.endsWith('draft_info.json')

    assert.equal(draftListed(DRAFT, { exists, platform: 'darwin', readText: () => null }), false)
    assert.equal(draftListed(DRAFT, { exists, platform: 'darwin', readText: () => 'not json' }), false)
    assert.equal(
      draftListed(DRAFT, { exists, platform: 'darwin', readText: () => JSON.stringify({ all_draft_store: [ENTRY] }) }),
      true
    )
    assert.equal(
      draftListed(DRAFT, {
        exists: () => false,
        platform: 'darwin',
        readText: () => JSON.stringify({ all_draft_store: [ENTRY] })
      }),
      false
    )

    const winDraft = 'C:\\Users\\u\\AppData\\Local\\JianyingPro\\User Data\\Projects\\com.lveditor.draft\\成片'

    // As 剪映 11.7.0.14652 lists a draft on Windows (measured 2026-11-12): forward slashes in the folder, and the
    // timeline is its own copy, draft_content.json, made from the engine's draft_info.json at intake.
    const winEntry = {
      draft_fold_path: 'C:/Users/u/AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft/成片',
      draft_json_file:
        'C:/Users/u/AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft/成片\\draft_content.json',
      tm_duration: 14_000_000
    }

    assert.equal(
      draftListed(winDraft, {
        exists: target => target.endsWith('\\draft_content.json'),
        platform: 'win32',
        readText: () => JSON.stringify({ all_draft_store: [winEntry] })
      }),
      true
    )
  })

  test('the draft folder check is exported for the IPC path only', () => {
    assert.equal(isEngineDraftFolder(DRAFT, deps()), true)
  })

  test('main registers the button on the channel preload calls', () => {
    const reads = readFileSync(path.join(__dirname, 'apex-account-reads.ts'), 'utf8')
    const preload = readFileSync(path.join(__dirname, 'preload.ts'), 'utf8')

    assert.ok(reads.includes(`ipcMain.handle('${JIANYING_OPEN_CHANNEL}', async (_event, folder) => openDraftInJianying(`))
    assert.ok(preload.includes(`openInJianying: folder => ipcRenderer.invoke('${JIANYING_OPEN_CHANNEL}', folder),`))
  })
})
