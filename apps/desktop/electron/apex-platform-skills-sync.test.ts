/**
 * Tests for electron/apex-platform-skills-sync.ts (hc-1081, multi-bot M5).
 *
 * Real temp homes (a root plus profiles/<name>), a stub fetchJson (no network).
 * What they pin: one manifest reaches the root and every listed profile, adds
 * and removals alike; a profile is caught up once per manifest (stamp) even
 * when the fetch is unchanged, failed or 401'd; the 401 path still hands the
 * stored JWT to the transport that tells cloudLogin (hc-1073) and never touches
 * the root; nothing outside `skills/apexnodes/` changes in any home; and the
 * M2 entry writes only the profile it names, and only once that profile is
 * listed (on the managed relay).
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { PLATFORM_SKILLS_CATEGORY } from './apex-platform-skills'
import {
  fillProfilePlatformSkills,
  PROFILE_SKILLS_STAGING,
  PROFILE_SKILLS_STAMP,
  registerProfileSkillsSync,
  syncPlatformSkills,
  syncProfilePlatformSkills
} from './apex-platform-skills-sync'
import { managedProfileHomes } from './apex-profile-homes'

const ON = {}
const OFF = { APEXNODES_PLATFORM_SKILLS: '0' }

const skill = (name: string, body: string, extra: Record<string, string> = {}) => ({
  files: [
    { content: `---\nname: ${name}\n---\n${body}`, path: 'SKILL.md' },
    ...Object.entries(extra).map(([p, content]) => ({ content, path: p }))
  ],
  hash: `h-${name}`,
  name,
  version: '1.0.0'
})

const STUDIO_V2 = skill('short-video-studio', 'v2 body', { 'references/shots.md': 'shots v2' })
const STUDIO_V3 = skill('short-video-studio', 'v3 body', { 'references/shots.md': 'shots v3' })
const DOUYIN = skill('douyin-video-transcript', 'use social_download')

const manifest = (hash: string, skills: any[]) => ({ manifest_hash: hash, skills, total: skills.length })

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

function writeFile(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

/** A root home and two profiles, each with skills the user installed and a bundled category. */
function makeHomes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-skill-homes-'))
  temps.push(root)
  const writer = path.join(root, 'profiles', 'writer')
  const editor = path.join(root, 'profiles', 'editor')

  for (const home of [root, writer, editor]) {
    writeFile(
      path.join(home, 'skills', 'my-stuff', 'my-skill', 'SKILL.md'),
      `---\nname: my-skill\n---\nmine in ${home}`
    )
    writeFile(path.join(home, 'skills', 'my-flat', 'SKILL.md'), '---\nname: my-flat\n---\nflat')
    writeFile(path.join(home, 'skills', 'apple', 'apple-notes', 'SKILL.md'), '---\nname: apple-notes\n---\nbundled')
    writeFile(path.join(home, 'skills', '.bundled_manifest'), 'apple-notes:abc\n')
    writeFile(path.join(home, 'SOUL.md'), 'soul')
  }

  return { editor, root, skillsRoot: path.join(root, 'skills'), writer }
}

/** A listed home, in hc-1080's ApexProfileHome shape. */
const at = (profile: string, home: string) => ({ home, profile })

const listed = (homes: ReturnType<typeof makeHomes>) => [
  at('default', homes.root),
  at('writer', homes.writer),
  at('editor', homes.editor)
]

/** Every file under dir as relpath → content (sorted), or {} when dir is missing. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}

  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name)

      if (entry.isDirectory()) {
        walk(abs)
      } else {
        out[path.relative(dir, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8')
      }
    }
  }

  if (fs.existsSync(dir)) {
    walk(dir)
  }

  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

/** Everything in a home except platform categories (the root's tree holds profiles/ too): must never change. */
function userOwned(home: string) {
  const platform = new RegExp(`(^|/)skills/${PLATFORM_SKILLS_CATEGORY}/`)

  return Object.fromEntries(Object.entries(tree(home)).filter(([rel]) => !platform.test(rel)))
}

const category = (home: string) => path.join(home, 'skills', PLATFORM_SKILLS_CATEGORY)

const withoutStamp = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).filter(([rel]) => rel !== PROFILE_SKILLS_STAMP))

