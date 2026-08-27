const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const workflowPath = path.resolve(__dirname, '../../../.github/workflows/desktop-macos.yml')

function workflowSource() {
  return fs.readFileSync(workflowPath, 'utf8')
}

function namedStep(source, name) {
  const start = source.indexOf(`      - name: ${name}`)
  assert.notEqual(start, -1, `missing workflow step: ${name}`)

  const nextStep = source.indexOf('\n      - name:', start + 1)
  return source.slice(start, nextStep === -1 ? source.length : nextStep)
}

test('manual macOS builds are artifact-only unless production publish is explicit', () => {
  const source = workflowSource()
  const dispatchBlock = source.slice(source.indexOf('  workflow_dispatch:'), source.indexOf('\npermissions:'))
  const publishStep = namedStep(
    source,
    'Publish installer + updater feed to COS (skipped when secrets absent)'
  )

  assert.match(dispatchBlock, /publish:\n[\s\S]*?type: boolean\n[\s\S]*?default: false/)
  assert.match(publishStep, /if: \$\{\{ inputs\.publish \}\}/)
  assert.match(publishStep, /coscmd upload/)
})
