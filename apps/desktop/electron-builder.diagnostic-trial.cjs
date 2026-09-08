'use strict'

const packageJson = require('./package.json')
const trialPolicy = require('./diagnostic-trial-policy.json')
const childProcess = require('node:child_process')
const path = require('node:path')

const { createDiagnosticTrialBuildConfig } = require('./scripts/diagnostic-trial-build-config.cjs')

const runtimeRoot = process.env.APEX_DESKTOP_DIAGNOSTIC_BUILD_RUNTIME_ROOT
if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) {
  throw new Error('APEX_DESKTOP_DIAGNOSTIC_BUILD_RUNTIME_ROOT must name an absolute clean Runtime worktree')
}

const status = childProcess.execFileSync(
  'git',
  ['-C', runtimeRoot, 'status', '--porcelain=v1', '--untracked-files=all'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
).trim()
if (status) {
  throw new Error(`diagnostic Runtime worktree must be clean; first entry: ${status.split('\n')[0]}`)
}

const runtimeSourceCommit = childProcess.execFileSync('git', ['-C', runtimeRoot, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
}).trim()

module.exports = createDiagnosticTrialBuildConfig({
  baseBuild: packageJson.build,
  packageJson,
  runtimeSourceCommit,
  trialPolicy
})
