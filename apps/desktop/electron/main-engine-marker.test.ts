/**
 * hc-1033 guard: main.ts wires the engine version marker the way packaged-runtime-marker.ts expects.
 *
 * The 10-10 "repair" click on a colleague's Mac deleted the marker of a packaged engine, and every
 * later shell kept that engine. main.ts cannot be imported in a test, so this walks its TypeScript AST
 * like main-quit-gateway.test.ts does: comments and strings cannot satisfy it.
 *
 * Does NOT catch: a marker deleted outside main.ts (install.sh / install.ps1 / the Tauri installer run
 * only for source installs), or a wiring that passes the right names but a wrong runtime value.
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

function calls(name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []

  walk(main, node => {
    if (ts.isCallExpression(node) && node.expression.getText(main) === name) {found.push(node)}
  })

  return found
}

/** `name: value` properties of the object literal passed as the call's argument `index`, whitespace collapsed. */
function properties(call: ts.CallExpression, index: number): Record<string, string> {
  const literal = call.arguments[index]

  if (!literal || !ts.isObjectLiteralExpression(literal)) {throw new Error(`${call.expression.getText(main)} takes no object literal`)}

  return Object.fromEntries(literal.properties.flatMap(property =>
    ts.isPropertyAssignment(property) ? [[property.name.getText(main), property.initializer.getText(main).replace(/\s+/g, ' ')]] : []))
}

function topLevelFunction(name: string): ts.FunctionDeclaration {
  const found = main.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name)

  if (!found?.body) {throw new Error(`main.ts has no top-level function ${name}`)}

  return found
}

/** The initializer of a top-level `const name = …`, whitespace collapsed. */
function topLevelConst(name: string): string {
  for (const statement of main.statements) {
    const declaration = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.find(item => item.name.getText(main) === name)
      : undefined

    if (declaration?.initializer) {return declaration.initializer.getText(main).replace(/\s+/g, ' ')}
  }

  throw new Error(`main.ts has no top-level const ${name}`)
}

function enclosingFunction(node: ts.Node): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) {return current.name.text}
  }

  return null
}

describe('main.ts engine marker wiring (hc-1033)', () => {
  it('repair keeps the marker exactly when this package ships its engine, and re-runs the gate', () => {
    const statements = topLevelFunction('repairBootstrapForProduction').body!.statements.map(statement => statement.getText(main))
    const [marker] = calls('repairEngineMarker')

    expect(enclosingFunction(marker)).toBe('repairBootstrapForProduction')
    expect(properties(marker, 0)).toEqual({ markerPath: 'BOOTSTRAP_COMPLETE_MARKER', keepMarker: 'IS_PACKAGED && packagedRuntimeShipped(process.resourcesPath)', log: 'rememberLog' })
    // Unconditional statements: without the reset the gate hands back this session's old "kept" result.
    expect(statements).toContain('ensurePackagedEngine.reset()')
    expect(statements.indexOf('ensurePackagedEngine.reset()')).toBeGreaterThan(statements.findIndex(text => text.startsWith('repairEngineMarker(')))
  })

  it('the only marker delete left in main.ts is the source-install update, behind the versioned-root refusal', () => {
    const deletes = calls('fs.rmSync').filter(call => call.arguments[0]?.getText(main) === 'BOOTSTRAP_COMPLETE_MARKER')

    expect(deletes.map(enclosingFunction)).toEqual(['applyResolvedRuntimeUpdate'])
    const body = main.text.slice(0, deletes[0].getStart(main))
    expect(body.lastIndexOf('isVersionedRuntimeRoot(ACTIVE_HERMES_ROOT, HERMES_HOME)')).toBeGreaterThan(body.lastIndexOf('async function applyResolvedRuntimeUpdate'))
  })

  it('the About page reads what the gate kept and may switch only where the apply stays offline', () => {
    const wiring = properties(calls('registerRuntimeVersionIpc')[0], 1)

    expect(wiring.keptBack).toBe('() => packagedEngineKeptBack(ensurePackagedEngine.waitForPending(), () => readPackagedRuntime(process.resourcesPath).release, HERMES_HOME)')
    expect(wiring.bundledEnginePin).toBe('shippedEnginePin')
    expect(topLevelConst('shippedEnginePin')).toBe('() => (IS_PACKAGED && !IS_DIAGNOSTIC_TRIAL && !process.env.HERMES_DESKTOP_HERMES_ROOT ? bundledEnginePin(process.resourcesPath) : null)')
    // hc-1095: the engine's version file names the same shipped engine, so the two cannot disagree on where it runs.
    expect(properties(calls('createDesktopVersionMirror')[0], 0).enginePin).toBe('shippedEnginePin')
    expect(wiring.applyPin).toBe('applyResolvedRuntimeUpdate')
  })
})
