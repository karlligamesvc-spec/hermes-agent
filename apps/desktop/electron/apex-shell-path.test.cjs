const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  LOGIN_SHELL_PATH_SENTINEL,
  loginShellPathProbeArgs,
  mergePathEntries,
  parseLoginShellPath,
  posixUserBinDirCandidates,
  resolveAugmentedPath
} = require('./apex-shell-path.cjs')

// --- parseLoginShellPath ----------------------------------------------------

test('parseLoginShellPath extracts the value after the sentinel', () => {
  const out = `${LOGIN_SHELL_PATH_SENTINEL}/Users/u/.local/bin:/usr/bin:/bin\n`
  assert.equal(parseLoginShellPath(out), '/Users/u/.local/bin:/usr/bin:/bin')
})

test('parseLoginShellPath ignores rc-file noise on other lines', () => {
  const out = [
    'nvm: version 0.39',
    'Welcome banner!',
    `${LOGIN_SHELL_PATH_SENTINEL}/opt/homebrew/bin:/usr/bin`,
    'trailing prompt $ '
  ].join('\n')
  assert.equal(parseLoginShellPath(out), '/opt/homebrew/bin:/usr/bin')
})

test('parseLoginShellPath returns null when the sentinel is absent', () => {
  assert.equal(parseLoginShellPath('no path here\njust noise'), null)
})

test('parseLoginShellPath returns null for empty / blank value', () => {
  assert.equal(parseLoginShellPath(''), null)
  assert.equal(parseLoginShellPath(null), null)
  assert.equal(parseLoginShellPath(`${LOGIN_SHELL_PATH_SENTINEL}   `), null)
})

test('loginShellPathProbeArgs is a login+interactive command carrying the sentinel', () => {
  const args = loginShellPathProbeArgs()
  assert.equal(args[0], '-lic')
  assert.ok(args[1].includes(LOGIN_SHELL_PATH_SENTINEL))
  assert.ok(args[1].includes('$PATH'))
})

// --- posixUserBinDirCandidates ----------------------------------------------

test('posixUserBinDirCandidates lists the user bin dirs in priority order', () => {
  assert.deepEqual(posixUserBinDirCandidates('/Users/u', { pathModule: path.posix }), [
    '/Users/u/.local/bin',
    '/Users/u/.npm-global/bin',
    '/Users/u/bin',
    '/Users/u/.volta/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ])
})

test('posixUserBinDirCandidates returns [] with no home', () => {
  assert.deepEqual(posixUserBinDirCandidates('', { pathModule: path.posix }), [])
})

// --- mergePathEntries -------------------------------------------------------

test('mergePathEntries keeps base verbatim then appends missing, de-duplicated', () => {
  const out = mergePathEntries('/usr/bin:/bin', ['/usr/bin:/opt/homebrew/bin', ['/Users/u/.local/bin']], {
    delimiter: ':'
  })
  assert.equal(out, '/usr/bin:/bin:/opt/homebrew/bin:/Users/u/.local/bin')
})

test('mergePathEntries drops empty segments', () => {
  assert.equal(mergePathEntries(':/a::/b', ['/a', '', '/c'], { delimiter: ':' }), '/a:/b:/c')
})

// --- resolveAugmentedPath ---------------------------------------------------

test('resolveAugmentedPath is a Windows no-op', () => {
  const current = 'C:\\Windows;C:\\Windows\\System32'
  assert.equal(
    resolveAugmentedPath({
      currentPath: current,
      home: 'C:\\Users\\u',
      loginShellPath: 'C:\\anything',
      platform: 'win32',
      isDir: () => true
    }),
    current
  )
})

test('resolveAugmentedPath appends login-shell PATH then the static floor', () => {
  const existing = new Set([
    '/Users/u/.local/bin',
    '/opt/homebrew/bin',
    '/Users/u/.nvm/versions/node/v20.3.0/bin'
  ])
  const out = resolveAugmentedPath({
    currentPath: '/usr/bin:/bin',
    home: '/Users/u',
    loginShellPath: '/Users/u/.nvm/versions/node/v20.3.0/bin:/usr/bin',
    platform: 'darwin',
    isDir: dir => existing.has(dir),
    pathModule: path.posix
  })
  const entries = out.split(':')
  // Inherited entries keep precedence.
  assert.equal(entries[0], '/usr/bin')
  assert.equal(entries[1], '/bin')
  // Login-shell-only dir is appended (nvm current — the version manager the
  // static floor can't enumerate).
  assert.ok(entries.includes('/Users/u/.nvm/versions/node/v20.3.0/bin'))
  // Static floor dir that exists is appended...
  assert.ok(entries.includes('/Users/u/.local/bin'))
  assert.ok(entries.includes('/opt/homebrew/bin'))
  // ...but a non-existent static candidate is filtered out.
  assert.equal(entries.includes('/Users/u/.volta/bin'), false)
  // No duplicates.
  assert.equal(new Set(entries).size, entries.length)
})

test('resolveAugmentedPath falls back to the static floor when the probe fails', () => {
  const existing = new Set(['/Users/u/.local/bin', '/usr/local/bin'])
  const out = resolveAugmentedPath({
    currentPath: '/usr/bin:/bin',
    home: '/Users/u',
    loginShellPath: null, // probe timed out / produced nothing
    platform: 'darwin',
    isDir: dir => existing.has(dir),
    pathModule: path.posix
  })
  assert.equal(out, '/usr/bin:/bin:/Users/u/.local/bin:/usr/local/bin')
})

test('resolveAugmentedPath does not duplicate a dir already on PATH', () => {
  const out = resolveAugmentedPath({
    currentPath: '/opt/homebrew/bin:/usr/bin',
    home: '/Users/u',
    loginShellPath: '/opt/homebrew/bin:/usr/bin', // fully overlaps current
    platform: 'darwin',
    isDir: dir => dir === '/opt/homebrew/bin',
    pathModule: path.posix
  })
  const entries = out.split(':')
  assert.equal(entries.filter(e => e === '/opt/homebrew/bin').length, 1)
  assert.equal(entries[0], '/opt/homebrew/bin')
})

test('resolveAugmentedPath is idempotent', () => {
  const existing = new Set(['/Users/u/.local/bin', '/opt/homebrew/bin'])
  const opts = {
    home: '/Users/u',
    loginShellPath: '/opt/homebrew/bin',
    platform: 'darwin',
    isDir: dir => existing.has(dir),
    pathModule: path.posix
  }
  const once = resolveAugmentedPath({ ...opts, currentPath: '/usr/bin' })
  const twice = resolveAugmentedPath({ ...opts, currentPath: once })
  assert.equal(once, twice)
})

test('resolveAugmentedPath with empty home only adds home-independent existing dirs', () => {
  // No home → posixUserBinDirCandidates('') === [], so only the login-shell PATH
  // contributes; nothing home-relative is invented.
  const out = resolveAugmentedPath({
    currentPath: '/usr/bin',
    home: '',
    loginShellPath: '/some/tool/bin',
    platform: 'darwin',
    isDir: () => true,
    pathModule: path.posix
  })
  assert.equal(out, '/usr/bin:/some/tool/bin')
})
