/**
 * A packaged APEX on a fresh home used to adopt whatever `hermes` was on PATH
 * (resolveHermesBackend step 4) or a system Python with hermes_cli (step 5)
 * before installing its bundled engine. On the 2026-10-17 Mac acceptance of
 * 0.17.58 (same order since the bundled engine arrived in 0.17.37) that was
 * ~/.local/bin/hermes, a dev launcher whose venv lacked ruamel: it passed the
 * `--version` probe, died before announcing a port, and boot failed without
 * reaching the bundled engine. A healthy foreign CLI would instead have
 * replaced the engine this shell ships with, since adoption writes no marker.
 *
 * Kael's call (2026-10-17): a packaged build that carries its engine uses only
 * that engine unless HERMES_DESKTOP_HERMES / HERMES_DESKTOP_HERMES_ROOT says
 * otherwise, and the dev ladder is unchanged. The policy is
 * resolveExternalRuntimeRungs (apex-runtime-select.ts, table-tested there).
 *
 * Here: the repro with real processes, the decision composed with the real
 * install gate, and main.ts's wiring and callers through its TypeScript AST
 * (main.ts cannot be imported in a test, so comments and strings cannot
 * satisfy these).
 *
 * Does NOT cover: an Electron boot end to end (the Desktop e2e lanes are off,
 * hc-913), or Windows `.cmd` launchers (the process tests are POSIX-only,
 * like backend-probes.test.ts).
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { afterEach, beforeEach, describe, test } from 'vitest'

import { resolveExternalRuntimeRungs } from './apex-runtime-select'
import { createBackendOutputTail } from './backend-claim'
import { dashboardFallbackArgs, serveBackendArgs } from './backend-command'
import { canImportHermesCli, verifyHermesCli } from './backend-probes'
import { waitForDashboardPortAnnouncement } from './backend-ready'
import { shouldInstallPackagedRuntime } from './packaged-runtime'
import { resolveExistingHermesCandidate } from './windows-hermes-path'

const posixOnly = { skip: process.platform === 'win32' }
const PACKAGED = { isPackaged: true, bundledEngine: true, explicitCli: false, ignoreExisting: false, updatePending: false }

let scratch: string

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-external-runtime-'))
})

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

function writeScript(name: string, lines: string[]): string {
  const file = path.join(scratch, name)

  fs.writeFileSync(file, ['#!/bin/sh', ...lines, ''].join('\n'))
  fs.chmodSync(file, 0o755)

  return file
}

/** The Mac acceptance CLI: `--version` answers, every real command dies on the config import. */
const writeBrokenPathHermes = () =>
  writeScript('hermes', [
    'if [ "$1" = "--version" ]; then echo "Hermes Agent v0.22.0"; exit 0; fi',
    'echo "Traceback (most recent call last):" >&2',
    'echo "ModuleNotFoundError: No module named \'ruamel\'" >&2',
    'exit 1'
  ])

/** Spawn the way main.ts does and wait for the READY line the way main.ts does. */
function startLikeDesktop(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const tail = createBackendOutputTail()
  tail.attach(child)

  return waitForDashboardPortAnnouncement(child, {
    bufferedOutput: () => tail.text(),
    describeOutputTail: () => tail.describe(),
    timeoutMs: 10_000
  })
}

const pathCliDeps = {
  isWindowsVenvHermesShim: () => false,
  unwrapWindowsVenvHermesCommand: () => null,
  isCommandScript: () => false,
  verifyHermesCli
}

const installPolicy = (backendKind: string) => ({
  isPackaged: true,
  diagnostic: false,
  backendKind,
  backendRoot: undefined,
  hermesHome: scratch,
  updatePending: false
})

test('repro: the PATH rung adopts a hermes whose --version works but whose CLI cannot import', posixOnly, () => {
  const hermes = writeBrokenPathHermes()

  assert.equal(verifyHermesCli(hermes), true, 'the --version probe cannot see the broken venv')
  assert.deepEqual(resolveExistingHermesCandidate(hermes, serveBackendArgs(), pathCliDeps), {
    backend: {
      label: `existing Hermes CLI at ${hermes}`,
      command: hermes,
      args: serveBackendArgs(),
      bootstrap: false,
      env: {},
      kind: 'command',
      shell: false
    },
    rejection: null
  })
})