function run(homes: ReturnType<typeof makeHomes>, opts: Record<string, any> = {}) {
  const lines: string[] = []
  const calls: any[] = []
  let tokenReads = 0

  const result = syncPlatformSkills({
    apiBase: 'https://apex-nodes.com',
    env: ON,
    fetchJson: async (url: string, options: any) => {
      calls.push({ options, url })

      return opts.reply ? opts.reply() : manifest('m1', [STUDIO_V2, DOUYIN])
    },
    homes: listed(homes),
    log: (line: string) => lines.push(line),
    now: () => 1_700_000_000_000,
    reason: 'boot',
    skillsRoot: homes.skillsRoot,
    stored: null,
    token: () => {
      tokenReads += 1

      return 'jwt-current'
    },
    ...opts.overrides
  })

  return result.then(out => ({ calls, lines, out, tokenReads: () => tokenReads }))
}

// ── one manifest, every home ────────────────────────────────────────────────

test('a new manifest lands in the root and, identically, in every listed profile', async () => {
  const homes = makeHomes()
  const { lines, out } = await run(homes)

  assert.deepEqual(out.newStored, { count: 2, installedAt: 1_700_000_000_000, manifestHash: 'm1' })
  const rootFiles = tree(category(homes.root))
  assert.deepEqual(Object.keys(rootFiles), [
    'douyin-video-transcript/SKILL.md',
    'short-video-studio/references/shots.md',
    'short-video-studio/SKILL.md'
  ])

  for (const profile of [homes.writer, homes.editor]) {
    const files = tree(category(profile))
    assert.deepEqual(withoutStamp(files), rootFiles, profile)
    assert.equal(files[PROFILE_SKILLS_STAMP], 'm1\n')
  }

  // The root is written from the manifest, never stamped as a copy.
  assert.equal(fs.existsSync(path.join(category(homes.root), PROFILE_SKILLS_STAMP)), false)
  // The log lines desktop.log readers grep for are unchanged.
  assert.ok(lines.includes('[platform-skills] installed 2 skill(s) manifest=m1 (boot)'), lines.join('\n'))
})

test('a skill the cloud removed disappears from every home, and a changed one is replaced', async () => {
  const homes = makeHomes()
  await run(homes)
  await run(homes, {
    overrides: { stored: { count: 2, installedAt: 1, manifestHash: 'm1' } },
    reply: () => manifest('m2', [STUDIO_V3])
  })

  for (const home of [homes.root, homes.writer, homes.editor]) {
    const files = withoutStamp(tree(category(home)))
    assert.deepEqual(
      Object.keys(files),
      ['short-video-studio/references/shots.md', 'short-video-studio/SKILL.md'],
      home
    )
    assert.match(files['short-video-studio/SKILL.md'], /v3 body/)
  }

  assert.equal(fs.readFileSync(path.join(category(homes.writer), PROFILE_SKILLS_STAMP), 'utf8'), 'm2\n')
})

// ── profiles that never had a copy catch up without a new manifest ──────────

/** Root already on m1 (installed by an earlier build); writer holds the snapshot it was cloned with. */
async function rootOnM1WithStaleWriter() {
  const homes = makeHomes()
  await run(homes, { overrides: { homes: [at('default', homes.root)] } })
  fs.rmSync(category(homes.writer), { force: true, recursive: true })
  writeFile(
    path.join(category(homes.writer), 'short-video-studio', 'SKILL.md'),
    '---\nname: short-video-studio\n---\nv1 cloned'
  )
  writeFile(path.join(category(homes.writer), 'retired-skill', 'SKILL.md'), '---\nname: retired-skill\n---\nold')

  return homes
}

const STORED_M1 = { count: 2, installedAt: 1, manifestHash: 'm1' }

const unauthorized = () => {
  const err: any = new Error('401: {"detail":"登录状态无效，请重新登录。"}')
  err.statusCode = 401
  throw err
}

test.each([
  ['the manifest is unchanged', { reply: () => ({ manifest_hash: 'm1', unchanged: true }) }],
  ['the server re-sends the same manifest', { reply: () => manifest('m1', [STUDIO_V2, DOUYIN]) }],
  ['the stored login JWT gets a 401', { reply: unauthorized }],
  [
    'the network is down',
    {
      reply: () => {
        throw new Error('ECONNRESET')
      }
    }
  ],
  ['the body is garbage', { reply: () => '<html>bad gateway</html>' }],
  ['there is no login JWT', { overrides: { token: () => '' } }]
])(
  'when %s, the root keeps its set and a profile without the stamp catches up to it',
  async (_label, scenario: any) => {
    const homes = await rootOnM1WithStaleWriter()
    const rootBefore = tree(category(homes.root))

    const { out } = await run(homes, { ...scenario, overrides: { stored: STORED_M1, ...scenario.overrides } })

    assert.equal(out.newStored, null)
    assert.deepEqual(tree(category(homes.root)), rootBefore)

    for (const profile of [homes.writer, homes.editor]) {
      assert.deepEqual(withoutStamp(tree(category(profile))), rootBefore, profile)
      assert.equal(fs.readFileSync(path.join(category(profile), PROFILE_SKILLS_STAMP), 'utf8'), 'm1\n')
    }
  }
)

