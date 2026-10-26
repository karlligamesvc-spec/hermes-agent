import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test, vi } from 'vitest'

import {
  APEX_DESKTOP_DEFAULT_SOUL,
  ensureApexDesktopSoul,
  ensureApexDesktopSouls,
  normalizedSoul,
  upgradeProfileSouls,
  UPSTREAM_SEEDED_SOULS
} from './apex-default-soul'

interface UpstreamSoul {
  seeded: string
  sha256: string
  sources: string[]
  text: string
  variant: string
}

// Every text upstream seeded on its own, pulled from each revision of the seeding files (hc-1042).
const UPSTREAM: UpstreamSoul[] = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'upstream-souls.json'), 'utf8')
).souls

const APEX_FILE = `${APEX_DESKTOP_DEFAULT_SOUL}\n`

const BOT_MODE_SECTION =
  '\n\n## Messaging other agents\n\nYou work alongside other named agents.\n\n- `writer` — drafts posts\n'

const POSIX = process.platform !== 'win32'
const temporaryRoots: string[] = []

function temporaryHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-desktop-soul-'))
  temporaryRoots.push(root)

  return path.join(root, '.apexnodes')
}

function homeWithSoul(content: string, relative = 'SOUL.md'): { home: string; soulPath: string } {
  const home = temporaryHome()
  const soulPath = path.join(home, relative)
  fs.mkdirSync(path.dirname(soulPath), { recursive: true })
  fs.writeFileSync(soulPath, content, 'utf8')

  return { home, soulPath }
}

afterEach(() => {
  vi.restoreAllMocks()

  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('the APEX identity names APEX and nothing upstream', () => {
  assert.match(APEX_DESKTOP_DEFAULT_SOUL, /You are APEX/)
  assert.doesNotMatch(APEX_DESKTOP_DEFAULT_SOUL, /Hermes|Nous Research/)
})

test('the hash table and the recorded upstream texts list the same seeds', () => {
  assert.deepEqual(UPSTREAM.map(soul => soul.sha256).sort(), Object.keys(UPSTREAM_SEEDED_SOULS).sort())

  for (const soul of UPSTREAM) {
    assert.equal(
      createHash('sha256').update(normalizedSoul(soul.text), 'utf8').digest('hex'),
      soul.sha256,
      soul.variant
    )
    assert.equal(UPSTREAM_SEEDED_SOULS[soul.sha256], soul.variant)
  }
})

// How each seeder left the text on disk: the Python write (no newline), the shell heredoc (one newline),
// Windows Set-Content -Encoding UTF8 (BOM + CRLF), and a plugin-era Bot Mode roster appended by the Desktop.
const ON_DISK: [string, (text: string) => string][] = [
  ['as written by the engine', text => text],
  ['install.sh heredoc', text => `${text}\n`],
  ['install.ps1 Set-Content', text => `\uFEFF${text.replace(/\n/g, '\r\n')}\r\n`],
  ['with the legacy Bot Mode section', text => `${text}${BOT_MODE_SECTION}`]
]

describe('an untouched upstream SOUL.md becomes the APEX identity', () => {
  for (const soul of UPSTREAM) {
    for (const [form, render] of ON_DISK) {
      test(`${soul.variant} (${form})`, () => {
        const { home, soulPath } = homeWithSoul(render(soul.text))

        assert.deepEqual(ensureApexDesktopSoul(home), { kind: 'replaced', variant: soul.variant })
        assert.equal(fs.readFileSync(soulPath, 'utf8'), APEX_FILE)
        assert.deepEqual(fs.readdirSync(home), ['SOUL.md'])

        if (POSIX) {
          assert.equal(fs.statSync(soulPath).mode & 0o777, 0o600)
        }
      })
    }
  }
})

// Reverse table: one character of user intent anywhere keeps the file byte for byte.
const EDITS: [string, (text: string) => string][] = [
  ['a sentence appended', text => `${text}\nAlways answer in Chinese.`],
  ['a line prepended', text => `你叫小A。\n${text}`],
  ['one character changed', text => text.replace(/.$/su, '!')],
  ['a second H2 section kept after Bot Mode', text => `${text}${BOT_MODE_SECTION}\n## My rules\nBe brief.\n`]
]

describe('a SOUL.md the user touched is kept byte for byte', () => {
  for (const soul of UPSTREAM) {
    for (const [edit, apply] of EDITS) {
      test(`${soul.variant} with ${edit}`, () => {
        const content = apply(soul.text)
        const { home, soulPath } = homeWithSoul(content)

        assert.deepEqual(ensureApexDesktopSoul(home), { kind: 'kept' })
        assert.equal(fs.readFileSync(soulPath, 'utf8'), content)
      })
    }
  }

  for (const [label, content] of [
    ['a persona of their own', 'My own assistant identity.\nDo not replace me.\n'],
    ['an emptied file', ''],
    ['whitespace only', ' \n\n'],
    ['the APEX identity with an edit', `${APEX_DESKTOP_DEFAULT_SOUL} Reply in English.\n`]
  ]) {
    test(label, () => {
      const { home, soulPath } = homeWithSoul(content)

      assert.deepEqual(ensureApexDesktopSoul(home), { kind: 'kept' })
      assert.equal(fs.readFileSync(soulPath, 'utf8'), content)
    })
  }

  test.runIf(POSIX)('a symlink to an upstream text', () => {
    const { home, soulPath } = homeWithSoul(UPSTREAM[0].text, 'linked/SOUL.md')
    const link = path.join(home, 'SOUL.md')
    fs.symlinkSync(soulPath, link)

    assert.deepEqual(ensureApexDesktopSoul(home), { kind: 'kept' })
    assert.equal(fs.readlinkSync(link), soulPath)
    assert.equal(fs.readFileSync(soulPath, 'utf8'), UPSTREAM[0].text)
  })

  test('a save that lands between the read and the swap', () => {
    const upstream = UPSTREAM.find(soul => soul.variant === 'default-2026-08-29')!
    const { home, soulPath } = homeWithSoul(upstream.text)
    const userSave = `${upstream.text}\nMy edit.`
    const write = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
      if (String(target).endsWith('.tmp')) {
        write(soulPath, userSave, 'utf8')
      }

      return write(target, data, options)
    })

    assert.deepEqual(ensureApexDesktopSoul(home), { kind: 'kept' })
    assert.equal(fs.readFileSync(soulPath, 'utf8'), userSave)
    assert.deepEqual(fs.readdirSync(home), ['SOUL.md'])
  })
})