test('repro: that CLI exits before its port announcement on serve and on the legacy dashboard route', posixOnly, async () => {
  const hermes = writeBrokenPathHermes()

  // backendSupportsServe probes a root-less CLI with `serve --help`; the import
  // crash fails it, which main.ts reads as "serve unsupported → dashboard".
  assert.throws(() => execFileSync(hermes, ['serve', '--help'], { stdio: 'ignore' }))

  for (const args of [serveBackendArgs(), dashboardFallbackArgs(serveBackendArgs())]) {
    await assert.rejects(
      startLikeDesktop(hermes, args),
      /exited before port announcement \(1\)[\s\S]*ModuleNotFoundError: No module named 'ruamel'/
    )
  }
})

test('a packaged home with its own engine is offered neither that CLI nor a system Python, so the bundled engine installs', posixOnly, () => {
  const hermes = writeBrokenPathHermes()
  const python = writeScript('python3', ['if [ "$1" = "-c" ]; then exit 0; fi', 'exit 1'])
  const adopted = resolveExistingHermesCandidate(hermes, serveBackendArgs(), pathCliDeps).backend

  // Both would be adopted if their rungs were walked, and an adopted CLI never installs the engine (hc-903).
  assert.equal(adopted?.kind, 'command')
  assert.equal(canImportHermesCli(python), true)
  assert.equal(shouldInstallPackagedRuntime(installPolicy('command')), false)

  assert.deepEqual(resolveExternalRuntimeRungs(PACKAGED), { explicitCli: false, pathCli: false, systemPython: false })
  // No rung left, so resolveHermesBackend returns its step-6 sentinel, which the gate installs for.
  assert.equal(shouldInstallPackagedRuntime(installPolicy('bootstrap-needed')), true)
})

test('an explicit HERMES_DESKTOP_HERMES is still probed: a live one is used, a dead one falls to the bundled engine', posixOnly, () => {
  const rungs = resolveExternalRuntimeRungs({ ...PACKAGED, explicitCli: true })
  const live = writeBrokenPathHermes()
  const dead = writeScript('hermes-dead', ['exit 1'])

  assert.equal(rungs.explicitCli, true)
  assert.equal(resolveExistingHermesCandidate(live, serveBackendArgs(), pathCliDeps).backend?.command, live)
  assert.deepEqual(resolveExistingHermesCandidate(dead, serveBackendArgs(), pathCliDeps), { backend: null, rejection: 'version' })
  assert.equal(rungs.systemPython, false, 'after a dead command only step 6 remains')
})

// ── main.ts wiring ─────────────────────────────────────────────────────────

const main = ts.createSourceFile(
  'main.ts',
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)

function topLevelFunction(name: string): ts.FunctionDeclaration {
  const found = main.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name && Boolean(statement.body)
  )

  if (!found) {
    throw new Error(`main.ts has no top-level function ${name}`)
  }

  return found
}

function nodesIn<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = []

  const visit = (node: ts.Node) => {
    if (predicate(node)) {
      found.push(node)
    }

    ts.forEachChild(node, visit)
  }

  visit(root)

  return found
}

const contains = (root: ts.Node, predicate: (node: ts.Node) => boolean) =>
  nodesIn(root, (node): node is ts.Node => predicate(node)).length > 0

const isCallTo = (node: ts.Node, name: string): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name

const readsRung = (node: ts.Node, rung: string) =>
  contains(
    node,
    child =>
      ts.isPropertyAccessExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === 'externalRungs' &&
      child.name.text === rung
  )

/** Conditions that must hold for `node` to run: `if` tests it sits under the then-branch of, and `?:` tests. */
function guardsOf(node: ts.Node): ts.Expression[] {
  const guards: ts.Expression[] = []

  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && parent.thenStatement === child) {
      guards.push(parent.expression)
    }

    if (ts.isConditionalExpression(parent) && parent.whenTrue === child) {
      guards.push(parent.condition)
    }
  }

  return guards
}

