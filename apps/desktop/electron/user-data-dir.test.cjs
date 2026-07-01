/**
 * Tests for electron/user-data-dir.cjs.
 *
 * Run with: node --test electron/user-data-dir.test.cjs
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * Data-continuity contract for the APEX brand rename: userData must keep
 * resolving to the pre-rename "ApexNodes" directory (where existing installs
 * hold connection.json / apex-managed.json = the managed login), and the
 * HERMES_DESKTOP_USER_DATA_DIR override must still win.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { LEGACY_USER_DATA_DIRNAME, resolveUserDataDir } = require('./user-data-dir.cjs')

test('pins userData to the legacy ApexNodes directory (existing installs keep their login)', () => {
  assert.equal(
    resolveUserDataDir('/Users/x/Library/Application Support', undefined),
    path.join('/Users/x/Library/Application Support', 'ApexNodes')
  )
})

test('legacy dirname is the pre-rename productName, not the new brand', () => {
  // If this ever changes, existing installs silently lose apex-managed.json
  // (their signed-in state). Changing it requires a data migration.
  assert.equal(LEGACY_USER_DATA_DIRNAME, 'ApexNodes')
  assert.notEqual(LEGACY_USER_DATA_DIRNAME, 'APEX')
})

test('HERMES_DESKTOP_USER_DATA_DIR override wins and is resolved absolute', () => {
  assert.equal(resolveUserDataDir('/Users/x/Library/Application Support', '/tmp/sandbox'), path.resolve('/tmp/sandbox'))
  assert.equal(resolveUserDataDir('/Users/x/Library/Application Support', 'relative/dir'), path.resolve('relative/dir'))
})

test('blank / whitespace override falls back to the legacy directory', () => {
  for (const override of ['', '   ', undefined, null]) {
    assert.equal(
      resolveUserDataDir('/appdata', override),
      path.join('/appdata', 'ApexNodes'),
      `override ${JSON.stringify(override)} should fall back`
    )
  }
})
