import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, test } from 'vitest'

import {
  configUsesManagedRelay,
  DEFAULT_PROFILE,
  isProductAssistant,
  listProfileHomes,
  managedProfileHomes
} from './apex-profile-homes'

const RELAY = 'https://apex-nodes.com/relay/v1'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

const MANAGED_MODEL = `model:\n  default: apex-flash\n  provider: custom\n  base_url: "${RELAY}"\n  api_key: "sk-old"\n`
const BYOK_MODEL = 'model:\n  default: deepseek-v4-flash\n  provider: deepseek\n'

const RELAY_ENTRY = `custom_providers:\n  - name: Apex-nodes.com\n    base_url: "${RELAY}"\n    api_key: "sk-old"\n    model: apex-flash\n`

/** A root with one named profile per entry: `{ soul, config }`; config null = no config.yaml. */
function root(profiles: Record<string, { config?: null | string; soul?: boolean }>, rootConfig = MANAGED_MODEL) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-profile-homes-'))
  roots.push(dir)
  fs.writeFileSync(path.join(dir, 'config.yaml'), rootConfig)

  for (const [name, spec] of Object.entries(profiles)) {
    const home = path.join(dir, 'profiles', name)
    fs.mkdirSync(home, { recursive: true })

    if (spec.soul !== false) {
      fs.writeFileSync(path.join(home, 'SOUL.md'), `# ${name}\n`)
    }

    if (spec.config) {
      fs.writeFileSync(path.join(home, 'config.yaml'), spec.config)
    }
  }

  return dir
}

describe('listProfileHomes', () => {
  test('lists the root as default, then every directory under profiles/ that holds a SOUL.md', () => {
    const dir = root({ writer: {}, '.writer.staging-4242': {}, scratch: { soul: false } })
    fs.writeFileSync(path.join(dir, 'profiles', 'notes.txt'), 'not a profile')

    const homes = listProfileHomes(dir)

    assert.deepEqual(
      homes.map(home => home.profile),
      [DEFAULT_PROFILE, 'writer']
    )
    assert.equal(homes[0].home, dir)
    assert.equal(homes[0].configPath, path.join(dir, 'config.yaml'))
    assert.equal(homes[1].home, path.join(dir, 'profiles', 'writer'))
    assert.equal(homes[1].configPath, path.join(dir, 'profiles', 'writer', 'config.yaml'))
  })

  test('a root without profiles/ is the root alone', () => {
    const dir = root({})

    assert.deepEqual(
      listProfileHomes(dir).map(home => home.profile),
      [DEFAULT_PROFILE]
    )
    assert.deepEqual(
      listProfileHomes(path.join(dir, 'missing')).map(home => home.profile),
      [DEFAULT_PROFILE]
    )
  })
})

describe('configUsesManagedRelay', () => {
  test.each([
    ['the main model on the relay', MANAGED_MODEL, true],
    ['only the registered endpoint on the relay (main model is BYOK)', BYOK_MODEL + RELAY_ENTRY, true],
    [
      'the v12 providers dict on the relay',
      `${BYOK_MODEL}providers:\n  apex:\n    api: "${RELAY}"\n    api_key: "sk-old"\n`,
      true
    ],
    [
      'the endpoint by its seeded name on the relay host after a path rewrite',
      `custom_providers:\n  - name: Apex-nodes.com\n    base_url: "https://apex-nodes.com/relay"\n    api_key: "sk-old"\n`,
      true
    ],
    ['BYOK only', BYOK_MODEL, false],
    [
      'a custom endpoint on another host',
      'model:\n  provider: custom\n  base_url: "https://api.example.com/v1"\n  api_key: "sk-mine"\n',
      false
    ],
    [
      'the seeded name on another host',
      'custom_providers:\n  - name: Apex-nodes.com\n    base_url: "https://api.example.com/v1"\n    api_key: "sk-mine"\n',
      false
    ],
    ['an empty file', '', false]
  ])('%s', (_label, raw, expected) => {
    assert.equal(configUsesManagedRelay(raw, RELAY), expected)
  })
})

describe('managedProfileHomes', () => {
  test('keeps the root first even on BYOK, and only the named profiles on the managed relay', () => {
    const dir = root(
      {
        writer: { config: MANAGED_MODEL },
        editor: { config: BYOK_MODEL + RELAY_ENTRY },
        mine: { config: BYOK_MODEL },
        fresh: { config: null },
        '.writer.staging-7': { config: MANAGED_MODEL },
        loose: { config: MANAGED_MODEL, soul: false }
      },
      BYOK_MODEL
    )

    const homes = managedProfileHomes(dir, RELAY)

    assert.equal(homes[0].profile, DEFAULT_PROFILE)
    assert.deepEqual(
      homes
        .slice(1)
        .map(home => home.profile)
        .sort(),
      ['editor', 'writer']
    )
  })

  test('an unreadable config.yaml leaves that profile out instead of failing the list', () => {
    const dir = root({ writer: { config: MANAGED_MODEL }, editor: { config: MANAGED_MODEL } })

    const read = (configPath: string) => {
      if (configPath.includes(`${path.sep}editor${path.sep}`)) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }

      return fs.readFileSync(configPath, 'utf8')
    }

    assert.deepEqual(
      managedProfileHomes(dir, RELAY, read).map(home => home.profile),
      [DEFAULT_PROFILE, 'writer']
    )
  })
})

describe('isProductAssistant', () => {
  test.each([
    [
      'an assistant the product mode created (safe_dump, escaped name)',
      'ui_meta:\n  apex:\n    name: "\\u5C0F\\u7EA2\\u4E66"\n    shape: circle\n    color: \'#E5484D\'\n_ui_meta_revisions:\n  apex: 1\n',
      true
    ],
    [
      'an apex entry next to an upstream Bot-mode one',
      'ui_meta:\n  hermes-bots:\n    rune: spark\n  apex:\n    name: X\n',
      true
    ],
    ['an upstream Bot-mode profile', 'ui_meta:\n  hermes-bots:\n    rune: spark\n', false],
    ['an empty apex entry', 'ui_meta:\n  apex: {}\n', false],
    ['a null apex entry', 'ui_meta:\n  apex: null\n', false],
    ['apex as a list', 'ui_meta:\n  apex:\n    - name\n', false],
    ['apex at the top level, not under ui_meta', 'apex:\n  name: X\n', false],
    ['malformed YAML', 'ui_meta: [unclosed\n', false],
    ['an empty file', '', false]
  ])('%s', (_label, text, expected) => {
    const dir = root({})
    const home = path.join(dir, 'profiles', 'x')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'profile.yaml'), text)

    assert.equal(isProductAssistant(home), expected)
  })

  test('no profile.yaml at all is not a product assistant', () => {
    assert.equal(isProductAssistant(path.join(root({}), 'profiles', 'nowhere')), false)
  })
})
