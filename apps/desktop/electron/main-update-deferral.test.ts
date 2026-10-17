/**
 * hc-906 guard: the main.ts wiring that turns an engine held by live work into
 * a deferred update instead of a failed one. Each piece's behaviour is tested
 * where it lives (deferred-runtime-update, shell-updater, packaged-runtime,
 * runtime-gateway-retirement, desktop-update); this pins where main.ts hands it
 * out. main.ts cannot be imported in a test, so this walks its TypeScript AST:
 * comments and strings cannot satisfy it.
 *
 *   D1  the native shell install runs the engine ownership gate. Without it
 *       shell-updater also turns implicit install-on-quit back on.
 *   D2  the switch runs the preflight before it fences spawns, and the
 *       preflight only inspects messaging gateways; it never retires one.
 *   D3  a busy packaged install keeps the usable engine, reports the deferral
 *       and schedules the automatic retry; quit disposes the retry.
 *   D4  a busy installer-bundled (offline) update keeps its frozen pin.
 *   D5  packaged, bundle-set and legacy-source applies answer busy with
 *       deferred: true, and preflight before they arm or persist anything.
 *   D6  the runtime version IPC reports the deferral to the renderer.
 *   D7  every engine install is a tracked lifecycle start (hc-919 C3), the
 *       deferred retry included, so quit waits for it and never begins one.
 *
 * Does NOT catch: whether the preflight's probes are right, or how the
 * renderer handles deferred: true (their own tests, listed above).
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

function isMemberCall(node: ts.Node, receiver: string, method: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === receiver &&
    node.expression.name.text === method
  )
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

function lineOf(node: ts.Node): number {
  return main.getLineAndCharacterOfPosition(node.getStart()).line + 1
}

function returnsProperty(node: ts.Node, name: string, value: string | true): boolean {
  if (!ts.isReturnStatement(node) || !node.expression || !ts.isObjectLiteralExpression(node.expression)) {
    return false
  }

  return node.expression.properties.some(property => {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== name) {
      return false
    }

    const initializer = ts.isAsExpression(property.initializer) ? property.initializer.expression : property.initializer

    return value === true
      ? initializer.kind === ts.SyntaxKind.TrueKeyword
      : ts.isStringLiteralLike(initializer) && initializer.text === value
  })
}

/** An if condition that recognises the busy signal: the error class or its wire code. */
function testsBusy(condition: ts.Expression): boolean {
  return contains(
    condition,
    node => isCallTo(node, 'isRuntimeUpdateBusy') || (ts.isStringLiteralLike(node) && node.text === 'runtime_update_busy')
  )
}

function enclosingIf(node: ts.Node): ts.IfStatement | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isIfStatement(current) && isWithin(node, current.thenStatement)) {
      return current
    }
  }

  return undefined
}

function isTrueAssignment(node: ts.Node, name: string): boolean {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(node.left) &&
    node.left.text === name &&
    node.right.kind === ts.SyntaxKind.TrueKeyword
  )
}

/** Inside runEnsureRuntime (entered only through ensureRuntime's start) or a localBackendLifecycle.start callback. */
function isTrackedStart(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name?.text === 'runEnsureRuntime') {
      return true
    }

    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      isMemberCall(current.parent, 'localBackendLifecycle', 'start')
    ) {
      return true
    }
  }

  return false
}

