/**
 * hc-919 guard: main.ts wiring that the hc-844 upstream merge (050bdc6878) and
 * the earlier hc-804 merge (417053cf88) left half-applied. Each kept the
 * consumer of an upstream fix and dropped the line that made it safe:
 *
 *   C1  the remote reauth latch (#95701) is HELD in updateBootProgress, so every
 *       deliberate recovery must release it before boot is re-driven, and a
 *       retry must not re-dial the dead remote.
 *   C2  primaryProfilePin is pinned per start and must be cleared on teardown
 *       (upstream d27180ba7f), or every relaunch reuses the first-booted profile.
 *   C3  ensureRuntime is a tracked lifecycle start for EVERY caller (upstream
 *       7b9808e43b), including the fork-only messaging gateway.
 *   C4  closing the main window tears down the wake-indicator and intro-reveal
 *       windows (upstream 4ebdbadef8, 0e927c914d).
 *   C5  media keeps a failed native refresh visible to the cookie fallback
 *       (upstream 22751c8fd9).
 *
 * The sign-in half of C1 is behavioural (oauth-login-flow.test.ts); F1 is
 * notification-ipc.test.ts. main.ts cannot be imported in a test, so this
 * walks its TypeScript AST: comments and strings cannot satisfy it.
 *
 * Does NOT catch: a release behind a runtime condition the AST cannot judge
 * beyond "top-level statement of the function"; recovery reached only through
 * a function passed by reference into another module that never calls it.
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

const topLevelFunctions = new Map(
  main.statements
    .filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement))
    .filter(statement => Boolean(statement.name && statement.body))
    .map(statement => [statement.name!.text, statement])
)

type FunctionNode = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression

function topLevelFunction(name: string): ts.FunctionDeclaration {
  const found = topLevelFunctions.get(name)

  if (!found) {
    throw new Error(`main.ts has no top-level function ${name}`)
  }

  return found
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
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

/** The callback of `receiver.method('<first>', callback)`, wherever main.ts makes that call. */
function callbacksOf(receiver: string, method: string, first: string): FunctionNode[] {
  const found: FunctionNode[] = []

  walk(main, node => {
    if (!isMemberCall(node, receiver, method)) {
      return
    }

    const [channel, callback] = node.arguments

    if (channel && ts.isStringLiteralLike(channel) && channel.text === first && callback) {
      if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
        found.push(callback)
      }
    }
  })

  return found
}

function ipcHandler(channel: string): FunctionNode {
  const [handler, ...extra] = callbacksOf('ipcMain', 'handle', channel)

  if (!handler || extra.length > 0) {
    throw new Error(`expected exactly one ipcMain.handle('${channel}') in main.ts`)
  }

  return handler
}

/** Statements that run unconditionally at the top of a function body. */
function bodyStatements(fn: FunctionNode): readonly ts.Statement[] {
  return fn.body && ts.isBlock(fn.body) ? fn.body.statements : []
}

function isAssignment(node: ts.Node, name: string): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(node.left) &&
    node.left.text === name
  )
}

function isNullAssignmentStatement(statement: ts.Statement, name: string): boolean {
  return (
    ts.isExpressionStatement(statement) &&
    isAssignment(statement.expression, name) &&
    statement.expression.right.kind === ts.SyntaxKind.NullKeyword
  )
}

function isMemberCallStatement(statement: ts.Statement, receiver: string, method: string): boolean {
  return ts.isExpressionStatement(statement) && isMemberCall(statement.expression, receiver, method)
}

function contains(node: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  let hit = false

  walk(node, child => {
    hit ||= predicate(child)
  })

  return hit
}

function callsFunction(node: ts.Node, name: string): boolean {
  return contains(
    node,
    child => ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === name
  )
}

/** Whether `start` calls or passes `target`, directly or through main.ts's own top-level functions. */
function reaches(start: ts.Node, target: string): boolean {
  const seen = new Set<string>()
  const pending: ts.Node[] = [start]

  while (pending.length > 0) {
    const node = pending.pop() as ts.Node
    let hit = false

    walk(node, child => {
      if (!ts.isIdentifier(child)) {
        return
      }

      hit ||= child.text === target
      const declaration = topLevelFunctions.get(child.text)

      if (declaration && !seen.has(child.text)) {
        seen.add(child.text)
        pending.push(declaration)
      }
    })

    if (hit) {
      return true
    }
  }

  return false
}

/** Nearest named owner of `node`: a top-level-or-nested function declaration, or an object property. */
function ownerOf(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.text
    }

    if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name)) {
      return current.name.text
    }
  }

  return '<module>'
}

const LATCH = 'remoteReauthFailure'

