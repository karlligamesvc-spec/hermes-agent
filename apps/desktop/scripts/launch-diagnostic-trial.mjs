#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import trialPolicy from '../diagnostic-trial-policy.json' with { type: 'json' }
import { assertDiagnosticPackageMetadata } from './assert-diagnostic-trial-package.mjs'

const require = createRequire(import.meta.url)
const MARKER_NAME = '.apex-diagnostic-trial.json'

function parseArgs(argv) {
  const out = { launch: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--launch') {
      out.launch = true
      continue
    }
    if (['--app', '--python', '--root', '--runtime'].includes(argument)) {
      out[argument.slice(2)] = argv[index + 1]
      index += 1
      continue
    }
    throw new Error(`unknown or incomplete argument: ${argument}`)
  }
  return out
}

function requiredAbsolute(args, key) {
  const raw = typeof args[key] === 'string' ? args[key].trim() : ''
  if (!raw) throw new Error(`--${key} is required`)
  if (!path.isAbsolute(raw)) throw new Error(`--${key} must be an absolute path`)
  return path.resolve(raw)
}

function git(runtimeRoot, args) {
  return execFileSync('git', ['-C', runtimeRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function runtimeCommit(runtimeRoot) {
  return git(runtimeRoot, ['rev-parse', 'HEAD'])
}

function assertCleanRuntime(runtimeRoot) {
  const status = git(runtimeRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status) throw new Error(`Runtime worktree is not clean; first entry: ${status.split(/\r?\n/)[0]}`)
}

function canonicalizeThroughExistingParent(candidate) {
  let current = path.resolve(candidate)
  const missingSegments = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) throw new Error(`cannot resolve an existing parent for ${candidate}`)
    missingSegments.unshift(path.basename(current))
    current = parent
  }
  return path.join(fs.realpathSync(current), ...missingSegments)
}

function isSameOrInside(candidate, root) {
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const relative = path.relative(normalizedRoot, normalizedCandidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function productionProtectedRoots() {
  const home = os.homedir()
  const roots = [
    path.join(home, '.apexnodes'),
    path.join(home, '.hermes'),
    process.env.HERMES_HOME
  ]
  if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Application Support', 'ApexNodes'))
  }
  if (process.platform === 'win32') {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'ApexNodes'))
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'apexnodes'))
  }
  return roots.filter(Boolean).map(canonicalizeThroughExistingParent)
}

function assertIsolatedPaths(paths) {
  const protectedRoots = productionProtectedRoots()
  for (const [label, rawPath] of Object.entries(paths)) {
    const candidate = canonicalizeThroughExistingParent(rawPath)
    const protectedRoot = protectedRoots.find(root => isSameOrInside(candidate, root))
    if (protectedRoot) {
      throw new Error(`${label} ${candidate} overlaps protected APEX data ${protectedRoot}`)
    }
  }
}

function appExecutable(appPath) {
  if (process.platform === 'darwin') {
    return path.join(appPath, 'Contents', 'MacOS', trialPolicy.executableName)
  }
  if (process.platform === 'win32') {
    return path.extname(appPath).toLowerCase() === '.exe'
      ? appPath
      : path.join(appPath, `${trialPolicy.executableName}.exe`)
  }
  return appPath
}

function appAsar(appPath) {
  if (process.platform === 'darwin') return path.join(appPath, 'Contents', 'Resources', 'app.asar')
  const appDirectory = path.extname(appPath).toLowerCase() === '.exe' ? path.dirname(appPath) : appPath
  return path.join(appDirectory, 'resources', 'app.asar')
}

function readEmbeddedPolicy(appPath) {
  const asarPath = appAsar(appPath)
  if (!fs.existsSync(asarPath)) throw new Error(`diagnostic app.asar not found: ${asarPath}`)
  const asar = require('@electron/asar')
  const packageJson = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
  return assertDiagnosticPackageMetadata(packageJson)
}

