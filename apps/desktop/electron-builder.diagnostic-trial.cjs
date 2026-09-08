'use strict'

const packageJson = require('./package.json')
const trialPolicy = require('./diagnostic-trial-policy.json')
const childProcess = require('node:child_process')
const path = require('node:path')

const { createDiagnosticTrialBuildConfig } = require('./scripts/diagnostic-trial-build-config.cjs')
const { assertDiagnosticRuntimeClean } = require('./scripts/diagnostic-trial-runtime-clean.cjs')

const runtimeRoot = process.env.APEX_DESKTOP_DIAGNOSTIC_BUILD_RUNTIME_ROOT
if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) {
  throw new Error('APEX_DESKTOP_DIAGNOSTIC_BUILD_RUNTIME_ROOT must name an absolute verified Runtime worktree')
}

assertDiagnosticRuntimeClean(runtimeRoot, childProcess.execFileSync)

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