describe('main.ts wiring the hc-844 merge half-applied (hc-919)', () => {
  it('C1: resetHermesConnection releases the reauth latch before it re-emits boot progress', () => {
    const statements = bodyStatements(topLevelFunction('resetHermesConnection'))
    const release = statements.findIndex(statement => isNullAssignmentStatement(statement, LATCH))
    const reEmit = statements.findIndex(statement => callsFunction(statement, 'resetBootProgressForReconnect'))

    expect(reEmit, 'landing: resetHermesConnection re-emits boot progress').toBeGreaterThanOrEqual(0)
    expect(release, `${LATCH} = null must be an unconditional statement`).toBeGreaterThanOrEqual(0)
    expect(release).toBeLessThan(reEmit)
  })

  it.each([
    ['hermes:bootstrap:reset', 'Reload and retry'],
    ['hermes:bootstrap:repair', 'Repair'],
    ['hermes:connection-config:apply', 'switch connection / use local'],
    ['hermes:profile:set', 'profile switch'],
    ['hermes:backend:recycle', 'Models-page recycle']
  ])('C1: %s (%s) re-homes through resetHermesConnection', channel => {
    expect(reaches(ipcHandler(channel), 'resetHermesConnection')).toBe(true)
  })

  it('C1: only a deliberate re-home or a confirmed sign-in releases the latch; one site sets it', () => {
    const assignments: { owner: string; release: boolean }[] = []

    walk(main, node => {
      if (isAssignment(node, LATCH)) {
        assignments.push({ owner: ownerOf(node), release: node.right.kind === ts.SyntaxKind.NullKeyword })
      }
    })

    expect(assignments.filter(a => !a.release).map(a => a.owner)).toEqual(['runHermesStart'])
    expect(new Set(assignments.filter(a => a.release).map(a => a.owner))).toEqual(
      new Set(['releaseReauthLatch', 'resetHermesConnection'])
    )

    // The sign-in hook is the one main.ts hands the oauth-login flow.
    const login = ipcHandler('hermes:connection-config:oauth-login')

    expect(
      contains(
        login,
        node =>
          ts.isPropertyAssignment(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'releaseReauthLatch' &&
          contains(node.initializer, child => isAssignment(child, LATCH))
      )
    ).toBe(true)
    expect(callsFunction(login, 'runOauthLoginFlow')).toBe(true)
  })

  it('C1: runHermesStart rethrows a latched reauth failure before it dials', () => {
    const statements = bodyStatements(topLevelFunction('runHermesStart'))

    const shortCircuit = statements.findIndex(
      statement =>
        ts.isIfStatement(statement) &&
        ts.isIdentifier(statement.expression) &&
        statement.expression.text === LATCH &&
        contains(
          statement.thenStatement,
          node => ts.isThrowStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === LATCH
        )
    )

    const dial = statements.findIndex(statement =>
      contains(statement, node => isMemberCall(node, 'backendConnectionState', 'getPromise'))
    )

    expect(dial, 'landing: runHermesStart reuses an in-flight attempt').toBeGreaterThanOrEqual(0)
    expect(shortCircuit, `if (${LATCH}) throw ${LATCH}`).toBeGreaterThanOrEqual(0)
    expect(shortCircuit).toBeLessThan(dial)
  })

  it('C2: resetHermesConnection clears the primary profile pin that startHermes pins', () => {
    const statements = bodyStatements(topLevelFunction('resetHermesConnection'))

    expect(contains(topLevelFunction('runHermesStart'), node => isMemberCall(node, 'primaryProfilePin', 'pin'))).toBe(
      true
    )
    expect(statements.some(statement => isMemberCallStatement(statement, 'primaryProfilePin', 'clear'))).toBe(true)
  })

  it('C3: ensureRuntime is one tracked lifecycle start, and nothing bypasses it', () => {
    const [onlyStatement, ...rest] = bodyStatements(topLevelFunction('ensureRuntime'))

    expect(rest).toEqual([])
    expect(onlyStatement && ts.isReturnStatement(onlyStatement)).toBe(true)

    const started = (onlyStatement as ts.ReturnStatement).expression

    expect(started && isMemberCall(started, 'localBackendLifecycle', 'start')).toBe(true)
    expect(callsFunction(started as ts.Node, 'runEnsureRuntime')).toBe(true)

    const bypasses: string[] = []

    walk(main, node => {
      if (ts.isIdentifier(node) && node.text === 'runEnsureRuntime') {
        const owner = ownerOf(node)

        if (owner !== 'ensureRuntime' && owner !== 'runEnsureRuntime') {
          bypasses.push(owner)
        }
      }
    })

    expect(bypasses).toEqual([])

    // The fork-only consumers the audit named; both must enter through the fence.
    for (const consumer of ['startMessagingGateway', 'runLocalAgentJob']) {
      expect(callsFunction(topLevelFunction(consumer), 'ensureRuntime'), consumer).toBe(true)
    }
  })

  it('C4: closing the main window closes the wake indicator and destroys the intro reveal', () => {
    const [closed, ...extra] = callbacksOf('mainWindow', 'on', 'closed')

    expect(extra).toEqual([])

    const statements = bodyStatements(closed as FunctionNode)

    expect(
      statements.some(statement => ts.isExpressionStatement(statement) && callsFunction(statement, 'closePetOverlay'))
    ).toBe(true)
    expect(statements.some(statement => isMemberCallStatement(statement, 'wakeIndicatorController', 'close'))).toBe(
      true
    )
    expect(statements.some(statement => isMemberCallStatement(statement, 'introRevealController', 'destroy'))).toBe(
      true
    )
  })

  it('C5: media hands a failed native refresh to the cookie fallback instead of swallowing it', () => {
    const bearers: ts.Expression[] = []

    walk(topLevelFunction('registerMediaProtocol'), node => {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'ensureRemoteBearer') {
        bearers.push(node.initializer)
      }
    })

    expect(bearers).toHaveLength(1)

    const [bearer] = bearers

    expect(ts.isArrowFunction(bearer)).toBe(true)

    const body = (bearer as ts.ArrowFunction).body

    expect(
      ts.isCallExpression(body) &&
        ts.isIdentifier(body.expression) &&
        body.expression.text === 'ensureNativeAccessToken'
    ).toBe(true)
  })
})