test('the 401 path still hands the stored JWT to the transport (hc-1073 hears it) and logs as before', async () => {
  const homes = await rootOnM1WithStaleWriter()
  const { calls, lines } = await run(homes, { overrides: { stored: STORED_M1 }, reply: unauthorized })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.bearer, 'jwt-current')
  assert.match(calls[0].url, /\/api\/v1\/desktop\/platform-skills\?caps=next-steps,next-steps-handoff&known_hash=m1$/)
  assert.ok(
    lines.includes(
      '[platform-skills] fetch unavailable (401: {"detail":"登录状态无效，请重新登录。"}); keeping installed set'
    ),
    lines.join('\n')
  )
})

test('a profile already stamped with the current manifest is not rewritten', async () => {
  const homes = makeHomes()
  await run(homes)
  const edited = path.join(category(homes.writer), 'short-video-studio', 'SKILL.md')
  fs.writeFileSync(edited, 'patched by this assistant', 'utf8')

  await run(homes, { overrides: { stored: STORED_M1 }, reply: () => ({ manifest_hash: 'm1', unchanged: true }) })

  assert.equal(fs.readFileSync(edited, 'utf8'), 'patched by this assistant')
})

test("with hc-1080's list, a profile on the managed relay gets the skills and one on its own provider does not", async () => {
  const homes = makeHomes()
  const relay = 'https://apex-nodes.com/relay/v1'
  writeFile(
    path.join(homes.root, 'config.yaml'),
    `model:\n  provider: custom\n  base_url: "${relay}"\n  api_key: "sk-a"\n`
  )
  writeFile(
    path.join(homes.writer, 'config.yaml'),
    `model:\n  provider: custom\n  base_url: "${relay}"\n  api_key: "sk-a"\n`
  )
  writeFile(
    path.join(homes.editor, 'config.yaml'),
    'model:\n  provider: custom\n  base_url: "https://api.example.com/v1"\n  api_key: "sk-mine"\n'
  )
  // Not a profile (no SOUL.md): never listed, never written.
  writeFile(path.join(homes.root, 'profiles', 'scratch', 'notes.txt'), 'mine')
  const editorBefore = tree(homes.editor)

  await run(homes, { overrides: { homes: managedProfileHomes(homes.root, relay) } })

  assert.equal(fs.readFileSync(path.join(category(homes.writer), PROFILE_SKILLS_STAMP), 'utf8'), 'm1\n')
  assert.deepEqual(tree(homes.editor), editorBefore)
  assert.deepEqual(tree(path.join(homes.root, 'profiles', 'scratch')), { 'notes.txt': 'mine' })
})

// ── switch off, user skills, failures ───────────────────────────────────────

test('switch off removes the category from the root and every profile, never reading the JWT', async () => {
  const homes = makeHomes()
  await run(homes)
  const result = await run(homes, { overrides: { env: OFF, stored: STORED_M1 } })

  for (const home of [homes.root, homes.writer, homes.editor]) {
    assert.equal(fs.existsSync(category(home)), false, home)
  }

  assert.deepEqual(result.out.newStored, { count: 0, installedAt: 1_700_000_000_000, manifestHash: '' })
  assert.equal(result.tokenReads(), 0)
  assert.equal(result.calls.length, 0)
  assert.ok(result.lines.includes('[platform-skills] disabled via APEXNODES_PLATFORM_SKILLS; reverted (boot)'))
  // Nothing was installed and nothing is cached: no state write either.
  assert.equal((await run(homes, { overrides: { env: OFF, stored: null } })).out.newStored, null)
})

test.each([
  ['a new manifest', {}],
  ['a removal', { overrides: { stored: STORED_M1 }, reply: () => manifest('m2', [DOUYIN]) }],
  [
    'an unchanged manifest',
    { overrides: { stored: STORED_M1 }, reply: () => ({ manifest_hash: 'm1', unchanged: true }) }
  ],
  ['a 401', { overrides: { stored: STORED_M1 }, reply: unauthorized }],
  ['the switch off', { overrides: { env: OFF, stored: STORED_M1 } }]
])('%s leaves every file outside skills/apexnodes/ byte-identical in every home', async (_label, scenario: any) => {
  const homes = await rootOnM1WithStaleWriter()
  const before = [homes.root, homes.writer, homes.editor].map(userOwned)

  await run(homes, scenario)

  assert.deepEqual([homes.root, homes.writer, homes.editor].map(userOwned), before)
})

