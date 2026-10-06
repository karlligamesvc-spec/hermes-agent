const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const test = require('node:test')

const workflowPath = path.resolve(__dirname, '../../../.github/workflows/desktop-macos.yml')
const windowsWorkflowPath = path.resolve(__dirname, '../../../.github/workflows/desktop-windows.yml')
const synchronizedWorkflowPath = path.resolve(__dirname, '../../../.github/workflows/desktop-release.yml')

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

test('manual macOS builds are artifact-only and paired calls own production publish', () => {
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
case "$5" in *dmg) [ "$FAIL_ASSET" = 1 ] && exit 1 ;; esac
exit 0
`, { mode: 0o755 })
  const script = bashRunBody(namedStep(workflowSource(), 'Publish installer + updater feed to COS (skipped when secrets absent)'))
    .replaceAll('${{ matrix.arch }}', 'arm64')
  try {
    for (const fails of [false, true]) {
      fs.rmSync(log, { force: true })
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: log, FAIL_ASSET: fails ? '1' : '0', COS_SECRET_ID: 'fixture-id', COS_SECRET_KEY: 'fixture-secret' },
        encoding: 'utf8'
      })
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
      assert.equal(result.status, fails ? 1 : 0, result.stderr)
      assert.equal(calls.at(-1), fails ? 'desktop/mac-arm64/APEX-0.17.50-mac-arm64.dmg' : 'desktop/mac-arm64/latest-mac.yml')
      assert.equal(calls.length, fails ? 1 : 4)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
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

test('the production coordinator owns both platform workflows and a final parity readback', () => {
  const source = fs.readFileSync(synchronizedWorkflowPath, 'utf8')

  assert.match(source, /uses: \.\/\.github\/workflows\/desktop-macos\.yml/)
  assert.match(source, /uses: \.\/\.github\/workflows\/desktop-windows\.yml/)
  assert.match(source, /needs: \[macos, windows\]/)
  assert.match(source, /test "\$MAC_SHA" = "\$CALLER_SHA"/)
  assert.match(source, /test "\$WINDOWS_SHA" = "\$CALLER_SHA"/)
  assert.match(source, /test "\$WINDOWS_IDENTITY_VERIFIED" = "true"/)
  assert.match(source, /verify-cross-platform-release\.mjs --expected-version/)
})

test('the production coordinator release identity check is valid Bash', () => {
  const source = fs.readFileSync(synchronizedWorkflowPath, 'utf8')
  const script = bashRunBody(
    namedStep(source, 'Assert reusable workflows packaged one release identity')
  )
  const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(script, /PACKAGE_VERSION=/)
  assert.doesNotMatch(script, /node -p \\"/)
})
