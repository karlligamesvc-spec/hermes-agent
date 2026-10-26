/**
 * hc-1031 guard: quitting APEX stops the desktop-managed messaging gateway.
 *
 * startMessagingGateway spawns the gateway with a raw spawn(), outside
 * localBackendLifecycle, so the lifecycle's shutdown never reaches it. Before
 * hc-1031 the quit teardown (backendShutdown) stopped only the engine backends.
 * Every quit, including an update's restart, left the gateway running with
 * parent PID 1, still answering WeChat with old code and credentials. Once its
 * gateway.pid vanished, every later launch's `gateway run --replace` refused it
 * (one Mac: 2026-10-07 to 10-23).
 *
 * main.ts cannot be imported in a test, so this walks its TypeScript AST like
 * main-merge-gaps.test.ts does: comments and strings cannot satisfy it.
 *
 * Does NOT catch: a gateway spawned by a path other than startMessagingGateway;
 * a quit that skips backendShutdown (a crash or SIGKILL). The engine's
 * --replace and the update gate's runtime-status fallback handle that leftover.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const main = ts.createSourceFile('main.ts', fs.readFileSync(path.join(here, 'main.ts'), 'utf8'), ts.ScriptTarget.Latest, true)

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}

/** The callback passed to `const <name> = createBackendShutdownCoordinator(callback)`. */
function shutdownCallback(name: string): ts.Node {
  let found: ts.Node | undefined

  walk(main, node => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'createBackendShutdownCoordinator'
    ) {
      found = node.initializer.arguments[0]
    }
  })

  if (!found) {
    throw new Error(`main.ts has no ${name} = createBackendShutdownCoordinator(callback)`)
  }

  return found
}

/** Names of the calls a node makes, e.g. `stopMessagingGateway` for `stopMessagingGateway()`. */
function calledNames(node: ts.Node): string[] {
  const names: string[] = []

  walk(node, child => {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
      names.push(child.expression.text)
    }
  })

  return names
}

/** The tasks every `waitForTeardown([...])` inside a node waits for, by called name. */
function teardownTaskCalls(node: ts.Node): string[] {
  const names: string[] = []

  walk(node, child => {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'waitForTeardown') {
      const [tasks] = child.arguments

      if (tasks && ts.isArrayLiteralExpression(tasks)) {
        for (const task of tasks.elements) {
          if (ts.isCallExpression(task) && ts.isIdentifier(task.expression)) {
            names.push(task.expression.text)
          }
        }
      }
    }
  })

  return names
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

describe('quitting stops the messaging gateway (hc-1031)', () => {
  it('the quit teardown waits for stopMessagingGateway()', () => {
    expect(teardownTaskCalls(shutdownCallback('backendShutdown'))).toContain('stopMessagingGateway')
  })

  it('exiting after the teardown runs that teardown', () => {
    let runsTeardown = false

    walk(topLevelFunction('exitAfterBackendShutdown'), node => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'backendShutdown' &&
        node.expression.name.text === 'run'
      ) {
        runsTeardown = true
      }
    })

    expect(runsTeardown).toBe(true)
  })

  it('stopMessagingGateway stops the tracked child and waits for it to exit', () => {
    expect(calledNames(topLevelFunction('stopMessagingGateway'))).toEqual(
      expect.arrayContaining(['stopBackendChild', 'waitForBackendExit'])
    )
  })
})
