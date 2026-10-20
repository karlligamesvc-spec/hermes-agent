import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { ALLOWED_WINDOWS_SKIPS, nativeGreenRunProblems, WINDOWS_LOCKING_TEST } from './owned-cleanup-gate-tap.mjs'

const smokeTests = fs.readFileSync(new URL('./runtime-bundle-offline-smoke.node-test.mjs', import.meta.url), 'utf8')
const gate = fs.readFileSync(new URL('./runtime-bundle-owned-cleanup-gate.mjs', import.meta.url), 'utf8')

// The TAP result lines of the Windows positive run in the 0.17.60 candidate (run 39468747897), which the
// old blanket `# skipped 0` assertion rejected although the locking test passed.
const CANDIDATE_RUN = [
  'TAP version 13',
  'ok 1 - the compiled TUI is planted as dist/ plus its module package.json, never over an existing build',
  'ok 2 - the TUI smoke accepts only the shipped build on the bundled Node, and only when it loads # SKIP',
  'ok 3 - backend smoke rejects failed spawn and early executable exit without hanging cleanup',
  'ok 4 - owned shutdown closes a real child without terminating an independent child',
  'ok 5 - native Windows tree shutdown releases an actual locked uv.exe and cleanup fails closed while locked',
  'ok 6 - native Python architecture guard accepts absent Windows processor hints and rejects the wrong target',
  'ok 7 - native model mutation metadata flush publishes a counter and preserves it after reopen',
  'ok 8 - the isolated smoke rejects real external socket attempts while allowing a local API socket',
  '1..8',
  '# tests 8',
  '# pass 7',
  '# fail 0',
  '# cancelled 0',
  '# skipped 1',
  '# todo 0',
].join('\n')

const edit = (from, to) => {
  assert.equal(CANDIDATE_RUN.split(from).length - 1, 1, `fixture anchor must be unique: ${from}`)
  return CANDIDATE_RUN.replace(from, to)
}

const cases = [
  ['the candidate run: locking test passed, only the listed TUI smoke skipped', CANDIDATE_RUN, []],
  ['the same run with CRLF line endings', CANDIDATE_RUN.replaceAll('\n', '\r\n'), []],
  ['the locking test skipped', edit('fails closed while locked\n', 'fails closed while locked # SKIP\n'),
    [`unexpected Windows skip: ${WINDOWS_LOCKING_TEST}`, 'Windows locking test cannot be skipped']],
  ['an unlisted test skipped', edit('without hanging cleanup\n', 'without hanging cleanup # SKIP\n'),
    ['unexpected Windows skip: backend smoke rejects failed spawn and early executable exit without hanging cleanup']],
  ['a failed test', edit('ok 3 - backend smoke', 'not ok 3 - backend smoke').replace('# fail 0', '# fail 1'),
    ['a native focused test failed']],
  ['the locking test missing from the run', edit('ok 5 - native Windows tree shutdown', 'ok 5 - renamed shutdown'),
    ['Windows locking test cannot be skipped']],
]

for (const [name, tap, expected] of cases) {
  test(`gate verdict: ${name}`, () => {
    assert.deepEqual(nativeGreenRunProblems(tap), expected)
  })
}

test('the locking test and every allowed Windows skip are real titles in the smoke tests', () => {
  for (const title of [WINDOWS_LOCKING_TEST, ...ALLOWED_WINDOWS_SKIPS]) {
    assert.ok(smokeTests.includes(`test('${title}'`), `${title} is not a test in runtime-bundle-offline-smoke.node-test.mjs`)
  }
  for (const title of ALLOWED_WINDOWS_SKIPS) {
    assert.ok(smokeTests.includes(`test('${title}', { skip: process.platform === 'win32' }`), `${title} no longer skips only on Windows`)
  }
})

test('the Windows gate judges its positive run with this check, not a blanket skip count', () => {
  assert.ok(gate.includes("import { nativeGreenRunProblems } from './owned-cleanup-gate-tap.mjs'"))
  assert.ok(gate.includes('assert.deepEqual(nativeGreenRunProblems(positive.stdout), []'))
  assert.ok(!gate.includes('/# skipped 0\\b/'), 'the blanket skip-count assertion is back')
})