describe('main.ts wiring for deferred engine updates (hc-906)', () => {
  it('D1: the native shell install runs the engine ownership gate', () => {
    const [updater, ...extra] = callsTo(topLevelFunction('initShellUpdater'), 'createShellUpdater')

    expect(extra).toEqual([])
    expect(updater, 'landing: initShellUpdater creates the shell updater').toBeDefined()

    const gate = optionsOf(updater!, 0).get('beforeInstall')

    expect(gate && ts.isArrowFunction(gate) && contains(gate.body, node => isCallTo(node, 'prepareRuntimeSwitch'))).toBe(
      true
    )
  })

  it('D2: the switch preflights before it fences spawns; the preflight only inspects gateways', () => {
    const statements = topLevelFunction('prepareRuntimeSwitch').body!.statements
    const preflight = statements.findIndex(statement => contains(statement, node => isCallTo(node, 'preflightRuntimeSwitch')))

    const fence = statements.findIndex(statement =>
      contains(statement, node => isMemberCall(node, 'localBackendLifecycle', 'fenceForUpdate'))
    )

    expect(fence, 'landing: prepareRuntimeSwitch fences spawns').toBeGreaterThanOrEqual(0)
    expect(preflight).toBeGreaterThanOrEqual(0)
    expect(preflight).toBeLessThan(fence)

    const check = topLevelFunction('preflightRuntimeSwitch')
    const [retirement, ...moreRetirements] = callsTo(check, 'retirePackagedGateways')

    expect(moreRetirements).toEqual([])
    expect(retirement?.arguments[3]?.kind, 'inspect-only: the preflight never stops a gateway').toBe(
      ts.SyntaxKind.TrueKeyword
    )

    const [scan, ...moreScans] = callsTo(check, 'assertPackagedRuntimeIdle')

    expect(moreScans).toEqual([])
    expect([...optionsOf(scan!, 2).keys()].sort()).toEqual(['ownedBackendPids', 'retiringGatewayPids'])
  })

  it('D3: a busy packaged install keeps the usable engine and schedules the automatic retry', () => {
    const [failure, ...extra] = find(topLevelConst('ensurePackagedEngine'), ts.isCatchClause)

    expect(extra).toEqual([])

    // First in the catch: a busy engine must not reach the failure bookkeeping below it.
    const [busy] = failure!.block.statements

    expect(busy && ts.isIfStatement(busy) && testsBusy(busy.expression)).toBe(true)
    expect(contains((busy as ts.IfStatement).expression, node => isCallTo(node, 'isActiveRuntimeUsable'))).toBe(true)

    const deferral = (busy as ts.IfStatement).thenStatement

    expect(contains(deferral, node => isMemberCall(node, 'deferredPackagedUpdate', 'schedule'))).toBe(true)
    expect(contains(deferral, node => returnsProperty(node, 'reason', 'busy'))).toBe(true)
    expect(contains(deferral, ts.isThrowStatement)).toBe(false)

    const raised = find(main, (node): node is ts.BinaryExpression => isTrueAssignment(node, 'packagedRuntimeDeferred'))

    expect(raised.map(lineOf)).toHaveLength(1)
    expect(isWithin(raised[0]!, deferral)).toBe(true)

    const disposals = find(
      main,
      (node): node is ts.CallExpression =>
        isMemberCall(node, 'app', 'once') &&
        ts.isStringLiteralLike(node.arguments[0]!) &&
        (node.arguments[0] as ts.StringLiteral).text === 'will-quit' &&
        contains(node.arguments[1]!, child => isMemberCall(child, 'deferredPackagedUpdate', 'dispose'))
    )

    expect(disposals).toHaveLength(1)
  })

  it('D4: a busy installer-bundled update keeps its frozen pin', () => {
    const offline = find(
      topLevelFunction('runEnsureRuntime'),
      (node): node is ts.IfStatement =>
        ts.isIfStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === 'offlineUpdate'
    )

    expect(offline).toHaveLength(1)

    const busy = find(
      offline[0]!,
      (node): node is ts.IfStatement =>
        ts.isIfStatement(node) &&
        ts.isBinaryExpression(node.expression) &&
        node.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        ts.isPropertyAccessExpression(node.expression.left) &&
        node.expression.left.name.text === 'reason' &&
        ts.isStringLiteralLike(node.expression.right) &&
        node.expression.right.text === 'busy'
    )

    expect(busy).toHaveLength(1)

    const settled = [...callsTo(offline[0]!, 'rollbackRuntimePinOverride'), ...callsTo(offline[0]!, 'clearRuntimePinOverride')]

    expect(settled.length, 'landing: the offline update rolls back or clears its pin').toBeGreaterThanOrEqual(2)

    for (const call of settled) {
      expect(isWithin(call, busy[0]!.elseStatement), `line ${lineOf(call)} runs for a busy engine`).toBe(true)
    }

    expect(contains(busy[0]!.thenStatement, ts.isThrowStatement)).toBe(false)
  })

  it('D5: packaged, bundle-set and legacy-source applies answer busy with deferred: true', () => {
    const apply = topLevelFunction('applyResolvedRuntimeUpdate')
    const deferrals = find(apply, ts.isReturnStatement).filter(node => returnsProperty(node, 'deferred', true))

    expect(deferrals.map(lineOf)).toHaveLength(3)

    for (const deferral of deferrals) {
      const guard = enclosingIf(deferral)

      expect(guard && testsBusy(guard.expression), `line ${lineOf(deferral)}`).toBe(true)
    }

    // Each branch preflights before it changes anything: the packaged arm, the
    // legacy override write. The bundle set preflights in its beforeSwitch.
    const preflights = callsTo(apply, 'preflightRuntimeSwitch').map(call => call.getStart())
    const [arm] = callsTo(apply, 'armPackagedRuntimeUpdate')
    const [persist] = callsTo(apply, 'writeRuntimePinOverride')

    expect(preflights).toHaveLength(2)
    expect(preflights[0]).toBeLessThan(arm!.getStart())
    expect(preflights[1]).toBeGreaterThan(arm!.getStart())
    expect(preflights[1]).toBeLessThan(persist!.getStart())
  })

  it('D6: the runtime version IPC reports the deferral to the renderer', () => {
    const [registration, ...extra] = callsTo(main, 'registerRuntimeVersionIpc')

    expect(extra).toEqual([])

    const reporter = optionsOf(registration!, 1).get('updateDeferred')

    expect(
      reporter && ts.isArrowFunction(reporter) && ts.isIdentifier(reporter.body) && reporter.body.text === 'packagedRuntimeDeferred'
    ).toBe(true)
  })

  it('D7: every engine install is a tracked lifecycle start, the deferred retry included', () => {
    const installs = callsTo(main, 'ensurePackagedEngine')

    expect(installs.length, 'landing: boot and the deferred retry both install').toBeGreaterThanOrEqual(2)
    expect(installs.filter(call => !isTrackedStart(call)).map(lineOf)).toEqual([])
  })
})
