// What runtime-bundle-owned-cleanup-gate.mjs accepts as a green native run of
// runtime-bundle-offline-smoke.node-test.mjs on Windows. The executable-lock proof needs the locking
// test itself to run and pass. Any other test in that file may skip on Windows only when it is listed
// here with the place its Windows behavior is proven instead. Platform-independent, so it is tested on
// every runner (owned-cleanup-gate-tap.node-test.mjs).

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
