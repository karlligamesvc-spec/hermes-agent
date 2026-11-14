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

  // A step ends at the next step, or at the next job / top-level key for a job's last step.
  const end = source.slice(start + 1).search(/\n(?: {6}- name:| {0,5}\S)/)
  return source.slice(start, end === -1 ? source.length : start + 1 + end)
}

// The step's own lines, without the comments that introduce the step after it.
function ownStepLines(step) {
  const lines = step.split('\n')
  const end = lines.findIndex((line, index) => index > 0 && !line.startsWith('        '))
  return lines.slice(0, end === -1 ? lines.length : end).join('\n')
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
  // The publish job (hc-1204) has its own matrix: it must publish exactly the arches built.
  const source = workflowSource()
  const jobs = releaseJobs(source)
  const matrixArches = block => {
    const matrixAt = block.indexOf('      matrix:')
    assert.notEqual(matrixAt, -1, 'missing matrix')
    return [...block.slice(matrixAt, block.indexOf('\n    steps:', matrixAt)).matchAll(/^ +- arch: (\S+)$/gm)].map(match => match[1])
  }
  const arches = matrixArches(jobs.build)
  assert.deepEqual(arches, ['arm64'])
  assert.deepEqual(matrixArches(jobs.publish), arches)
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
  // hc-1204: a promotion skips build and takes the proof from the candidate's build job.
  assert.match(source, /value: \$\{\{ jobs\.build\.outputs\.identity_verified \|\| jobs\.publish\.outputs\.identity_verified \}\}/)
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

  assert.deepEqual(Object.keys(jobs), ['candidate', 'macos', 'windows', 'verify-release-parity'])
  assert.deepEqual(Object.keys(inputs), ['publish', 'windows', 'candidate_run_id'])
  for (const name of ['publish', 'windows']) {
    assert.match(inputs[name], /^ {8}type: boolean$/m, `${name} must be a boolean input`)
    assert.match(inputs[name], /^ {8}default: false$/m, `${name} must default to false`)
  }
  // Empty means "build from source": a release only promotes when told which candidate.
  assert.match(inputs.candidate_run_id, /^ {8}type: string$/m)
  assert.match(inputs.candidate_run_id, /^ {8}default: ''$/m)
  // A misspelt input in an if: or env: evaluates to empty, which would silently drop Windows.
  for (const [, name] of source.matchAll(/\binputs\.([A-Za-z_][\w-]*)/g)) {
    assert.ok(name in inputs, `desktop-release.yml reads an undeclared input: inputs.${name}`)
  }

  // Mac arm64 is part of every release; only a failed or cancelled promotion gate stops it.
  const gateOpen = "!cancelled() && (needs.candidate.result == 'success' || needs.candidate.result == 'skipped')"
  assert.match(jobs.candidate, /^ {4}if: \$\{\{ inputs\.candidate_run_id != '' \}\}$/m)
  assert.match(jobs.macos, /^ {4}uses: \.\/\.github\/workflows\/desktop-macos\.yml$/m)
  assert.match(jobs.macos, /^ {4}needs: candidate$/m)
  assert.equal(jobs.macos.match(/^ {4}if: \$\{\{ (.*) \}\}$/m)?.[1], gateOpen)
  assert.match(jobs.macos, /^ {6}publish: \$\{\{ inputs\.publish \}\}$/m)
  assert.match(jobs.macos, /^ {6}candidate_run_id: \$\{\{ inputs\.candidate_run_id \}\}$/m)

  assert.match(jobs.windows, /^ {4}uses: \.\/\.github\/workflows\/desktop-windows\.yml$/m)
  assert.match(jobs.windows, /^ {4}needs: candidate$/m)
  assert.equal(jobs.windows.match(/^ {4}if: \$\{\{ (.*) \}\}$/m)?.[1], `inputs.windows && ${gateOpen}`)
  assert.match(jobs.windows, /^ {6}publish: \$\{\{ inputs\.publish \}\}$/m)
  assert.match(jobs.windows, /^ {6}candidate_run_id: \$\{\{ inputs\.candidate_run_id \}\}$/m)

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

// hc-1204: promotion. desktop-release.yml dispatched with candidate_run_id publishes the
// accepted candidate run's installer artifacts and builds nothing.
const PROMOTION_PLATFORMS = [
  { file: workflowPath, platform: 'mac-arm64', publishStep: 'Publish installer + updater feed to COS (skipped when secrets absent)' },
  { file: windowsWorkflowPath, platform: 'win-x64', publishStep: 'Publish installer + updater feed to Tencent COS' }
]

function stepNames(block) {
  return [...block.matchAll(/^ {6}- name: (.+)$/gm)].map(match => match[1])
}

function workflowCallBlock(source) {
  return source.slice(source.indexOf('  workflow_call:'), source.indexOf('  workflow_dispatch:'))
}

test('a promotion builds nothing and publishes only what passed both promotion checks', () => {
  const publishIf = "!cancelled() && (inputs.publish || inputs.candidate_run_id != '') && needs.preflight.result == 'success' && " +
    "(needs.build.result == 'success' || (inputs.candidate_run_id != '' && needs.build.result == 'skipped'))"
  for (const { file, platform, publishStep } of PROMOTION_PLATFORMS) {
    const name = path.basename(file)
    const source = fs.readFileSync(file, 'utf8')
    const jobs = releaseJobs(source)
    assert.match(workflowCallBlock(source), /^ {6}candidate_run_id:\n {8}description: .+\n {8}required: false\n {8}type: string\n {8}default: ''$/m, name)
    assert.equal(jobs.build.match(/^ {4}if: \$\{\{ (.*) \}\}$/m)?.[1], "inputs.candidate_run_id == ''", `${name} build must be skipped by a promotion`)
    assert.match(jobs.publish, /^ {4}needs: \[preflight, build\]$/m, name)
    assert.equal(jobs.publish.match(/^ {4}if: \$\{\{ (.*) \}\}$/m)?.[1], publishIf, name)
    assert.match(jobs.publish, /^ {4}permissions:\n {6}contents: read\n {6}actions: read$/m, `${name} publish must be able to read the candidate run`)

    // Order matters: nothing is downloaded from a candidate that was not checked, and
    // nothing is uploaded from a bundle that was not checked against its feed.
    const steps = stepNames(jobs.publish)
    const at = step => {
      assert.ok(steps.includes(step), `${name} publish has no step "${step}"`)
      return steps.indexOf(step)
    }
    assert.ok(at('Record release identity') < at('Verify the accepted candidate run'), name)
    assert.ok(at('Verify the accepted candidate run') < at("Download the accepted candidate's installer artifact"), name)
    assert.ok(at("Download the accepted candidate's installer artifact") < at('Verify the release bundle against its updater feed'), name)
    assert.ok(at("Download this run's installer artifact") < at('Verify the release bundle against its updater feed'), name)
    assert.ok(at('Verify the release bundle against its updater feed') < at(publishStep), name)

    const platformArg = platform === 'mac-arm64' ? '"mac-${{ matrix.arch }}"' : platform
    const verifyRun = namedStep(jobs.publish, 'Verify the accepted candidate run')
    assert.match(verifyRun, /^ {8}if: \$\{\{ inputs\.candidate_run_id != '' \}\}$/m)
    assert.match(verifyRun, /^ {10}CANDIDATE_RUN_ID: \$\{\{ inputs\.candidate_run_id \}\}$/m)
    // The run id reaches the shell only through the environment, never as template text.
    assert.equal(verifyRun.match(/^ {8}run: (.*)$/m)?.[1],
      `node scripts/release-candidate-promotion.mjs candidate --run-id "$CANDIDATE_RUN_ID" --platform ${platformArg}`, name)
    const sameRun = namedStep(jobs.publish, "Download this run's installer artifact")
    assert.match(sameRun, /^ {8}if: \$\{\{ inputs\.candidate_run_id == '' \}\}$/m)
    assert.doesNotMatch(sameRun, /run-id:|github-token:/)
    const fromCandidate = namedStep(jobs.publish, "Download the accepted candidate's installer artifact")
    assert.match(fromCandidate, /^ {8}if: \$\{\{ inputs\.candidate_run_id != '' \}\}$/m)
    assert.match(fromCandidate, /^ {10}run-id: \$\{\{ inputs\.candidate_run_id \}\}$/m)
    assert.match(fromCandidate, /^ {10}github-token: \$\{\{ github\.token \}\}$/m)
    const bundle = namedStep(jobs.publish, 'Verify the release bundle against its updater feed')
    assert.doesNotMatch(bundle, /^ {8}if:/m, `${name} must check every bundle it publishes`)
    assert.match(bundle, /RELEASE_VERSION: \$\{\{ steps\.release-identity\.outputs\.version \}\}/)
    assert.equal(bundle.match(/^ {8}run: (.*)$/m)?.[1],
      `node scripts/release-candidate-promotion.mjs bundle --dir release --platform ${platformArg} --expected-version "$RELEASE_VERSION"`, name)
    assert.match(namedStep(jobs.publish, publishStep), /^ {8}if: \$\{\{ inputs\.publish \}\}$/m, `${name} must upload only when publishing`)

    // The publish job reports the identity exactly as the build job does: same step body.
    assert.equal(ownStepLines(namedStep(jobs.publish, 'Record release identity')), ownStepLines(namedStep(jobs.build, 'Record release identity')), name)
    const outputs = workflowCallBlock(source).slice(workflowCallBlock(source).indexOf('    outputs:'))
    for (const [, output, value] of outputs.matchAll(/^ {6}([a-z_]+):\n(?: {8}#.*\n)*(?: {8}description: .*\n) {8}value: \$\{\{ (.*) \}\}$/gm)) {
      assert.equal(value, `jobs.build.outputs.${output} || jobs.publish.outputs.${output}`, `${name} output ${output} must survive a skipped build`)
    }
  }
})

test('the Windows promotion takes its PE identity proof from the candidate build', () => {
  const jobs = releaseJobs(fs.readFileSync(windowsWorkflowPath, 'utf8'))
  assert.match(jobs.publish, /^ {6}identity_verified: \$\{\{ steps\.candidate\.outputs\.verified \}\}$/m)
  assert.match(namedStep(jobs.publish, 'Verify the accepted candidate run'), /^ {8}id: candidate$/m)
})

test('the Mac artifact carries everything its publish step uploads', () => {
  const jobs = releaseJobs(workflowSource())
  const upload = namedStep(jobs.build, 'Upload installer artifact')
  const paths = [...upload.matchAll(/^ {12}apps\/desktop\/release\/(\S+)$/gm)].map(match => match[1])
  assert.deepEqual(paths, ['*.dmg', '*.zip', '*.blockmap', 'latest-mac.yml'])
  assert.match(upload, /^ {10}if-no-files-found: error$/m)
  const loop = bashRunBody(namedStep(jobs.publish, 'Publish installer + updater feed to COS (skipped when secrets absent)')).match(/^for f in (.*); do$/m)?.[1]
  assert.deepEqual(loop?.split(' '), paths, 'the publish loop uploads exactly the artifact set, feed last')
})

test('the promotion gate names the jobs, steps and artifacts the workflows really have', async () => {
  const { PLATFORMS } = await import(pathToFileURL(path.resolve(__dirname, 'release-candidate-promotion.mjs')).href)
  const callers = releaseJobs(fs.readFileSync(synchronizedWorkflowPath, 'utf8'))
  for (const [platform, caller, file, arch] of [
    ['mac-arm64', callers.macos, workflowPath, 'arm64'],
    ['win-x64', callers.windows, windowsWorkflowPath, 'x64']
  ]) {
    const spec = PLATFORMS[platform]
    const jobs = releaseJobs(fs.readFileSync(file, 'utf8'))
    const callerName = caller.match(/^ {4}name: (.+)$/m)[1]
    const buildName = jobs.build.match(/^ {4}name: (.+)$/m)[1].replaceAll('${{ matrix.arch }}', arch)
    assert.equal(spec.buildJob, `${callerName} / ${buildName}`, platform)
    for (const step of spec.proofSteps) assert.ok(stepNames(jobs.build).includes(step), `${platform} build has no step "${step}"`)
    const artifactName = namedStep(jobs.build, 'Upload installer artifact').match(/^ {10}name: (.+)$/m)[1].replaceAll('${{ matrix.arch }}', arch)
    assert.equal(spec.artifact, artifactName, platform)
    assert.equal(spec.artifact, namedStep(jobs.publish, "Download the accepted candidate's installer artifact").match(/^ {10}name: (.+)$/m)[1].replaceAll('${{ matrix.arch }}', arch), platform)
  }
  assert.equal(PLATFORMS['mac-arm64'].feed, 'latest-mac.yml')
  assert.equal(PLATFORMS['win-x64'].feed, 'latest.yml')
})

test('the release gate checks the candidate for every platform before either platform starts', () => {
  const source = fs.readFileSync(synchronizedWorkflowPath, 'utf8')
  assert.match(source, /^permissions:\n {2}contents: read\n {2}actions: read$/m)
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-release-gate-'))
  const calls = path.join(bin, 'calls')
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CALLS"\n', { mode: 0o755 })
  try {
    for (const [windows, platforms] of [
      ['true', '--platform mac-arm64 --platform win-x64'],
      ['false', '--platform mac-arm64']
    ]) {
      fs.rmSync(calls, { force: true })
      const run = runStep(source, 'Assert the candidate built this commit for every platform this run publishes', {
        path: bin, env: { CALLS: calls, CANDIDATE_RUN_ID: '42570408228', RELEASE_WINDOWS: windows }
      })
      assert.equal(run.status, 0, run.stderr)
      assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'),
        [`scripts/release-candidate-promotion.mjs candidate --run-id 42570408228 ${platforms}`])
    }
  } finally { fs.rmSync(bin, { recursive: true, force: true }) }
})

// hc-1233: the Node each `actions/setup-node` step pins, in file order (null when a step pins none). Release
// builds run the root `npm ci` with engine-strict (.npmrc, and scripts/build/node-deps.mjs checks the same range),
// so a release workflow on a Node outside the root engines range stops at its first install.
function setupNodePins(source) {
  const lines = source.split('\n')
  const indent = line => line.length - line.trimStart().length
  const pins = []
  lines.forEach((line, i) => {
    if (!/^\s*(?:- )?uses: actions\/setup-node@/.test(line)) return
    let pin = null
    for (const next of lines.slice(i + 1)) {
      if (/^\s*- /.test(next) || (next.trim() && indent(next) < indent(line))) break
      const m = next.match(/^\s+node-version:\s*['"]?([^'"\s#]+)/)
      if (m) { pin = m[1]; break }
    }
    pins.push(pin)
  })
  return pins
}

test('every release workflow sets up one Node major, inside the root engines range (hc-1233)', () => {
  const semver = require('semver')
  const engines = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')).engines.node
  const pins = []
  for (const file of [workflowPath, windowsWorkflowPath, synchronizedWorkflowPath]) {
    const found = setupNodePins(fs.readFileSync(file, 'utf8'))
    assert.ok(found.length > 0, `${path.basename(file)} sets up no Node`)
    assert.ok(found.every(Boolean), `${path.basename(file)} has a setup-node step without node-version: ${found}`)
    pins.push(...found)
  }
  const majors = [...new Set(pins.map(pin => pin.split('.')[0]))]
  assert.equal(majors.length, 1, `the release workflows mix Node majors: ${pins.join(', ')}`)
  assert.ok(semver.intersects(`${majors[0]}.x`, engines),
    `the release workflows set up Node ${majors[0]}, outside the root engines "${engines}": the build's npm ci stops`)
  // The engine bundle's gzip bytes follow the Node major (hc-1058): move it only with a minor Desktop version,
  // and change this number in the same commit.
  assert.equal(majors[0], '26')
})

// hc-1233: Node 26 (the engine's from 0.18.0 on) needs macOS 13.5. The build proves every bundled binary runs on the
// app's declared floor, then stamps that floor into the feed before the artifact a promotion publishes as it is.
const SCAN_STEP = 'Assert every bundled binary runs on the declared minimum macOS'
const STAMP_STEP = 'Stamp the updater feed with the minimum macOS'

test('the Mac build checks the minimum macOS and stamps it into the feed before the artifact upload (hc-1233)', () => {
  const jobs = releaseJobs(workflowSource())
  const steps = stepNames(jobs.build)
  const at = step => {
    assert.ok(steps.includes(step), `the Mac build has no step "${step}"`)
    return steps.indexOf(step)
  }
  assert.ok(at('Build, sign and notarize (${{ matrix.arch }})') < at(SCAN_STEP))
  assert.ok(at('Build, sign and notarize (${{ matrix.arch }})') < at(STAMP_STEP))
  assert.ok(at(STAMP_STEP) < at('Upload installer artifact'))
  for (const step of [SCAN_STEP, STAMP_STEP]) {
    assert.doesNotMatch(namedStep(jobs.build, step), /^ {8}(?:if|continue-on-error):/m, `${step} must run on every build`)
  }
  assert.equal(namedStep(jobs.build, STAMP_STEP).match(/^ {8}run: (.*)$/m)?.[1], 'node scripts/macos-minimum-system.mjs stamp release/latest-mac.yml')
  assert.match(namedStep(jobs.build, SCAN_STEP), /^ {10}EXPECTED_ARCH: \$\{\{ matrix\.arch \}\}$/m)
})

test('the minimum-macOS step unpacks the engine archive inside the app and fails on a binary above the floor', () => {
  const machO = minos => {
    const bytes = Buffer.alloc(32 + 24 + 64)
    const [major, minor] = minos.split('.').map(Number)
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(0x0100000c, 4)
    bytes.writeUInt32LE(2, 12)
    bytes.writeUInt32LE(1, 16)
    bytes.writeUInt32LE(24, 20)
    bytes.writeUInt32LE(0x32, 32)
    bytes.writeUInt32LE(24, 36)
    bytes.writeUInt32LE(1, 40)
    bytes.writeUInt32LE((major << 16) | (minor << 8), 44)
    return bytes
  }
  const floor = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).build.mac.minimumSystemVersion
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-minimum-macos-'))
  try {
    // The step runs in apps/desktop: a release/ the build made, and this checkout's scripts.
    fs.symlinkSync(__dirname, path.join(root, 'scripts'))
    const app = path.join(root, 'release', 'mac-arm64', 'APEX.app')
    const resources = path.join(app, 'Contents', 'Resources', 'bundled-runtime')
    fs.mkdirSync(resources, { recursive: true })
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'))
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'),
      `<plist version="1.0"><dict><key>LSMinimumSystemVersion</key><string>${floor}</string></dict></plist>\n`)
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'APEX'), machO('12.0'))
    const engine = path.join(root, 'engine-src')
    fs.mkdirSync(path.join(engine, '.runtime', 'node', 'bin'), { recursive: true })
    for (const [node, status] of [[floor, 0], ['14.0', 1]]) {
      fs.writeFileSync(path.join(engine, '.runtime', 'node', 'bin', 'node'), machO(node))
      const tar = spawnSync('tar', ['-czf', path.join(resources, 'runtime-bundle-0123456789ab-mac-arm64.tar.gz'), '-C', engine, '.'], { encoding: 'utf8' })
      assert.equal(tar.status, 0, tar.stderr)
      const run = runStep(workflowSource(), SCAN_STEP, { cwd: root, env: { EXPECTED_ARCH: 'arm64', RUNNER_TEMP: path.join(root, 'tmp') } })
      assert.equal(run.status, status, `engine node at macOS ${node}: ${run.stdout}${run.stderr}`)
      if (status === 0) assert.match(run.stdout, /engine: 1 Mach-O, highest minimum macOS/)
      else assert.match(run.stderr, /need a newer macOS than the declared [\d.]+:\n14\.0\.0 {2}\.runtime\/node\/bin\/node/)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