function probePythonBinding(pythonPath, runtimeRoot, hermesHome) {
  const source = [
    'import importlib, json',
    "module = importlib.import_module('hermes_cli.main')",
    "print(json.dumps({'modulePath': module.__file__}))"
  ].join('; ')
  const stdout = execFileSync(pythonPath, ['-B', '-c', source], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HERMES_HOME: hermesHome,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
      PYTHONPATH: [runtimeRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000
  }).trim()
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).at(-1)
  const binding = lastLine ? JSON.parse(lastLine) : null
  const modulePath = binding?.modulePath ? fs.realpathSync(binding.modulePath) : null
  const canonicalRuntime = fs.realpathSync(runtimeRoot)
  if (!modulePath || !isSameOrInside(modulePath, canonicalRuntime)) {
    throw new Error(`paired Python did not import hermes_cli.main from Runtime ${canonicalRuntime}`)
  }
  return modulePath
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const appPath = requiredAbsolute(args, 'app')
  const pythonPath = requiredAbsolute(args, 'python')
  const diagnosticRoot = requiredAbsolute(args, 'root')
  const runtimeRoot = requiredAbsolute(args, 'runtime')
  const executable = appExecutable(appPath)
  const embeddedPolicy = readEmbeddedPolicy(appPath)

  if (!fs.existsSync(executable)) throw new Error(`diagnostic executable not found: ${executable}`)
  if (!fs.existsSync(path.join(runtimeRoot, 'hermes_cli', 'main.py'))) {
    throw new Error(`Runtime source is incomplete: ${runtimeRoot}`)
  }
  if (!fs.existsSync(pythonPath)) throw new Error(`Runtime Python not found: ${pythonPath}`)

  assertCleanRuntime(runtimeRoot)
  const actualCommit = runtimeCommit(runtimeRoot)
  if (actualCommit !== embeddedPolicy.runtimeSourceCommit) {
    throw new Error(
      `Runtime HEAD ${actualCommit || '<unreadable>'} does not match ${embeddedPolicy.runtimeSourceCommit}`
    )
  }

  const directories = {
    hermesHome: path.join(diagnosticRoot, 'hermes-home'),
    userData: path.join(diagnosticRoot, 'user-data'),
    workspace: path.join(diagnosticRoot, 'workspace')
  }
  assertIsolatedPaths({ diagnosticRoot, runtimeRoot, ...directories })
  const runtimeModulePath = probePythonBinding(pythonPath, runtimeRoot, directories.hermesHome)

  if (!args.launch) {
    console.log(
      JSON.stringify(
        {
          appPath,
          diagnosticRoot,
          directories,
          mode: 'check-only',
          runtimeCommit: actualCommit,
          runtimeModulePath,
          runtimeRoot
        },
        null,
        2
      )
    )
    return
  }

  fs.mkdirSync(diagnosticRoot, { recursive: true })
  for (const directory of Object.values(directories)) {
    fs.mkdirSync(directory, { recursive: true })
  }
  fs.writeFileSync(
    path.join(diagnosticRoot, MARKER_NAME),
    `${JSON.stringify(
      {
        appId: embeddedPolicy.appId,
        mode: embeddedPolicy.mode,
        runtimeSourceCommit: embeddedPolicy.runtimeSourceCommit,
        schemaVersion: embeddedPolicy.schemaVersion
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8', mode: 0o600 }
  )

  const child = spawn(executable, [], {
    detached: false,
    env: {
      ...process.env,
      APEX_DESKTOP_DIAGNOSTIC_ROOT: diagnosticRoot,
      HERMES_DESKTOP_CWD: directories.workspace,
      HERMES_DESKTOP_HERMES_ROOT: runtimeRoot,
      HERMES_DESKTOP_IGNORE_EXISTING: '1',
      HERMES_DESKTOP_PYTHON: pythonPath,
      HERMES_DESKTOP_SKIP_QUIT_CONFIRM: '1',
      HERMES_HOME: directories.hermesHome,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1'
    },
    stdio: 'inherit'
  })

  child.once('exit', code => process.exit(code ?? 1))
  child.once('error', error => {
    console.error(`[diagnostic-trial] launch failed: ${error.message}`)
    process.exit(1)
  })
}

try {
  main()
} catch (error) {
  console.error(`[diagnostic-trial] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
