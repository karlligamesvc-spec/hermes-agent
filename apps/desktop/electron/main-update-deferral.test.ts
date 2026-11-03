/**
 * hc-906 guard: the main.ts wiring that turns an engine held by live work into
 * a deferred update instead of a failed one. The behaviour lives in modules
 * with their own tests: runtime-switch-gate (preflight and fenced switch),
 * deferred-runtime-update (packaged deferral and retry), runtime-update-busy
 * (deferred apply answers), packaged-runtime (offline outcome), shell-updater
 * and the renderer stores. This pins where main.ts hands them out. main.ts
 * cannot be imported in a test, so this walks its TypeScript AST: comments and
 * strings cannot satisfy it.
 *
 *   D1  the native shell install runs the switch gate. Without it shell-updater
 *       also turns implicit install-on-quit back on.
 *   D2  every engine switch prepares through the one gate, built on the real
 *       lifecycle, activity, reaper, ownership and messaging-gateway owners.
 *   D3  a busy packaged install keeps the usable engine through the deferral
 *       (which reports it and retries); quit disposes the retry.
 *   D4  a busy installer-bundled (offline) update keeps its frozen pin.
 *   D5  packaged, bundle-set and legacy-source applies answer busy as deferred,
 *       and preflight before they arm or persist anything.
 *   D6  the runtime version IPC reports the deferral to the renderer.
 *   D7  every engine install is a tracked lifecycle start (hc-919 C3), the
 *       deferred retry included, so quit waits for it and never begins one.
 *
 * Does NOT catch: what the modules do with what main.ts hands them (their own
 * tests), or the renderer's handling of deferred: true.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))

const main = ts.createSourceFile(
  'main.ts',
  fs.readFileSync(path.join(here, 'main.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true
)

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}

function find<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = []

  walk(root, node => {
    if (predicate(node)) {
      found.push(node)
    }
  })

  return found
}

function contains(root: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  let hit = false

  walk(root, node => {
    hit ||= predicate(node)
  })

  return hit
}

function isWithin(node: ts.Node, ancestor: ts.Node | undefined): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) {
      return true
    }
  }

  return false
}

function isCallTo(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
}

function callsTo(root: ts.Node, name: string): ts.CallExpression[] {
  return find(root, (node): node is ts.CallExpression => isCallTo(node, name))
}

function isMember(node: ts.Node | undefined, receiver: string, name: string): boolean {
  return Boolean(
    node &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === receiver &&
      node.name.text === name
  )
}

function isMemberCall(node: ts.Node, receiver: string, method: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && isMember(node.expression, receiver, method)
}

function isIdentifier(node: ts.Node | undefined, name: string): boolean {
  return Boolean(node && ts.isIdentifier(node) && node.text === name)
}

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

/** The initializer of a top-level `const name = ...`. */
function topLevelConst(name: string): ts.Expression {
  for (const statement of main.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue
    }

    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration.initializer
      }
    }
  }

  throw new Error(`main.ts has no top-level const ${name}`)
}

/** The named members of the object literal passed as argument `index`. */
function optionsOf(call: ts.CallExpression, index: number): Map<string, ts.Node> {
  const options = call.arguments[index]

  if (!options || !ts.isObjectLiteralExpression(options)) {
    throw new Error(`argument ${index} of the call at line ${lineOf(call)} is not an object literal`)
  }

  const members = new Map<string, ts.Node>()

  for (const property of options.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      members.set(property.name.text, property.initializer)
    } else if (ts.isShorthandPropertyAssignment(property)) {
      members.set(property.name.text, property.name)
    }
  }

  return members
}

/** The only call to `name(...)` initializing top-level const `binding`. */
function factoryOptions(binding: string, name: string): Map<string, ts.Node> {
  const init = topLevelConst(binding)

  expect(isCallTo(init, name), `${binding} = ${name}({...})`).toBe(true)

  return optionsOf(init as ts.CallExpression, 0)
}

function lineOf(node: ts.Node): number {
  return main.getLineAndCharacterOfPosition(node.getStart()).line + 1
}

