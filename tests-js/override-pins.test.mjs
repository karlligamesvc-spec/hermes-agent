/**
 * ApexNodes hc-911: every workspace pin on an overridden package admits the override.
 *
 * nix/lib.nix builds the npm workspace offline from package-lock.json with the root
 * `overrides` removed (importNpmLock rewrites direct specs to store tarballs, which conflict
 * with semver overrides). The lock records the override's version, so a workspace that pins
 * an overridden package to another version asks that override-free install for a version the
 * lock never fetched: `nix flake check` fails with ENOTCACHED. apps/desktop's exact
 * `js-yaml: 4.3.1` against the `js-yaml@^4: 4.3.2` override did exactly that.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { expect, test } from 'vitest'

const root = new URL('..', import.meta.url).pathname
const readJson = path => JSON.parse(readFileSync(join(root, path), 'utf8'))
const rootManifest = readJson('package.json')

function workspaceManifests() {
  const dirs = rootManifest.workspaces.flatMap(entry =>
    entry.endsWith('/*') ? readdirSync(join(root, entry.slice(0, -2))).map(d => `${entry.slice(0, -2)}/${d}`) : [entry])
  return ['.', ...dirs].filter(dir => existsSync(join(root, dir, 'package.json')))
}

// `name` or `name@range` -> the version the override forces.
function overrides() {
  return Object.entries(rootManifest.overrides ?? {})
    .filter(([, forced]) => typeof forced === 'string' && semver.valid(forced))
    .map(([key, forced]) => {
      const at = key.lastIndexOf('@')
      return at > 0 ? { name: key.slice(0, at), range: key.slice(at + 1), forced } : { name: key, range: null, forced }
    })
}

test('the scan sees the workspaces and at least one exact override', () => {
  expect(workspaceManifests()).toContain('apps/desktop')
  expect(overrides().some(o => o.name === 'js-yaml')).toBe(true)
})

test('no workspace pins an overridden package to a version the override never installs', () => {
  const conflicts = []
  for (const dir of workspaceManifests()) {
    const manifest = readJson(join(dir, 'package.json'))
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (!semver.validRange(spec)) continue
        for (const override of overrides()) {
          if (override.name !== name) continue
          if (override.range && !semver.satisfies(semver.minVersion(spec), override.range)) continue
          if (!semver.satisfies(override.forced, spec)) conflicts.push(`${dir} ${field}.${name}: ${spec} vs override ${override.forced}`)
        }
      }
    }
  }
  expect(conflicts).toEqual([])
})