test('the root listed among the homes is written once, from the manifest, never copied into itself', async () => {
  const homes = makeHomes()
  await run(homes, {
    overrides: {
      homes: [at('default', homes.root), at('root-again', `${homes.root}${path.sep}`), at('writer', homes.writer)]
    }
  })

  assert.equal(fs.existsSync(path.join(category(homes.root), PROFILE_SKILLS_STAMP)), false)
  assert.equal(fs.existsSync(path.join(homes.root, PROFILE_SKILLS_STAGING)), false)
  assert.equal(
    fs.existsSync(path.join(homes.editor, 'skills', PLATFORM_SKILLS_CATEGORY)),
    false,
    'an unlisted profile is left alone'
  )
})

test('a leftover staging dir is cleared, and staging never sits under skills/', async () => {
  const homes = makeHomes()
  writeFile(path.join(homes.writer, PROFILE_SKILLS_STAGING, 'half-copied', 'SKILL.md'), '---\nname: half-copied\n---\n')
  await run(homes)

  assert.equal(fs.existsSync(path.join(homes.writer, PROFILE_SKILLS_STAGING)), false)
  assert.equal(fs.existsSync(path.join(category(homes.writer), 'half-copied')), false)
  assert.deepEqual(fs.readdirSync(path.join(homes.writer, 'skills')).sort(), [
    '.bundled_manifest',
    'apexnodes',
    'apple',
    'my-flat',
    'my-stuff'
  ])
})

test('one profile that cannot be written is logged; the others are still filled', async () => {
  const homes = makeHomes()
  // `skills` is a file in this profile, so nothing can be created under it.
  fs.rmSync(path.join(homes.writer, 'skills'), { force: true, recursive: true })
  writeFile(path.join(homes.writer, 'skills'), 'not a directory')

  const { lines, out } = await run(homes)

  assert.equal(out.newStored?.manifestHash, 'm1')
  assert.equal(fs.readFileSync(path.join(homes.writer, 'skills'), 'utf8'), 'not a directory')
  assert.equal(fs.readFileSync(path.join(category(homes.editor), PROFILE_SKILLS_STAMP), 'utf8'), 'm1\n')
  assert.ok(
    lines.some(line => line.startsWith(`[platform-skills] profile copy skipped writer (${homes.writer}): `)),
    lines.join('\n')
  )
})

// ── the M2 entry ────────────────────────────────────────────────────────────

test('syncProfilePlatformSkills: a new assistant gets the root set at once, only it; a second call writes nothing', async () => {
  const homes = makeHomes()
  await run(homes, { overrides: { homes: [at('default', homes.root)] } })
  const fresh = path.join(homes.root, 'profiles', 'fresh')
  writeFile(path.join(fresh, 'SOUL.md'), 'soul')

  const args = {
    env: ON,
    homes: [...listed(homes), at('fresh', fresh)],
    manifestHash: 'm1',
    profile: 'fresh',
    skillsRoot: homes.skillsRoot
  }

  assert.deepEqual(syncProfilePlatformSkills(args), { filled: true, ok: true })
  assert.deepEqual(withoutStamp(tree(category(fresh))), tree(category(homes.root)))
  assert.equal(fs.existsSync(category(homes.writer)), false, 'other assistants wait for the next refresh')
  assert.deepEqual(syncProfilePlatformSkills(args), { filled: false, ok: true })
})

test.each([
  ['a profile whose config is not on the relay yet (not listed)', 'editor', { filled: false, ok: false }],
  ['a profile name that is not a string', 42, { filled: false, ok: false }],
  ['the root, which the manifest writes', 'default', { filled: false, ok: true }]
])('syncProfilePlatformSkills: %s gets no copy', async (_label, profile: any, expected) => {
  const homes = makeHomes()
  await run(homes, { overrides: { homes: [at('default', homes.root)] } })

  const result = syncProfilePlatformSkills({
    env: ON,
    homes: [at('default', homes.root), at('writer', homes.writer)],
    manifestHash: 'm1',
    profile,
    skillsRoot: homes.skillsRoot
  })

  assert.deepEqual(result, expected)

  for (const home of [homes.writer, homes.editor]) {
    assert.equal(fs.existsSync(category(home)), false, home)
  }

  assert.equal(fs.existsSync(path.join(category(homes.root), PROFILE_SKILLS_STAMP)), false)
})