function returnsProperty(node: ts.Node, name: string, value: string): boolean {
  if (!ts.isReturnStatement(node) || !node.expression || !ts.isObjectLiteralExpression(node.expression)) {
    return false
  }

  return node.expression.properties.some(property => {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== name) {
      return false
    }

    const initializer = ts.isAsExpression(property.initializer) ? property.initializer.expression : property.initializer

    return ts.isStringLiteralLike(initializer) && initializer.text === value
  })
}

/** `if (<id> === '<literal>')` statements, keyed by the literal. */
function equalityBranches(root: ts.Node, id: string): Map<string, ts.IfStatement> {
  const branches = new Map<string, ts.IfStatement>()

  for (const node of find(root, ts.isIfStatement)) {
    const test = node.expression

    if (
      ts.isBinaryExpression(test) &&
      test.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      isIdentifier(test.left, id) &&
      ts.isStringLiteralLike(test.right)
    ) {
      branches.set(test.right.text, node)
    }
  }

  return branches
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current) || ts.isFunctionDeclaration(current)) {
      return current
    }
  }

  return undefined
}

/** A beforeSwitch arrow that prepares through the gate and keeps the returned fence. */
function preparesThroughGate(beforeSwitch: ts.Node | undefined): boolean {
  return Boolean(
    beforeSwitch &&
      ts.isArrowFunction(beforeSwitch) &&
      contains(beforeSwitch.body, node => isMemberCall(node, 'runtimeSwitch', 'prepare'))
  )
}