/** Who calls `name`: the enclosing top-level function, or `ipc:<channel>` for an ipcMain.handle callback. */
function callersOf(name: string): string[] {
  return nodesIn(main, (node): node is ts.CallExpression => isCallTo(node, name))
    .map(call => {
      let owner = '<module>'

      for (let current: ts.Node | undefined = call.parent; current; current = current.parent) {
        if (ts.isFunctionDeclaration(current) && current.name && current.parent === main) {
          owner = current.name.text
        }

        if (
          ts.isCallExpression(current) &&
          ts.isPropertyAccessExpression(current.expression) &&
          current.expression.getText() === 'ipcMain.handle' &&
          ts.isStringLiteral(current.arguments[0])
        ) {
          owner = `ipc:${current.arguments[0].text}`
        }
      }

      return owner
    })
    .filter((owner, index, all) => all.indexOf(owner) === index)
    .sort()
}

describe('main.ts wiring of the packaged engine pick', () => {
  const resolve = topLevelFunction('resolveHermesBackend')

  test('resolveHermesBackend takes steps 4-5 from one resolveExternalRuntimeRungs call fed by the live inputs', () => {
    const calls = nodesIn(resolve, (node): node is ts.CallExpression => isCallTo(node, 'resolveExternalRuntimeRungs'))

    assert.equal(calls.length, 1)

    const [input] = calls[0].arguments

    assert.ok(input && ts.isObjectLiteralExpression(input))

    const fields = new Map(
      input.properties
        .filter((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property))
        .map(property => [property.name.getText(), property.initializer.getText()])
    )

    assert.equal(fields.get('isPackaged'), 'IS_PACKAGED')
    assert.match(fields.get('bundledEngine') ?? '', /^IS_PACKAGED && packagedRuntimeShipped\(process\.resourcesPath\)$/)
    assert.match(fields.get('explicitCli') ?? '', /process\.env\.HERMES_DESKTOP_HERMES\b(?!_)/)
    assert.match(fields.get('ignoreExisting') ?? '', /process\.env\.HERMES_DESKTOP_IGNORE_EXISTING === '1'/)
    assert.equal(fields.get('updatePending'), 'runtimeUpdatePending')

    const assigned = calls[0].parent

    assert.ok(ts.isVariableDeclaration(assigned) && assigned.name.getText() === 'externalRungs')
  })

  test('step 4 looks on PATH only under the pathCli rung, and resolves an explicit command only under explicitCli', () => {
    const lookups = nodesIn(
      resolve,
      (node): node is ts.CallExpression =>
        isCallTo(node, 'findOnPath') && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'hermes'
    )

    assert.equal(lookups.length, 1)
    assert.ok(guardsOf(lookups[0]).some(guard => readsRung(guard, 'pathCli')), 'PATH lookup outside the pathCli rung')

    const explicit = nodesIn(
      resolve,
      (node): node is ts.IfStatement =>
        ts.isIfStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === 'hermesOverride'
    )

    assert.equal(explicit.length, 1)
    assert.ok(guardsOf(explicit[0]).some(guard => readsRung(guard, 'explicitCli')), 'explicit command outside its rung')
  })

  test('step 5 looks for a system Python only under the systemPython rung', () => {
    const lookups = nodesIn(resolve, (node): node is ts.CallExpression => isCallTo(node, 'findSystemPython'))

    assert.equal(lookups.length, 1)
    assert.ok(guardsOf(lookups[0]).some(guard => readsRung(guard, 'systemPython')), 'system Python outside its rung')
  })

  // Every runtime consumer must ask the one resolver, so they all get the
  // packaged-engine answer. A new caller has to be added here on purpose.
  test('every runtime consumer resolves through resolveHermesBackend', () => {
    assert.deepEqual(callersOf('resolveHermesBackend'), [
      'ipc:hermes:window:openInTerminal',
      'runEnsureRuntime',
      'runHermesStart',
      'runPoolBackendStart',
      'startMessagingGateway'
    ])
  })

  test('local Agent jobs stay on the app’s own engine, through the install gate', () => {
    const job = topLevelFunction('runLocalAgentJob')

    assert.equal(contains(job, node => isCallTo(node, 'resolveHermesBackend')), false)
    assert.ok(
      contains(job, node => isCallTo(node, 'ensureRuntime') && contains(node, child => isCallTo(child, 'createActiveBackend')))
    )
  })
})