test('a missing SOUL.md gets the APEX identity; the APEX identity is left as is', () => {
  const home = temporaryHome()

  assert.deepEqual(ensureApexDesktopSoul(home), { kind: 'created' })
  assert.equal(fs.readFileSync(path.join(home, 'SOUL.md'), 'utf8'), APEX_FILE)

  const crlf = `${APEX_DESKTOP_DEFAULT_SOUL}\r\n`
  fs.writeFileSync(path.join(home, 'SOUL.md'), crlf, 'utf8')
  assert.deepEqual(ensureApexDesktopSoul(home), { kind: 'current' })
  assert.equal(fs.readFileSync(path.join(home, 'SOUL.md'), 'utf8'), crlf)
})

describe('named profiles', () => {
  const upstream = () => UPSTREAM.find(soul => soul.variant === 'default-2026-03-26')!

  test('get the same upgrade, and no profile gains a SOUL.md it did not have', () => {
    const { home } = homeWithSoul(upstream().text, 'profiles/work/SOUL.md')

    const write = (relative: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(home, relative)), { recursive: true })
      fs.writeFileSync(path.join(home, relative), content, 'utf8')
    }

    write('profiles/writer/SOUL.md', '# Writer\n\nYou are Writer, a persistent named agent.\n')
    write('profiles/.work.staging-42/SOUL.md', upstream().text)
    fs.mkdirSync(path.join(home, 'profiles', 'not-a-profile'))
    write('profiles/stray-file', upstream().text)

    assert.deepEqual(upgradeProfileSouls(home), {
      work: { kind: 'replaced', variant: 'default-2026-03-26' },
      writer: { kind: 'kept' }
    })
    assert.equal(fs.readFileSync(path.join(home, 'profiles', 'work', 'SOUL.md'), 'utf8'), APEX_FILE)
    assert.equal(fs.readFileSync(path.join(home, 'profiles', '.work.staging-42', 'SOUL.md'), 'utf8'), upstream().text)
    assert.equal(fs.existsSync(path.join(home, 'profiles', 'not-a-profile', 'SOUL.md')), false)
  })

  test.runIf(POSIX && process.getuid?.() !== 0)('one profile that cannot be written does not stop the rest', () => {
    const { home } = homeWithSoul(upstream().text, 'profiles/locked/SOUL.md')
    fs.mkdirSync(path.join(home, 'profiles', 'open'))
    fs.writeFileSync(path.join(home, 'profiles', 'open', 'SOUL.md'), upstream().text, 'utf8')
    fs.chmodSync(path.join(home, 'profiles', 'locked'), 0o500)

    try {
      assert.deepEqual(upgradeProfileSouls(home), {
        locked: { kind: 'failed' },
        open: { kind: 'replaced', variant: 'default-2026-03-26' }
      })
      assert.equal(fs.readFileSync(path.join(home, 'profiles', 'locked', 'SOUL.md'), 'utf8'), upstream().text)
    } finally {
      fs.chmodSync(path.join(home, 'profiles', 'locked'), 0o700)
    }
  })
})

describe('boot logs one [soul] line either way', () => {
  test('fresh home', () => {
    assert.equal(ensureApexDesktopSouls(temporaryHome()), 'default: created APEX default')
  })

  test('liuxinli-style home: 08-14 installer text in the default profile', () => {
    const { home } = homeWithSoul(`${UPSTREAM.find(soul => soul.variant === 'default-2026-03-26')!.text}\n`)

    assert.equal(
      ensureApexDesktopSouls(home),
      'default: replaced untouched upstream SOUL.md (default-2026-03-26) with APEX default'
    )
    assert.equal(ensureApexDesktopSouls(home), 'default: APEX default in place')
  })

  test('user persona kept, profiles mixed', () => {
    const { home } = homeWithSoul('Mine.\n')
    const upstream = UPSTREAM.find(soul => soul.variant === 'default-2026-08-29')!
    fs.mkdirSync(path.join(home, 'profiles', 'work'), { recursive: true })
    fs.writeFileSync(path.join(home, 'profiles', 'work', 'SOUL.md'), upstream.text, 'utf8')
    fs.mkdirSync(path.join(home, 'profiles', 'writer'), { recursive: true })
    fs.writeFileSync(path.join(home, 'profiles', 'writer', 'SOUL.md'), 'Writer.\n', 'utf8')

    assert.equal(
      ensureApexDesktopSouls(home),
      'default: kept user SOUL.md; profiles: replaced work (default-2026-08-29), 1 unchanged'
    )
  })
})