describe('main.ts wiring for deferred engine updates (hc-906)', () => {
  it('D1: the native shell install runs the switch gate', () => {
    const [updater, ...extra] = callsTo(topLevelFunction('initShellUpdater'), 'createShellUpdater')

    expect(extra).toEqual([])
    expect(updater, 'landing: initShellUpdater creates the shell updater').toBeDefined()

    const gate = optionsOf(updater!, 0).get('beforeInstall')

    expect(gate && ts.isArrowFunction(gate) && contains(gate.body, node => isMemberCall(node, 'runtimeSwitch', 'prepare'))).toBe(
      true
    )
  })

  it('D2: every engine switch prepares through the one gate built on the real owners', () => {
    const gate = factoryOptions('runtimeSwitch', 'createRuntimeSwitchGate')

    expect(isIdentifier(gate.get('lifecycle'), 'localBackendLifecycle')).toBe(true)
    expect(isIdentifier(gate.get('reapOrphanedBackends'), 'reapOrphanedBackendsOnce')).toBe(true)
    expect(isIdentifier(gate.get('stopMessagingGateway'), 'stopMessagingGateway')).toBe(true)
    expect(isIdentifier(gate.get('identityMatches'), 'backendIdentityMatches')).toBe(true)
    expect(isIdentifier(gate.get('activeRoot'), 'ACTIVE_HERMES_ROOT')).toBe(true)
    expect(isIdentifier(gate.get('hermesHome'), 'HERMES_HOME')).toBe(true)
    expect(contains(gate.get('activeWork')!, node => isCallTo(node, 'mergeActiveWork'))).toBe(true)
    expect(contains(gate.get('readOwnership')!, node => isIdentifier(node, 'DESKTOP_BACKEND_OWNERSHIP_PATH'))).toBe(true)

    // The packaged install and the bundle set both switch through it.
    for (const installer of ['installPackagedRuntime', 'applyRuntimeBundleUpdate']) {
      const [call, ...extra] = callsTo(main, installer)

      expect(extra, installer).toEqual([])
      expect(preparesThroughGate(optionsOf(call!, 0).get('beforeSwitch')), installer).toBe(true)
    }

    // Nothing in main.ts probes or retires engine holders around the gate.
    expect(callsTo(main, 'retirePackagedGateways').map(lineOf)).toEqual([])
    expect(callsTo(main, 'assertPackagedRuntimeIdle').map(lineOf)).toEqual([])
  })

  it('D3: a busy packaged install keeps the usable engine through the deferral', () => {
    const [failure, ...extra] = find(topLevelConst('ensurePackagedEngine'), ts.isCatchClause)

    expect(extra).toEqual([])

    // First in the catch: a busy engine must not reach the failure bookkeeping below it.
    const [busy] = failure!.block.statements

    expect(
      busy &&
        ts.isIfStatement(busy) &&
        ts.isCallExpression(busy.expression) &&
        isMemberCall(busy.expression, 'packagedDeferral', 'deferIfBusy') &&
        isIdentifier(busy.expression.arguments[1], 'isActiveRuntimeUsable')
    ).toBe(true)

    const deferral = (busy as ts.IfStatement).thenStatement

    expect(contains(deferral, node => returnsProperty(node, 'reason', 'busy'))).toBe(true)
    expect(contains(deferral, ts.isThrowStatement)).toBe(false)
    expect(contains(topLevelConst('ensurePackagedEngine'), node => isMemberCall(node, 'packagedDeferral', 'settle'))).toBe(true)

    const disposals = find(
      main,
      (node): node is ts.CallExpression =>
        isMemberCall(node, 'app', 'once') &&
        ts.isStringLiteralLike(node.arguments[0]!) &&
        (node.arguments[0] as ts.StringLiteral).text === 'will-quit' &&
        contains(node.arguments[1]!, child => isMemberCall(child, 'packagedDeferral', 'dispose'))
    )

    expect(disposals).toHaveLength(1)
  })

  it('D4: a busy installer-bundled update keeps its frozen pin', () => {
    const run = topLevelFunction('runEnsureRuntime')
    const [outcome, ...extra] = callsTo(run, 'offlineBundledOutcome')

    expect(extra).toEqual([])

    const declaration = outcome?.parent?.parent

    expect(declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)).toBe(true)
    expect(
      ts.isConditionalExpression(outcome!.parent) && isIdentifier(outcome!.parent.condition, 'offlineUpdate'),
      'the outcome is read only for an armed offline update'
    ).toBe(true)

    const branches = equalityBranches(run, ((declaration as ts.VariableDeclaration).name as ts.Identifier).text)

    expect([...branches.keys()].sort()).toEqual(['activated', 'failed'])
    expect(contains(branches.get('failed')!.thenStatement, node => isCallTo(node, 'rollbackRuntimePinOverride'))).toBe(true)
    expect(contains(branches.get('failed')!.thenStatement, ts.isThrowStatement)).toBe(true)
    expect(contains(branches.get('activated')!.thenStatement, node => isCallTo(node, 'clearRuntimePinOverride'))).toBe(true)

    const offlineRollbacks = callsTo(run, 'rollbackRuntimePinOverride').filter(
      call => ts.isStringLiteralLike(call.arguments[0]!) && (call.arguments[0] as ts.StringLiteral).text.startsWith('offline')
    )

    expect(offlineRollbacks.every(call => isWithin(call, branches.get('failed')!.thenStatement))).toBe(true)
  })

  it('D5: packaged, bundle-set and legacy-source applies answer busy as deferred, after a preflight', () => {
    const apply = topLevelFunction('applyResolvedRuntimeUpdate')

    // Packaged: preflight before arming; a busy preflight is answered as deferred.
    const [packagedPreflight, ...more] = find(apply, (node): node is ts.CallExpression => isMemberCall(node, 'runtimeSwitch', 'preflight'))
    const [arm] = callsTo(apply, 'armPackagedRuntimeUpdate')

    expect(more).toEqual([])
    expect(packagedPreflight!.getStart()).toBeLessThan(arm!.getStart())

    const packagedTry = find(apply, ts.isTryStatement).find(statement => isWithin(arm!, statement.tryBlock))
    const answer = packagedTry?.catchClause?.block.statements[0]

    expect(
      answer &&
        ts.isReturnStatement(answer) &&
        answer.expression &&
        ts.isConditionalExpression(answer.expression) &&
        isCallTo(answer.expression.condition, 'isRuntimeUpdateBusy') &&
        isCallTo(answer.expression.whenTrue, 'deferredRuntimeApply')
    ).toBe(true)

    // Bundle set: a busy result is deferred, never a fall-through to the legacy chain.
    const bundleBusy = find(
      apply,
      (node): node is ts.IfStatement =>
        ts.isIfStatement(node) &&
        contains(node.expression, child => ts.isStringLiteralLike(child) && child.text === 'runtime_update_busy')
    )

    expect(bundleBusy).toHaveLength(1)
    expect(contains(bundleBusy[0]!.thenStatement, node => isCallTo(node, 'deferredRuntimeApply'))).toBe(true)
    expect(contains(bundleBusy[0]!.thenStatement, ts.isReturnStatement)).toBe(true)

    // Legacy source: preflight before the reachability probe and the override write.
    const [legacy, ...moreLegacy] = callsTo(apply, 'preflightApply')
    const [reachable] = callsTo(apply, 'isUpdateArtifactReachable')
    const [persist] = callsTo(apply, 'writeRuntimePinOverride')

    expect(moreLegacy).toEqual([])
    expect(isMember(legacy!.arguments[1], 'runtimeSwitch', 'preflight')).toBe(true)
    expect(legacy!.getStart()).toBeLessThan(reachable!.getStart())
    expect(legacy!.getStart()).toBeLessThan(persist!.getStart())

    const holder = legacy!.parent.parent

    expect(holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)).toBe(true)

    const deferred = ((holder as ts.VariableDeclaration).name as ts.Identifier).text

    expect(
      find(apply, ts.isIfStatement).some(
        node => isIdentifier(node.expression, deferred) && contains(node.thenStatement, child => ts.isReturnStatement(child) && isIdentifier(child.expression, deferred))
      )
    ).toBe(true)
  })

  it('D6: the runtime version IPC reports the deferral to the renderer', () => {
    const [registration, ...extra] = callsTo(main, 'registerRuntimeVersionIpc')

    expect(extra).toEqual([])
    expect(isMember(optionsOf(registration!, 1).get('updateDeferred'), 'packagedDeferral', 'isDeferred')).toBe(true)
  })

  it('D7: every engine install is a tracked lifecycle start, the deferred retry included', () => {
    const deferral = factoryOptions('packagedDeferral', 'createPackagedEngineDeferral')
    const reinstall = deferral.get('reinstall')

    expect(isMember(deferral.get('track'), 'localBackendLifecycle', 'start'), 'the retry runs inside a tracked start').toBe(true)
    expect(isIdentifier(deferral.get('preflight'), 'runtimeSwitch') || isMember(deferral.get('preflight'), 'runtimeSwitch', 'preflight')).toBe(
      true
    )

    const installs = callsTo(main, 'ensurePackagedEngine')

    expect(installs.length, 'landing: boot and the deferred retry both install').toBeGreaterThanOrEqual(2)

    const untracked = installs.filter(call => {
      for (let current = call.parent; current; current = current.parent) {
        if (ts.isFunctionDeclaration(current) && current.name?.text === 'runEnsureRuntime') {
          return false
        }

        if (current === reinstall) {
          return false
        }

        if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && isMemberCall(current.parent, 'localBackendLifecycle', 'start')) {
          return false
        }
      }

      return true
    })

    expect(untracked.map(lineOf)).toEqual([])
    expect(enclosingFunction(installs.find(call => isWithin(call, reinstall))!)).toBe(reinstall)
  })
})

