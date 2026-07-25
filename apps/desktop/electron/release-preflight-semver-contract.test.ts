/**
 * No-drift contract between the release preflight's INLINED semver copy and
 * the runtime gate's implementation.
 *
 * scripts/assert-release-preflight.cjs used to require() compareSemver from
 * this directory, but the electron tree is TypeScript now and the preflight
 * must stay a dependency-free node .cjs that runs before any build step — so
 * it carries an inlined copy. This table runs BOTH copies over the same
 * inputs; if someone ever edits one side (new pre-release syntax, different
 * v-prefix handling, four-part versions) without the other, this fails.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import { compareSemver as runtimeCompare, parseSemver as runtimeParse } from './apex-runtime-latest'

const require = createRequire(import.meta.url)

const preflight = require('../scripts/assert-release-preflight.cjs') as {
  parseSemver: (v: unknown) => number[] | null
  compareSemver: (a: unknown, b: unknown) => -1 | 0 | 1 | null
}

// Every shape either gate actually sees, plus the degenerate ones: shell
// semvers, cloud engine strings (calver + -fork.<sha> suffix), v-prefixes,
// partial versions, whitespace, garbage, empty, null.
const VALUES = [
  '0.16.11',
  '0.16.17',
  '0.17.0',
  'v0.17.0',
  '1.0',
  'v1',
  '2026.7.21',
  'v2026.7.21-fork.67296229',
  'v2026.7.25-fork.b0a720a5',
  ' v3.2.1 ',
  '0.17.0-beta.1',
  'not-a-version',
  '',
  null,
  undefined
] as const

describe('release-preflight semver copy stays in lockstep with the runtime gate', () => {
  it('parseSemver agrees on every value', () => {
    for (const v of VALUES) {
      expect(preflight.parseSemver(v), `parseSemver(${JSON.stringify(v)})`).toEqual(runtimeParse(v))
    }
  })

  it('compareSemver agrees on every ordered pair', () => {
    for (const a of VALUES) {
      for (const b of VALUES) {
        expect(preflight.compareSemver(a, b), `compareSemver(${JSON.stringify(a)}, ${JSON.stringify(b)})`).toBe(
          runtimeCompare(a, b)
        )
      }
    }
  })

  it('the preflight no longer requires the retired .cjs runtime module', () => {
    const src = readFileSync(require.resolve('../scripts/assert-release-preflight.cjs'), 'utf8')
    expect(src).not.toContain("require('../electron/apex-runtime-latest.cjs')")
  })
})
