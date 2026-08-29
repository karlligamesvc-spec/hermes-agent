const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
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

test('manual macOS builds are artifact-only and paired calls own production publish', () => {
  const source = workflowSource()
  const dispatchBlock = source.slice(source.indexOf('  workflow_dispatch:'), source.indexOf('\npermissions:'))
  const publishStep = namedStep(
    source,
    'Publish installer + updater feed to COS (skipped when secrets absent)'
  )

  assert.doesNotMatch(dispatchBlock, /inputs:/)
  assert.match(publishStep, /if: \$\{\{ inputs\.publish \}\}/)
  assert.match(publishStep, /coscmd upload/)
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

test('the production coordinator owns both platform workflows and a final parity readback', () => {
  const source = fs.readFileSync(synchronizedWorkflowPath, 'utf8')

  assert.match(source, /uses: \.\/\.github\/workflows\/desktop-macos\.yml/)
  assert.match(source, /uses: \.\/\.github\/workflows\/desktop-windows\.yml/)
  assert.match(source, /needs: \[macos, windows\]/)
  assert.match(source, /test "\$MAC_SHA" = "\$CALLER_SHA"/)
  assert.match(source, /test "\$WINDOWS_SHA" = "\$CALLER_SHA"/)
  assert.match(source, /verify-cross-platform-release\.mjs --expected-version/)
})