test('registerProfileSkillsSync: the IPC reads main state on every call', async () => {
  const homes = makeHomes()
  await run(homes, { overrides: { homes: [at('default', homes.root)] } })
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
  let manifestHash = ''

  registerProfileSkillsSync({ handle: (channel, listener) => handlers.set(channel, listener) }, () => ({
    env: ON,
    homes: listed(homes),
    manifestHash,
    skillsRoot: homes.skillsRoot
  }))
  const invoke = handlers.get('hermes:apex:syncProfileSkills')

  assert.deepEqual(await invoke?.({}, 'writer'), { filled: false, ok: true })
  manifestHash = 'm1'
  assert.deepEqual(await invoke?.({}, 'writer'), { filled: true, ok: true })
  assert.deepEqual(await invoke?.({}, 'nobody'), { filled: false, ok: false })
})

test.each([
  ['the switch is off', { env: OFF }],
  ['nothing was ever installed', { manifestHash: '' }],
  ['the root lost its category', { removeRoot: true }]
])('fillProfilePlatformSkills is a no-op when %s', async (_label, scenario: any) => {
  const homes = makeHomes()
  await run(homes, { overrides: { homes: [at('default', homes.root)] } })

  if (scenario.removeRoot) {
    fs.rmSync(category(homes.root), { force: true, recursive: true })
  }

  const lines: string[] = []

  const filled = fillProfilePlatformSkills({
    env: scenario.env || ON,
    homes: [at('writer', homes.writer)],
    log: line => lines.push(line),
    manifestHash: scenario.manifestHash ?? 'm1',
    skillsRoot: homes.skillsRoot
  })

  assert.deepEqual(filled, [])
  assert.equal(fs.existsSync(category(homes.writer)), false)

  if (scenario.removeRoot) {
    assert.deepEqual(lines, ['[platform-skills] root has no apexnodes/ for manifest=m1; profiles left as they are'])
  }
})

// ── main.ts / preload wiring ────────────────────────────────────────────────

const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8')

function functionBody(name: string): string {
  const start =
    main.indexOf(`\nasync function ${name}(`) === -1
      ? main.indexOf(`\nfunction ${name}(`)
      : main.indexOf(`\nasync function ${name}(`)

  assert.notEqual(start, -1, `main.ts no longer defines ${name}`)

  return main.slice(start, main.indexOf('\n}\n', start)).replace(/^\s*\/\/.*$/gm, '')
}

test('main.ts refreshes through syncPlatformSkills on the JWT transport cloudLogin watches', () => {
  const body = functionBody('refreshPlatformSkillsFromPlatform')

  assert.match(body, /await syncPlatformSkills\(\{\n\s+\.\.\.platformSkillsHomes\(\),/)
  assert.match(body, /\n\s+fetchJson: apexAuthGetJson,\n/)
  assert.match(body, /\n\s+token: \(\) => resolveManagedConfig\(\)\.accessToken\n/)
  assert.match(body, /\n\s+stored: readPlatformSkillsState\(\),\n/)
  assert.match(body, /if \(result\.newStored\) \{writePlatformSkillsState\(result\.newStored\)\}/)
  assert.equal(main.match(/void refreshPlatformSkillsFromPlatform\('(?:boot|sign-in)'\)/g)?.length, 3)
  // apexAuthGetJson is a GET on apexAuthBodylessJson, one of the transports hc-1073 counts.
  assert.match(functionBody('apexAuthGetJson'), /return apexAuthBodylessJson\('GET', url, opts\)/)
})

test('main.ts gives the refresh and the M2 entry the same homes, and preload exposes the entry', () => {
  assert.equal(main.match(/\.\.\.platformSkillsHomes\(\)/g)?.length, 2)
  // The homes are hc-1080's: the root plus every profile on the managed relay.
  assert.match(
    functionBody('platformSkillsHomes'),
    /\{\n {2}return \{ homes: apexConfigHomes\(\), skillsRoot: path\.join\(HERMES_HOME, 'skills'\) \}$/
  )
  assert.ok(
    main.includes(
      'registerProfileSkillsSync(ipcMain, () => ({ ...platformSkillsHomes(), env: process.env, log: msg => rememberLog(msg), manifestHash: readPlatformSkillsState().manifestHash }))'
    )
  )
  assert.ok(
    preload.includes("syncApexProfileSkills: profile => ipcRenderer.invoke('hermes:apex:syncProfileSkills', profile),")
  )
  // No second writer of the platform category is left in main.ts.
  assert.equal(/applyPlatformSkills|removePlatformSkills/.test(main), false)
})
