const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const { MacTargetHelper } = require('app-builder-lib/out/mac/MacTargetHelper')
const dynamicImport = require('app-builder-lib/out/util/dynamicImport')
const { resolveFunction } = require('app-builder-lib/out/util/resolve')
const { AsyncEventEmitter } = require('app-builder-lib/out/util/asyncEventEmitter')

const workflowPath = path.resolve(__dirname, '../../../.github/workflows/desktop-macos.yml')
const windowsWorkflowPath = path.resolve(__dirname, '../../../.github/workflows/desktop-windows.yml')
const synchronizedWorkflowPath = path.resolve(__dirname, '../../../.github/workflows/desktop-release.yml')

test('actual electron-builder uses one App notarization and propagates rejection without a second afterSign submission', async t => {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).build
  assert.equal(config.mac.notarize, true)
  assert.equal(config.mac.hardenedRuntime, true)
  const hook = await resolveFunction('module', config.afterSign, 'afterSign', path.resolve(__dirname, '..'))
  assert.equal(hook, undefined, 'App already notarized by electron-builder must not be submitted again')
  const emitter = new AsyncEventEmitter()
  emitter.on('afterSign', hook, 'user')

  const keys = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE']
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const importBefore = dynamicImport.dynamicImport
  t.after(() => {
    dynamicImport.dynamicImport = importBefore
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key]
      else process.env[key] = before[key]
    }
  })
  for (const key of keys) delete process.env[key]
  process.env.APPLE_API_KEY = '/owned-fixture/notary.p8'
  process.env.APPLE_API_KEY_ID = 'owned-fixture-key-id'
  process.env.APPLE_API_ISSUER = 'owned-fixture-issuer'
  const calls = []
  let rejected = false
  dynamicImport.dynamicImport = async name => {
    assert.equal(name, '@electron/notarize')
    return { notarize: async options => {
      calls.push(options)
      if (rejected) throw new Error('owned fixture notarization rejected')
    } }
  }
  const helper = new MacTargetHelper({ platformSpecificBuildOptions: config.mac })
  await helper.notarizeIfProvided('/owned-fixture/APEX.app')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].appPath, '/owned-fixture/APEX.app')
  assert.equal(calls[0].appleApiKey, '/owned-fixture/notary.p8')
  assert.deepEqual(await emitter.emit('afterSign', {}), { emittedSystem: false, emittedUser: false })
  assert.equal(calls.length, 1)
  rejected = true
  await assert.rejects(helper.notarizeIfProvided('/owned-fixture/APEX.app'), /notarization rejected/)
})

function workflowSource() {
  return fs.readFileSync(workflowPath, 'utf8')
}

function namedStep(source, name) {
  const start = source.indexOf(`      - name: ${name}`)
  assert.notEqual(start, -1, `missing workflow step: ${name}`)

  const nextStep = source.indexOf('\n      - name:', start + 1)
  return source.slice(start, nextStep === -1 ? source.length : nextStep)
}

