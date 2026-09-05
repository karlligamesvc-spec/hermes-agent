import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { APEX_DESKTOP_DEFAULT_SOUL, ensureApexDesktopSoul } from './apex-default-soul'

const temporaryRoots: string[] = []

function temporaryHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-desktop-soul-'))
  temporaryRoots.push(root)

  return path.join(root, '.apex')
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('a new APEX Desktop home receives the APEX product identity', () => {
  const home = temporaryHome()

  assert.equal(ensureApexDesktopSoul(home), 'created')
  assert.equal(fs.readFileSync(path.join(home, 'SOUL.md'), 'utf8'), `${APEX_DESKTOP_DEFAULT_SOUL}\n`)
  assert.match(APEX_DESKTOP_DEFAULT_SOUL, /APEX/)
  assert.doesNotMatch(APEX_DESKTOP_DEFAULT_SOUL, /Hermes|Nous Research/)
})

test('an existing user SOUL is preserved byte for byte', () => {
  const home = temporaryHome()
  const soulPath = path.join(home, 'SOUL.md')
  const userSoul = 'My own assistant identity.\nDo not replace me.\n'
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(soulPath, userSoul, 'utf8')

  assert.equal(ensureApexDesktopSoul(home), 'existing')
  assert.equal(fs.readFileSync(soulPath, 'utf8'), userSoul)
})
