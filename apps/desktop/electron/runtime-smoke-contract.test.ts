/**
 * The consumer smoke (scripts/bundled-runtime-consumer-smoke.mts) runs only inside the signed
 * release builds, never on a PR. #386 changed the idle gate's holder filter, its busy error,
 * gateway retirement and the switch gate; the native unit test followed, the smoke's private
 * copies did not, and the 0.17.59 candidate failed on all three platforms. These Linux-safe pins
 * run on every PR that touches apps/desktop (the frontend lane): the anchor the smoke reverses is
 * the product's one filter line, the smoke drives Desktop's own switch gate and gateway command,
 * and every busy refusal is classified by the product's isRuntimeUpdateBusy, never by wording.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import ts from 'typescript'
import { expect, test } from 'vitest'

import { buildGatewayRunArgs } from './apex-gateway'
import { IDLE_PID_FILTER_ANCHOR, IDLE_PID_FILTER_REVERSED, relocateCopiedLegacyTree } from './fixtures/runtime-smoke'

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

const isIdentifier = (node: ts.Node | undefined, name: string) => !!node && ts.isIdentifier(node) && node.text === name

const callsOf = (root: ts.Node, callee: string) =>
  nodesIn(root, ts.isCallExpression).filter(call => isIdentifier(call.expression, callee))

/** `assert.<method>(...)` calls inside `root`. */
const assertCalls = (root: ts.Node, method: string) =>
  nodesIn(root, ts.isCallExpression).filter(call =>
    ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === method && isIdentifier(call.expression.expression, 'assert')
  )

/** `assert.rejects(<callee>(...), validator)` calls inside `root`. */
const rejectsOf = (root: ts.Node, callee: string) =>
  assertCalls(root, 'rejects').filter(call =>
    call.arguments.length === 2 && ts.isCallExpression(call.arguments[0]) && isIdentifier(call.arguments[0].expression, callee)
  )

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
    ['IDLE_PID_FILTER_ANCHOR', 'IDLE_PID_FILTER_REVERSED', 'gatewayFixtureScript', 'gatewayRuntimeState', 'relocateCopiedLegacyTree'].sort()
  )
  expect(importedNames(smoke, '../electron/runtime-update-busy.ts')).toEqual(['isRuntimeUpdateBusy'])

  for (const text of literalTexts(smoke)) {
    expect(text, 'the holder filter anchor lives in fixtures/runtime-smoke.ts').not.toContain('holderPids')
    expect(text, 'the gateway fixture lives in fixtures/runtime-smoke.ts').not.toContain('write_pid_file')
    // Both product wordings of the busy refusal, before and after #386.
    expect(text, 'the busy refusal is classified by isRuntimeUpdateBusy, not by its wording').not.toMatch(/previous engine is still running|Waiting for engine workers/)
  }

  // A flipped or wrapped classifier would accept the opposite outcome.
  const negated = nodesIn(smoke, ts.isPrefixUnaryExpression).filter(node =>
    node.operator === ts.SyntaxKind.ExclamationToken && ts.isCallExpression(node.operand) && isIdentifier(node.operand.expression, 'isRuntimeUpdateBusy')
  )

  expect(negated).toHaveLength(0)

  const idleGate = functionNamed(smoke, 'verifyRuntimeIdleGate')
  const borrowedWorker = rejectsOf(idleGate, 'assertPackagedRuntimeIdle')
  expect(borrowedWorker).toHaveLength(1)

  const classified = assertCalls(borrowedWorker[0].arguments[1], 'ok').filter(call =>
    ts.isCallExpression(call.arguments[0]) && isIdentifier(call.arguments[0].expression, 'isRuntimeUpdateBusy')
  )

  expect(classified, 'the borrowed-worker refusal must be assert.ok(isRuntimeUpdateBusy(error))').toHaveLength(1)
  expect(nodesIn(idleGate, ts.isIdentifier).some(node => node.text === 'IDLE_PID_FILTER_ANCHOR')).toBe(true)
  expect(nodesIn(idleGate, ts.isIdentifier).some(node => node.text === 'IDLE_PID_FILTER_REVERSED')).toBe(true)

  const gatewayRetirement = functionNamed(smoke, 'verifyGatewayRetirement')
  expect(callsOf(gatewayRetirement, 'gatewayFixtureScript')).toHaveLength(1)
  const busyGateway = rejectsOf(gatewayRetirement, 'retirePackagedGateways')
  expect(busyGateway).toHaveLength(2)
  // Retirement drains only a gateway that reports itself idle: busy, then idle state.
  expect(callsOf(gatewayRetirement, 'gatewayRuntimeState').map(call => call.arguments[1]?.getText())).toEqual(['1', '0'])

  const legacyGateway = functionNamed(smoke, 'verifyLegacyGatewayUpgrade')
  const deferredSwitches = rejectsOf(legacyGateway, 'installPackagedRuntime')
  expect(deferredSwitches, 'a borrowed worker and a gateway that never drains must each defer the switch').toHaveLength(2)

  for (const call of [...busyGateway, ...deferredSwitches]) {
    expect(isIdentifier(call.arguments[1], 'isRuntimeUpdateBusy'), `${call.getText()} must validate with isRuntimeUpdateBusy itself`).toBe(true)
  }

  expect(callsOf(smoke, 'verifyLegacyGatewayUpgrade')).toHaveLength(1)
})

