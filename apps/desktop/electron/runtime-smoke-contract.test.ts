/**
 * The consumer smoke (scripts/bundled-runtime-consumer-smoke.mts) runs only inside the signed
 * release builds, never on a PR. #386 changed the idle gate's holder filter, its busy error and
 * the gateway drain handshake; the native unit test followed, the smoke's private copies did not,
 * and the 0.17.59 candidate failed on all three platforms. These Linux-safe pins run on every PR:
 * the anchor the smoke reverses is the product's one filter line, and the smoke and the native
 * retirement test share one gateway fixture and the product's own busy classifier.
 */
import fs from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { expect, test } from 'vitest'

import { IDLE_PID_FILTER_ANCHOR, IDLE_PID_FILTER_REVERSED } from './fixtures/runtime-smoke'

const desktopRoot = path.resolve(import.meta.dirname, '..')
const sourceOf = (file: string) => fs.readFileSync(path.join(desktopRoot, file), 'utf8')

const parse = (file: string) => ts.createSourceFile(file, sourceOf(file), ts.ScriptTarget.Latest, true)

function nodesIn<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = []

  const visit = (node: ts.Node) => {
    if (predicate(node)) {found.push(node)}
    ts.forEachChild(node, visit)
  }

  visit(root)

  return found
}

function functionNamed(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const match = nodesIn(file, ts.isFunctionDeclaration).find(node => node.name?.text === name)
  expect(match, `${file.fileName} must declare ${name}`).toBeDefined()

  return match!
}

function importedNames(file: ts.SourceFile, specifier: string): string[] {
  return nodesIn(file, ts.isImportDeclaration)
    .filter(node => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === specifier)
    .flatMap(node => {
      const bindings = node.importClause?.namedBindings

      return bindings && ts.isNamedImports(bindings) ? bindings.elements.map(element => element.name.text) : []
    })
}

const literalTexts = (root: ts.Node) =>
  nodesIn(root, (node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
  ).map(node => node.text)

/** `assert.rejects(<call of callee>(...), validator)` calls inside `root`. */
function rejectsOf(root: ts.Node, callee: string): ts.CallExpression[] {
  return nodesIn(root, ts.isCallExpression).filter(call =>
    ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'rejects' &&
    ts.isIdentifier(call.expression.expression) && call.expression.expression.text === 'assert' &&
    call.arguments.length === 2 && ts.isCallExpression(call.arguments[0]) &&
    ts.isIdentifier(call.arguments[0].expression) && call.arguments[0].expression.text === callee
  )
}

const mentions = (root: ts.Node, identifier: string) => nodesIn(root, ts.isIdentifier).some(node => node.text === identifier)

const callsOf = (root: ts.Node, callee: string) =>
  nodesIn(root, ts.isCallExpression).filter(call => ts.isIdentifier(call.expression) && call.expression.text === callee)

test('the smoke reverses the one holder filter inside assertPackagedRuntimeIdle', () => {
  const product = parse('electron/packaged-runtime.ts')
  const body = product.getFullText()
  expect(body.split(IDLE_PID_FILTER_ANCHOR).length - 1).toBe(1)

  const gate = functionNamed(product, 'assertPackagedRuntimeIdle')
  const at = body.indexOf(IDLE_PID_FILTER_ANCHOR)
  expect(at).toBeGreaterThanOrEqual(gate.getStart())
  expect(at + IDLE_PID_FILTER_ANCHOR.length).toBeLessThanOrEqual(gate.getEnd())
  // The reversal keeps the binding and drops the whole filter, so the scanner's own PID counts.
  expect(IDLE_PID_FILTER_ANCHOR.startsWith(`${IDLE_PID_FILTER_REVERSED}.filter(`)).toBe(true)
})

test('the consumer smoke uses the shared fixtures and the product busy classifier, never private copies', () => {
  const smoke = parse('scripts/bundled-runtime-consumer-smoke.mts')
  expect(importedNames(smoke, '../electron/fixtures/runtime-smoke.ts').sort()).toEqual(
    ['IDLE_PID_FILTER_ANCHOR', 'IDLE_PID_FILTER_REVERSED', 'gatewayFixtureScript', 'gatewayRuntimeState'].sort()
  )
  expect(importedNames(smoke, '../electron/runtime-update-busy.ts')).toEqual(['isRuntimeUpdateBusy'])

  for (const text of literalTexts(smoke)) {
    expect(text, 'the holder filter anchor lives in fixtures/runtime-smoke.ts').not.toContain('holderPids')
    expect(text, 'the gateway fixture lives in fixtures/runtime-smoke.ts').not.toContain('write_pid_file')
    expect(text, 'the busy refusal is classified by isRuntimeUpdateBusy, not by its wording').not.toMatch(/still running|Waiting for engine workers/)
  }

  const idleGate = functionNamed(smoke, 'verifyRuntimeIdleGate')
  const borrowedWorker = rejectsOf(idleGate, 'assertPackagedRuntimeIdle')
  expect(borrowedWorker).toHaveLength(1)
  expect(mentions(borrowedWorker[0].arguments[1], 'isRuntimeUpdateBusy')).toBe(true)
  expect(mentions(idleGate, 'IDLE_PID_FILTER_ANCHOR') && mentions(idleGate, 'IDLE_PID_FILTER_REVERSED')).toBe(true)

  const gatewayRetirement = functionNamed(smoke, 'verifyGatewayRetirement')
  expect(callsOf(gatewayRetirement, 'gatewayFixtureScript')).toHaveLength(1)
  const busyGateway = rejectsOf(gatewayRetirement, 'retirePackagedGateways')
  expect(busyGateway.length).toBeGreaterThanOrEqual(2)

  for (const call of busyGateway) {
    expect(mentions(call.arguments[1], 'isRuntimeUpdateBusy')).toBe(true)
  }

  // Retirement drains only a gateway that reports itself idle: the smoke must write that state.
  expect(callsOf(gatewayRetirement, 'gatewayRuntimeState').map(call => call.arguments[1]?.getText())).toEqual(['1', '0'])
})

test('the native retirement test drives the same gateway fixture as the smoke', () => {
  const unit = parse('electron/runtime-gateway-retirement.test.ts')
  expect(importedNames(unit, './fixtures/runtime-smoke')).toEqual(expect.arrayContaining(['gatewayFixtureScript', 'gatewayRuntimeState']))
  expect(callsOf(unit, 'gatewayFixtureScript')).toHaveLength(1)

  for (const text of literalTexts(unit)) {
    expect(text, 'the gateway fixture lives in fixtures/runtime-smoke.ts').not.toContain('write_pid_file')
  }
})