describe('main.ts wiring for engine holders (hc-1094)', () => {
  it('H1: the shell updater ends leftovers through the same switch gate', () => {
    const [updater] = callsTo(topLevelFunction('initShellUpdater'), 'createShellUpdater')

    expect(isMember(optionsOf(updater!, 0).get('endLeftovers'), 'runtimeSwitch', 'endLeftovers')).toBe(true)
  })

  it('H2: a busy packaged or legacy apply hands its error and the log to the deferred answer', () => {
    const apply = topLevelFunction('applyResolvedRuntimeUpdate')
    const [arm] = callsTo(apply, 'armPackagedRuntimeUpdate')
    const packagedTry = find(apply, ts.isTryStatement).find(statement => isWithin(arm!, statement.tryBlock))
    const answer = packagedTry?.catchClause?.block.statements[0] as ts.ReturnStatement
    const deferred = (answer.expression as ts.ConditionalExpression).whenTrue as ts.CallExpression

    expect(isIdentifier(deferred.arguments[1], packagedTry!.catchClause!.variableDeclaration!.name.getText())).toBe(true)
    expect(isIdentifier(deferred.arguments[2], 'rememberLog')).toBe(true)

    const [legacy] = callsTo(apply, 'preflightApply')

    expect(isIdentifier(legacy!.arguments[2], 'rememberLog')).toBe(true)
  })
})