test('the smoke switches engines through Desktop\'s own gate and starts gateways with Desktop\'s argv', () => {
  const smoke = parse('scripts/bundled-runtime-consumer-smoke.mts')
  expect(importedNames(smoke, '../electron/runtime-switch-gate.ts')).toEqual(['createRuntimeSwitchGate'])
  expect(callsOf(functionNamed(smoke, 'switchGate'), 'createRuntimeSwitchGate')).toHaveLength(1)

  const consumer = functionNamed(smoke, 'consumer')
  expect(callsOf(consumer, 'switchGate')).toHaveLength(1)

  for (const handRolled of ['retirePackagedGateways', 'assertPackagedRuntimeIdle']) {
    expect(callsOf(consumer, handRolled), `consumer() must not re-implement the switch gate with ${handRolled}`).toHaveLength(0)
  }

  // The legacy gateway is started with Desktop's argv for `python -m hermes_cli.main`. F8-era and
  // 0.17.58 Desktops passed exactly this; if it ever changes, the smoke must keep starting the
  // legacy gateway the way the legacy Desktop did, not the way the new one would.
  expect(importedNames(smoke, '../electron/apex-gateway.ts')).toEqual(['buildGatewayRunArgs'])
  expect(callsOf(functionNamed(smoke, 'verifyLegacyGatewayUpgrade'), 'buildGatewayRunArgs')).toHaveLength(1)
  expect(buildGatewayRunArgs()).toEqual(['gateway', 'run', '--replace'])
})

test('the native retirement test drives the same gateway fixture as the smoke', () => {
  const unit = parse('electron/runtime-gateway-retirement.test.ts')
  expect(importedNames(unit, './fixtures/runtime-smoke')).toEqual(expect.arrayContaining(['gatewayFixtureScript', 'gatewayRuntimeState']))
  expect(callsOf(unit, 'gatewayFixtureScript').length).toBeGreaterThan(0)

  for (const text of literalTexts(unit)) {
    expect(text, 'the gateway fixture lives in fixtures/runtime-smoke.ts').not.toContain('write_pid_file')
  }
})

test('the smoke stamps each copied legacy tree for its own location', () => {
  const smoke = parse('scripts/bundled-runtime-consumer-smoke.mts')
  const seed = functionNamed(smoke, 'seedOld')
  expect(callsOf(seed, 'relocateCopiedLegacyTree')).toHaveLength(1)
  // Node's default turns the copy's relative venv/bin/python into a link to the source tree.
  const copies = nodesIn(seed, ts.isCallExpression).filter(call => call.expression.getText() === 'fs.cpSync' && call.arguments[0]?.getText() === 'legacySource')
  expect(copies).toHaveLength(1)
  const options = copies[0].arguments[2]
  expect(!!options && ts.isObjectLiteralExpression(options) && options.properties.some(property =>
    ts.isPropertyAssignment(property) && property.name.getText() === 'verbatimSymlinks' && property.initializer.kind === ts.SyntaxKind.TrueKeyword)).toBe(true)
})

test.each([
  ['POSIX', ['lib', 'python3.11', 'site-packages'], '/runner/_temp/legacy-f8/tree'],
  ['Windows', ['Lib', 'site-packages'], 'D:\\a\\_temp\\legacy-f8\\tree']
])('a copied %s legacy venv names its own interpreter and editable sources', (_os, sitePackages, source) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-legacy-copy-'))

  try {
    const site = path.join(root, 'venv', ...sitePackages)
    fs.mkdirSync(site, { recursive: true })
    fs.mkdirSync(path.join(root, '.runtime'))
    const escaped = source.split('\\').join('\\\\')
    const forward = source.split('\\').join('/')
    fs.writeFileSync(path.join(root, 'venv', 'pyvenv.cfg'), `home = ${source}/.runtime/py/cpython-3.11.15/bin\nrelocatable = true\n`)
    fs.writeFileSync(path.join(site, '__editable___hermes_agent_finder.py'), `MAPPING = {'hermes_cli': '${escaped}/hermes_cli', 'gateway': '${forward}/gateway'}\n`)
    fs.writeFileSync(path.join(site, '__editable__.hermes_agent.pth'), `import __editable___hermes_agent_finder; '${source}'\n`)
    fs.writeFileSync(path.join(site, 'unrelated.pth'), `${source}\n`)
    const result = relocateCopiedLegacyTree(source, root)
    const all = [source, escaped, forward]

    expect(fs.readFileSync(path.join(root, 'venv', 'pyvenv.cfg'), 'utf8')).toBe(`home = ${root}/.runtime/py/cpython-3.11.15/bin\nrelocatable = true\n`)

    for (const name of ['__editable___hermes_agent_finder.py', '__editable__.hermes_agent.pth']) {
      const text = fs.readFileSync(path.join(site, name), 'utf8')
      expect(all.some(form => text.includes(form)), `${name} still names the source tree`).toBe(false)
      expect(text).toContain(root)
    }

    expect(result.rewritten.sort()).toEqual([path.join('venv', ...sitePackages, '__editable__.hermes_agent.pth'), path.join('venv', ...sitePackages, '__editable___hermes_agent_finder.py')].sort())
    expect(fs.readFileSync(path.join(site, 'unrelated.pth'), 'utf8'), 'only the fixup\'s own files move').toBe(`${source}\n`)
    expect(JSON.parse(fs.readFileSync(path.join(root, '.runtime', 'fixup-state.json'), 'utf8')).current_root).toBe(root)
    // A tree that never named the source is not a copy of it.
    expect(() => relocateCopiedLegacyTree('/elsewhere/tree', root)).toThrow(/nothing to relocate/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
