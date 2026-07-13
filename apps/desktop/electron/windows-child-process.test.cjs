'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ELECTRON_DIR = __dirname

function readElectronFile(name) {
  return fs.readFileSync(path.join(ELECTRON_DIR, name), 'utf8').replace(/\r\n/g, '\n')
}

// Prettier is free to re-wrap a long call's argument list across lines any
// time a nearby edit nudges it over the print width (this is exactly what
// happened in d62979a6f, which reformatted 5 of these call sites from
// single-line to multi-line in an otherwise unrelated feature commit and
// broke every needle below that assumed single-line layout). Matching on
// whitespace-collapsed text makes the assertion track the call site's
// *shape* (identifier order, adjacency) instead of its incidental line
// breaks, so a future reformat can't silently defeat this guard again.
function collapseWhitespace(str) {
  return str.replace(/\s+/g, '')
}

function requireHiddenChildOptions(source, needle) {
  const collapsedSource = collapseWhitespace(source)
  const collapsedNeedle = collapseWhitespace(needle)
  const index = collapsedSource.indexOf(collapsedNeedle)
  assert.notEqual(index, -1, `missing call site: ${needle}`)
  const snippet = collapsedSource.slice(index, index + 700)
  assert.match(
    snippet,
    /hiddenWindowsChildOptions\(/,
    `expected ${needle} to wrap child-process options with hiddenWindowsChildOptions`
  )
}

test('desktop background child processes opt into hidden Windows consoles', () => {
  const source = readElectronFile('main.cjs')

  assert.match(source, /function hiddenWindowsChildOptions\(options = \{\}\)/)

  requireHiddenChildOptions(source, "execFileSync('reg'")
  requireHiddenChildOptions(source, 'execFileSync(pyExe')
  requireHiddenChildOptions(source, 'spawn(resolveGitBinary()')
  requireHiddenChildOptions(source, "execFileSync('taskkill'")
  requireHiddenChildOptions(source, 'spawn(command, args')
  requireHiddenChildOptions(source, "spawn('curl'")
  requireHiddenChildOptions(source, 'spawn(backend.command, backend.args')
  requireHiddenChildOptions(source, 'hermesProcess = spawn(backend.command, backend.args')
  requireHiddenChildOptions(source, "spawn(py, ['-m', 'hermes_cli.main', 'uninstall', '--gui-summary']")
})

test('intentional or interactive desktop child processes stay documented', () => {
  const source = readElectronFile('main.cjs')

  assert.match(source, /windowsHide: false/)
  assert.match(source, /handOffWindowsBootstrapRecovery/)
  assert.match(source, /'--repair', '--branch'/)
  assert.match(source, /'--update', '--branch'/)
  assert.match(source, /nodePty\.spawn\(command, args/)
  assert.match(source, /spawn\('cmd\.exe', \['\/c', 'start'/)
})

test('bootstrap PowerShell runner hides Windows console children', () => {
  const source = readElectronFile('bootstrap-runner.cjs')

  assert.match(source, /function hiddenWindowsChildOptions\(options = \{\}\)/)
  requireHiddenChildOptions(source, 'spawn(ps, fullArgs')
})
