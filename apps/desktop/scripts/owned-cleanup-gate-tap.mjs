// What runtime-bundle-owned-cleanup-gate.mjs accepts as a green native run of
// runtime-bundle-offline-smoke.node-test.mjs on Windows. The executable-lock proof needs the locking
// test itself to run and pass. Any other test in that file may skip on Windows only when it is listed
// here with the place its Windows behavior is proven instead. Platform-independent, so it is tested on
// every runner (owned-cleanup-gate-tap.node-test.mjs).

import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const WINDOWS_LOCKING_TEST =
  'native Windows tree shutdown releases an actual locked uv.exe and cleanup fails closed while locked'

export const ALLOWED_WINDOWS_SKIPS = Object.freeze([
  // hc-954: on Windows the release consumer smoke runs the shipped TUI on the bundled node.exe (tui-ok).
  'the TUI smoke accepts only the shipped build on the bundled Node, and only when it loads',
])

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Problems with a native focused run's TAP stdout; an empty list means the gate may proceed. */
export function nativeGreenRunProblems(tap) {
  const problems = []
  if (!/^# fail 0\b/m.test(tap) || /^not ok \d+ - /m.test(tap)) problems.push('a native focused test failed')
  const skipped = [...tap.matchAll(/^ok \d+ - (.+?) # SKIP\b/gm)].map(match => match[1].trim())
  for (const name of skipped) {
    if (!ALLOWED_WINDOWS_SKIPS.includes(name)) problems.push(`unexpected Windows skip: ${name}`)
  }
  // \r?: a Windows child may end its TAP lines with CRLF.
  const lockingPassed = new RegExp(`^ok \\d+ - ${escapeRegExp(WINDOWS_LOCKING_TEST)}\\r?$`, 'm').test(tap)
  if (!lockingPassed) problems.push('Windows locking test cannot be skipped')
  return problems
}

// The smoke tests import the helper under test by this exact specifier; the reversal points it at a
// mutated private copy of the helper.
export const SMOKE_HELPER_IMPORT = "'../../../scripts/runtime-bundle-offline-smoke.mjs'"

/**
 * The reversal's private copy of the smoke tests. It sits next to the checkout file, so every other
 * relative import and import.meta.url lookup resolves exactly as in the original (a copy in a temp dir
 * broke on #422's `../../../scripts/build-runtime-bundle.mjs` import); only the helper import changes.
 */
export function privateTestCopy(testPath, testSource, privateHelperPath, suffix) {
  if (testSource.split(SMOKE_HELPER_IMPORT).length - 1 !== 1) throw new Error('private test import must be unique')
  return {
    path: path.join(path.dirname(testPath), `.owned-lock-reversal-${suffix}.mjs`),
    source: testSource.replace(SMOKE_HELPER_IMPORT, JSON.stringify(pathToFileURL(privateHelperPath).href)),
  }
}

/** Relative module specifiers in `source`, as a file at `filePath` would import them, whose target is missing. */
export function unresolvedRelativeImports(filePath, source, exists) {
  const specifiers = [
    ...source.matchAll(/\bfrom\s+['"](\.\.?\/[^'"]+)['"]/g),
    ...source.matchAll(/\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g),
  ].map(match => match[1])
  return specifiers.filter(specifier => !exists(path.resolve(path.dirname(filePath), specifier)))
}