function bashRunBody(step) {
  const match = step.match(/\n        run: \|\n([\s\S]*)/)
  assert.ok(match, 'workflow step has no multiline run body')
  return match[1]
    .split('\n')
    .map(line => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n')
}

test('manual macOS builds are artifact-only and the release workflow owns production publish', () => {
  const source = workflowSource()
  const dispatchBlock = source.slice(source.indexOf('  workflow_dispatch:'), source.indexOf('\npermissions:'))
  const publishStep = namedStep(
    source,
    'Publish installer + updater feed to COS (skipped when secrets absent)'
  )

  assert.doesNotMatch(dispatchBlock, /inputs:/)
  assert.match(publishStep, /if: \$\{\{ inputs\.publish \}\}/)
  assert.match(publishStep, /upload-desktop-cos\.py/)
})

test('actual Mac publish shell uploads assets before feed and stops when the shared uploader rejects an asset', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-cos-order-'))
  const release = path.join(root, 'apps/desktop/release')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(release, { recursive: true })
  fs.mkdirSync(bin)
  for (const name of ['APEX-0.17.50-mac-arm64.dmg', 'APEX-0.17.50-mac-arm64.zip', 'APEX-0.17.50-mac-arm64.zip.blockmap', 'latest-mac.yml']) {
    fs.writeFileSync(path.join(release, name), 'fixture')
  }
  const log = path.join(root, 'calls')
  fs.writeFileSync(path.join(bin, 'pip3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'python3'), `#!/bin/sh
printf '%s\\n' "$5" >> "$CALLS"
printf '%s\\n' "$6" >> "$CALLS.flags"
case "$5" in *dmg) [ "$FAIL_ASSET" = 1 ] && exit 1 ;; esac
exit 0
`, { mode: 0o755 })
  const script = bashRunBody(namedStep(workflowSource(), 'Publish installer + updater feed to COS (skipped when secrets absent)'))
    .replaceAll('${{ matrix.arch }}', 'arm64')
  try {
    for (const fails of [false, true]) {
      fs.rmSync(log, { force: true })
      fs.rmSync(`${log}.flags`, { force: true })
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: log, FAIL_ASSET: fails ? '1' : '0', COS_SECRET_ID: 'fixture-id', COS_SECRET_KEY: 'fixture-secret' },
        encoding: 'utf8'
      })
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
      assert.equal(result.status, fails ? 1 : 0, result.stderr)
      assert.equal(calls.at(-1), fails ? 'desktop/mac-arm64/APEX-0.17.50-mac-arm64.dmg' : 'desktop/mac-arm64/latest-mac.yml')
      assert.equal(calls.length, fails ? 1 : 4)
      // The hosted US runner has no outer bound: every upload must size its own budget.
      const flags = fs.readFileSync(`${log}.flags`, 'utf8').trim().split('\n')
      assert.deepEqual(flags, calls.map(() => '--budget-from-size'))
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Windows keeps the default uploader budget under its own outer bound', () => {
  // Its Stop-Process ends only the uploader parent; a longer inner budget there would
  // leave a transfer worker running behind the next outer attempt.
  const publishStep = namedStep(fs.readFileSync(windowsWorkflowPath, 'utf8'), 'Publish installer + updater feed to Tencent COS')
  assert.match(publishStep, /Invoke-BoundedProcess -FilePath \$python -TimeoutSeconds \$budget/)
  assert.match(publishStep, /"scripts\/release\/upload-desktop-cos\.py", "--file", \$LocalPath, "--key", \$Key, "--windows-release"\)/)
  assert.doesNotMatch(publishStep, /--budget-from-size/)
})

test('Gatekeeper rejection fails the signed macOS build', () => {
  const gatekeeperStep = namedStep(
    workflowSource(),
    'Gatekeeper assessment (fails if not notarized)'
  )

  assert.match(gatekeeperStep, /spctl --assess --type execute -v "\$APP"/)
  assert.doesNotMatch(gatekeeperStep, /::warning::/)
  assert.doesNotMatch(gatekeeperStep, /exit 0/)
})

test('macOS matrix stages and reads back the requested package architecture', () => {
  const source = workflowSource()
  const architectureStep = namedStep(source, 'Assert packaged target architecture')

  assert.match(source, /npm_config_arch: \$\{\{ matrix\.arch \}\}/)
  assert.match(architectureStep, /EXPECTED_ARCH: \$\{\{ matrix\.arch \}\}/)
  assert.match(architectureStep, /assert-macos-package-arch\.mjs "\$APP" "\$EXPECTED_ARCH"/)
})

test('the macOS matrix builds only arm64 and the parity readback covers exactly what it builds', async () => {
  // Mac x64 (Intel) stopped after 0.17.63. A feed built but not read back would advance
  // unchecked; one read back but not built fails every release.
  const source = workflowSource()
  const matrixAt = source.indexOf('      matrix:')
  assert.notEqual(matrixAt, -1, 'missing build matrix')
  const matrix = source.slice(matrixAt, source.indexOf('\n    steps:', matrixAt))
  const arches = [...matrix.matchAll(/^ +- arch: (\S+)$/gm)].map(match => match[1])
  assert.deepEqual(arches, ['arm64'])
  assert.doesNotMatch(source, /runner: macos-\d+-intel/)

  const { MAC_FEEDS, WINDOWS_FEED } = await import(pathToFileURL(path.resolve(__dirname, 'verify-cross-platform-release.mjs')).href)
  assert.deepEqual(MAC_FEEDS.map(feed => feed.platform), arches.map(arch => `mac-${arch}`))
  // A release with windows=true reads back exactly the prefix the Windows publish job writes.
  const prefixes = [...fs.readFileSync(windowsWorkflowPath, 'utf8').matchAll(/-Prefix "([^"]+)"/g)].map(match => match[1])
  assert.deepEqual(prefixes, ['desktop/win-x64'])
  assert.equal(new URL(WINDOWS_FEED.url).pathname, '/desktop/win-x64/latest.yml')
})

test('direct single-platform dispatches are artifact-only', () => {
  const mac = workflowSource()
  const windows = fs.readFileSync(windowsWorkflowPath, 'utf8')

  for (const [platform, source] of [['macOS', mac], ['Windows', windows]]) {
    assert.match(source, /workflow_call:\n[\s\S]*?publish:\n[\s\S]*?type: boolean/)
    assert.doesNotMatch(source, /workflow_dispatch:\n\s+inputs:/)
    assert.match(
      source,
      /if: \$\{\{ inputs\.publish \}\}/,
      `${platform} publish job/step is not gated by the reusable-only input`
    )
    assert.match(source, /source_sha: \$\{\{ steps\.release-identity\.outputs\.source_sha \}\}/)
    assert.match(source, /version: \$\{\{ steps\.release-identity\.outputs\.version \}\}/)
  }
})

test('Windows packaging reads back APEX PE metadata and exports proof', () => {
  const source = fs.readFileSync(windowsWorkflowPath, 'utf8')
  const identityStep = namedStep(source, 'Assert packaged APEX PE identity')

  assert.match(identityStep, /assert-exe-identity\.mjs release\/win-unpacked\/APEX\.exe/)
  assert.match(identityStep, /identity_verified=true/)
  assert.match(source, /identity_verified: \$\{\{ steps\.exe-identity\.outputs\.identity_verified \}\}/)
  assert.match(source, /value: \$\{\{ jobs\.build\.outputs\.identity_verified \}\}/)
})

test('release identity steps are valid Bash on both platform workflows', () => {
  const sources = [workflowSource(), fs.readFileSync(windowsWorkflowPath, 'utf8')]

  for (const source of sources) {
    const script = bashRunBody(namedStep(source, 'Record release identity'))
    const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(script, /process\.stdout\.write\('version='/)
    assert.doesNotMatch(script, /node -p \\"/)
  }
})

function releaseJobs(source) {
  const jobs = source.slice(source.indexOf('\njobs:\n'))
  const heads = [...jobs.matchAll(/^ {2}([a-z][\w-]*):$/gm)]
  return Object.fromEntries(heads.map((match, index) => [match[1], jobs.slice(match.index, heads[index + 1]?.index ?? jobs.length)]))
}

function releaseInputs(source) {
  const block = source.slice(source.indexOf('  workflow_dispatch:'), source.indexOf('\npermissions:'))
  return Object.fromEntries([...block.matchAll(/^ {6}([a-z][\w-]*):\n((?: {8}.*\n)+)/gm)].map(match => [match[1], match[2]]))
}

function runStep(source, name, { env = {}, cwd, path: extraPath } = {}) {
  const script = bashRunBody(namedStep(source, name))
  return spawnSync('bash', ['-c', script], {
    cwd,
    env: { ...process.env, ...(extraPath ? { PATH: `${extraPath}:${process.env.PATH}` } : {}), ...env },
    encoding: 'utf8'
  })
}

test('the release builds Mac arm64 every time and Windows x64 only when dispatched with windows=true', () => {
  // Windows ships at fixed versions the owner names; every other release leaves desktop/win-x64/ alone.
  const source = fs.readFileSync(synchronizedWorkflowPath, 'utf8')
  const jobs = releaseJobs(source)
  const inputs = releaseInputs(source)

  assert.deepEqual(Object.keys(jobs), ['macos', 'windows', 'verify-release-parity'])
  assert.deepEqual(Object.keys(inputs), ['publish', 'windows'])
  for (const [name, block] of Object.entries(inputs)) {
    assert.match(block, /^ {8}type: boolean$/m, `${name} must be a boolean input`)
    assert.match(block, /^ {8}default: false$/m, `${name} must default to false`)
  }
  // A misspelt input in an if: or env: evaluates to empty, which would silently drop Windows.
  for (const [, name] of source.matchAll(/\binputs\.([A-Za-z_][\w-]*)/g)) {
    assert.ok(name in inputs, `desktop-release.yml reads an undeclared input: inputs.${name}`)
  }

  assert.match(jobs.macos, /^ {4}uses: \.\/\.github\/workflows\/desktop-macos\.yml$/m)
  assert.doesNotMatch(jobs.macos, /^ {4}if:/m, 'Mac arm64 is built by every release')
  assert.match(jobs.macos, /^ {6}publish: \$\{\{ inputs\.publish \}\}$/m)

  assert.match(jobs.windows, /^ {4}uses: \.\/\.github\/workflows\/desktop-windows\.yml$/m)
  assert.match(jobs.windows, /^ {4}if: \$\{\{ inputs\.windows \}\}$/m)
  assert.match(jobs.windows, /^ {6}publish: \$\{\{ inputs\.publish \}\}$/m)

  const parity = jobs['verify-release-parity']
  assert.match(parity, /^ {4}needs: \[macos, windows\]$/m)
  // Without a status function the skipped windows job would skip the readback of a Mac-only release.
  assert.match(parity, /^ {4}if: \$\{\{ !cancelled\(\) && needs\.macos\.result == 'success' \}\}$/m)
  assert.match(namedStep(source, 'Assert the Windows workflow packaged the same release identity'), /^ {8}if: \$\{\{ inputs\.windows \}\}$/m)
  assert.match(namedStep(source, 'Assert the production updater feed advanced'), /^ {8}if: \$\{\{ inputs\.publish \}\}$/m)
})

test('only desktop-release.yml calls desktop-windows.yml, from its windows-gated job', () => {
  // A direct dispatch has no publish input (see the artifact-only test above); a workflow_call
  // with publish is the only way to run the job that advances desktop/win-x64/.
  const dir = path.dirname(windowsWorkflowPath)
  const callers = fs.readdirSync(dir)
    .filter(name => /\.ya?ml$/.test(name))
    .filter(name => /^\s*uses:\s*\.\/\.github\/workflows\/desktop-windows\.ya?ml\b/m.test(fs.readFileSync(path.join(dir, name), 'utf8')))
  assert.deepEqual(callers, ['desktop-release.yml'])

  const jobs = releaseJobs(fs.readFileSync(synchronizedWorkflowPath, 'utf8'))
  const calling = Object.entries(jobs).filter(([, block]) => /desktop-windows\.ya?ml/.test(block)).map(([name]) => name)
  assert.deepEqual(calling, ['windows'])
})

test('the parity job fails unless the run built exactly the platforms it was asked for', () => {
  const source = fs.readFileSync(synchronizedWorkflowPath, 'utf8')
  for (const [windows, result, status] of [
    ['true', 'success', 0],
    ['true', 'failure', 1],
    ['true', 'cancelled', 1],
    ['true', 'skipped', 1],
    ['false', 'skipped', 0],
    ['false', 'success', 1],
    ['', 'skipped', 1]
  ]) {
    const run = runStep(source, 'Assert the run built exactly the platforms it was asked for', {
      env: { RELEASE_WINDOWS: windows, WINDOWS_RESULT: result }
    })
    assert.equal(run.status, status, `windows=${JSON.stringify(windows)} result=${result}: ${run.stdout}${run.stderr}`)
  }
})

test('the Windows identity check rejects a package that differs from the Mac one or the pins', () => {
  const source = fs.readFileSync(synchronizedWorkflowPath, 'utf8')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-release-identity-'))
  const sha = 'a'.repeat(40)
  const pin = { runtime_commit: 'b'.repeat(40), runtime_version: 'v2026.11.07-fork.bbbbbbbb' }
  fs.mkdirSync(path.join(root, 'apps/desktop'), { recursive: true })
  fs.writeFileSync(path.join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '0.17.73' }))
  fs.writeFileSync(path.join(root, 'apps/desktop/bundled-runtime.json'), JSON.stringify(pin))
  const mac = {
    CALLER_SHA: sha, MAC_SHA: sha, MAC_VERSION: '0.17.73',
    MAC_RUNTIME_COMMIT: pin.runtime_commit, MAC_RUNTIME_VERSION: pin.runtime_version
  }
  const windows = {
    CALLER_SHA: sha, MAC_VERSION: '0.17.73', WINDOWS_SHA: sha, WINDOWS_VERSION: '0.17.73',
    WINDOWS_RUNTIME_COMMIT: pin.runtime_commit, WINDOWS_RUNTIME_VERSION: pin.runtime_version,
    WINDOWS_IDENTITY_VERIFIED: 'true'
  }
  try {
    const macRun = runStep(source, 'Assert the macOS workflow packaged the release identity', { cwd: root, env: mac })
    assert.equal(macRun.status, 0, macRun.stderr)
    for (const [label, override, status] of [
      ['one release identity', {}, 0],
      ['another commit', { WINDOWS_SHA: 'c'.repeat(40) }, 1],
      ['no commit reported', { WINDOWS_SHA: '' }, 1],
      ['another version than the package', { WINDOWS_VERSION: '0.17.66', MAC_VERSION: '0.17.66' }, 1],
      ['another version than Mac', { MAC_VERSION: '0.17.72' }, 1],
      ['PE identity not verified', { WINDOWS_IDENTITY_VERIFIED: '' }, 1],
      ['another engine commit', { WINDOWS_RUNTIME_COMMIT: 'd'.repeat(40) }, 1],
      ['another engine label', { WINDOWS_RUNTIME_VERSION: 'v2026.10.28-fork.d6af670c' }, 1]
    ]) {
      const run = runStep(source, 'Assert the Windows workflow packaged the same release identity', {
        cwd: root, env: { ...windows, ...override }
      })
      assert.equal(run.status, status, `${label}: ${run.stdout}${run.stderr}`)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the readback reads the Windows feed exactly when the run includes Windows', () => {
  const source = fs.readFileSync(synchronizedWorkflowPath, 'utf8')
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-release-readback-'))
  const calls = path.join(bin, 'calls')
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CALLS"\n', { mode: 0o755 })
  try {
    for (const [windows, args] of [
      ['true', 'scripts/verify-cross-platform-release.mjs --expected-version 0.17.73 --include-windows'],
      ['false', 'scripts/verify-cross-platform-release.mjs --expected-version 0.17.73']
    ]) {
      fs.rmSync(calls, { force: true })
      const run = runStep(source, 'Assert the production updater feed advanced', {
        path: bin, env: { CALLS: calls, EXPECTED_VERSION: '0.17.73', RELEASE_WINDOWS: windows }
      })
      assert.equal(run.status, 0, run.stderr)
      assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), [args])
    }
  } finally { fs.rmSync(bin, { recursive: true, force: true }) }
})

test('the production coordinator release identity check is valid Bash', () => {
  const source = fs.readFileSync(synchronizedWorkflowPath, 'utf8')
  const script = bashRunBody(
    namedStep(source, 'Assert the macOS workflow packaged the release identity')
  )
  const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(script, /PACKAGE_VERSION=/)
  assert.doesNotMatch(script, /node -p \\"/)
})

test('both platform workflows prove the legacy upgrade on a genuine F8 runtime built by F8 itself', () => {
  // hc-906: v0.22's dependencies (CPython 3.14, no PyYAML) cannot run F8's source, so a legacy tree faked
  // from F8 source plus the current bundle's dependencies fails the engine probe. Each workflow must build
  // F8's own runtime first and hand that tree to the smoke.
  const fixture = fs.readFileSync(path.resolve(__dirname, 'legacy-runtime-fixture.mjs'), 'utf8')
  const smoke = fs.readFileSync(path.resolve(__dirname, 'bundled-runtime-consumer-smoke.mts'), 'utf8')
  const f8 = fixture.match(/^export const F8 = '([0-9a-f]{40})'$/m)?.[1]
  assert.ok(f8, 'the fixture names its F8 commit')
  assert.equal(smoke.match(/^const F8 = '([0-9a-f]{40})'$/m)?.[1], f8, 'the fixture and the smoke must name the same F8')
  assert.match(fixture, /^export const F8_UV_VERSION = '\d+\.\d+\.\d+'$/m, "F8's builder must not fetch the latest uv")

  for (const file of [workflowPath, windowsWorkflowPath]) {
    const source = fs.readFileSync(file, 'utf8')
    const name = path.basename(file)
    const build = source.indexOf('node scripts/legacy-runtime-fixture.mjs --work "$RUNNER_TEMP/legacy-f8"')
    const smokeAt = source.indexOf('node --import tsx scripts/bundled-runtime-consumer-smoke.mts')
    assert.ok(build > 0, `${name} must build the F8 legacy runtime`)
    assert.ok(smokeAt > build, `${name} must build the F8 legacy runtime before the consumer smoke`)
    assert.ok(source.lastIndexOf(`git fetch --no-tags --depth 1 origin ${f8}`, build) > 0, `${name} must fetch F8 before building it`)
    assert.match(source.slice(smokeAt, source.indexOf('\n', smokeAt)), / --legacy-source "\$RUNNER_TEMP\/legacy-f8\/tree" /,
      `${name} must hand the genuine F8 tree to the smoke`)
  }
})
