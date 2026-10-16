/**
 * hc-914 guard: every renderer→main channel the preload bridge exposes must
 * have a LIVE main-process listener.
 *
 * preload.ts exposed getPoolLimits/setPoolLimits for months while main never
 * registered 'hermes:pool-limits:get' / ':set'. Nothing failed at build or test
 * time — only the packaged app logged "No handler registered" and Settings →
 * Advanced pool rows silently kept defaults. This test closes the whole class:
 *
 *   ipcRenderer.invoke(ch)            → ipcMain.handle(ch) / handleOnce(ch)
 *   ipcRenderer.send(ch) / sendSync(ch) → ipcMain.on(ch) / once(ch)
 *
 * "Live" means the registration actually runs: a top-level statement of
 * main.ts, a main.ts function that main.ts calls, or an exported registrar in
 * another electron/ module that main.ts imports AND calls.
 *
 * It walks the TypeScript AST, so a channel that only appears in a comment or
 * a string elsewhere cannot satisfy it.
 *
 * Does NOT catch: registrations behind a runtime condition (platform, packaged
 * build, feature flag) inside a registrar that main does call; handlers that
 * throw; main→renderer channels (webContents.send → ipcRenderer.on); a single
 * call made through an alias or element access (`ipcRenderer['invoke']`) —
 * the landing counts only notice when the parser goes blind wholesale.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))

interface IpcCall {
  file: string
  method: string
  /** null when the first argument is not a string literal (the guard cannot see it). */
  channel: null | string
  /** Top-level declaration that contains the call; null = runs at module top level. */
  owner: null | string
}

function parseSource(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(path.join(here, file), 'utf8'), ts.ScriptTarget.Latest, true)
}

function topLevelOwner(node: ts.Node): null | string {
  let current = node

  while (current.parent && !ts.isSourceFile(current.parent)) {
    current = current.parent
  }

  if (ts.isFunctionDeclaration(current)) {
    return current.name?.text ?? null
  }

  if (ts.isVariableStatement(current)) {
    const [declaration] = current.declarationList.declarations

    // `const x = registerFoo()` runs at module load; only a function-valued
    // declaration defers its body until something calls it.
    const init = declaration?.initializer

    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && ts.isIdentifier(declaration.name)) {
      return declaration.name.text
    }
  }

  return null
}

function collectIpcCalls(source: ts.SourceFile, receiver: string, methods: readonly string[]): IpcCall[] {
  const calls: IpcCall[] = []

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === receiver &&
      methods.includes(node.expression.name.text)
    ) {
      const [first] = node.arguments

      calls.push({
        file: source.fileName,
        method: node.expression.name.text,
        channel: first && ts.isStringLiteralLike(first) ? first.text : null,
        owner: topLevelOwner(node)
      })
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return calls
}

function calledFunctionNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      names.add(node.expression.text)
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return names
}

/** module specifier ('./fs-ipc') → names main imports from it. */
function namedImports(source: ts.SourceFile): Map<string, Set<string>> {
  const imports = new Map<string, Set<string>>()

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }

    // Side-effect imports (`import './x'`) still load the module.
    const names = imports.get(statement.moduleSpecifier.text) ?? new Set<string>()
    const bindings = statement.importClause?.namedBindings

    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        names.add(element.name.text)
      }
    }

    imports.set(statement.moduleSpecifier.text, names)
  }

  return imports
}

const MAIN_METHODS = ['handle', 'handleOnce', 'on', 'once'] as const
const RENDERER_METHODS = ['invoke', 'send', 'sendSync'] as const

const mainSource = parseSource('main.ts')
const mainCalls = calledFunctionNames(mainSource)
const mainImports = namedImports(mainSource)

const electronModules = fs
  .readdirSync(here)
  .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
  .filter(name => name !== 'preload.ts')

const registrations = electronModules.flatMap(name =>
  collectIpcCalls(name === 'main.ts' ? mainSource : parseSource(name), 'ipcMain', MAIN_METHODS)
)

function isLive(call: IpcCall): boolean {
  if (call.file === 'main.ts') {
    return call.owner === null || mainCalls.has(call.owner)
  }

  if (call.owner === null) {
    // Module-level registration in a side module: live only if main loads it.
    return mainImports.has(`./${call.file.replace(/\.ts$/, '')}`)
  }

  const imported = mainImports.get(`./${call.file.replace(/\.ts$/, '')}`)

  return Boolean(imported?.has(call.owner)) && mainCalls.has(call.owner)
}

const liveRegistrations = registrations.filter(isLive)
const liveHandles = new Set(liveRegistrations.filter(c => c.method.startsWith('handle')).map(c => c.channel))
const liveListeners = new Set(liveRegistrations.filter(c => !c.method.startsWith('handle')).map(c => c.channel))

const rendererCalls = collectIpcCalls(parseSource('preload.ts'), 'ipcRenderer', RENDERER_METHODS)
const invokeChannels = new Set(rendererCalls.filter(c => c.method === 'invoke').map(c => c.channel as string))

const sendChannels = new Set(
  rendererCalls.filter(c => c.method === 'send' || c.method === 'sendSync').map(c => c.channel as string)
)

/** Channels without a live listener, naming any registration main never runs. */
function orphans(channels: Set<string>, live: Set<null | string>, kind: 'handle' | 'on'): string[] {
  return [...channels]
    .filter(channel => !live.has(channel))
    .sort()
    .map(channel => {
      const dead = registrations.find(c => c.channel === channel && c.method.startsWith('handle') === (kind === 'handle'))

      return dead ? `${channel} (registered by ${dead.file}:${dead.owner ?? '<module>'}, which main never runs)` : channel
    })
}

describe('preload ↔ main IPC channel parity (hc-914)', () => {
  it('actually sees the bridge and the main registrations', () => {
    // Landing assertions: an empty parse would make every parity check below
    // vacuously green.
    expect(invokeChannels.size).toBeGreaterThan(100)
    expect(sendChannels.size).toBeGreaterThan(10)
    expect(liveHandles.size).toBeGreaterThan(100)
    expect(invokeChannels).toContain('hermes:pool-limits:get')
    expect(invokeChannels).toContain('hermes:pool-limits:set')
    // A registrar in a side module only counts through main's import + call.
    expect(liveHandles).toContain('hermes:fs:readDir')
  })

  it('every bridged channel is a string literal the guard can check', () => {
    const opaque = [...rendererCalls, ...registrations]
      .filter(c => c.channel === null)
      .map(c => `${c.file}: ${c.method}(<non-literal>)`)

    expect(opaque).toEqual([])
  })

  it('every ipcRenderer.invoke channel has a live ipcMain.handle', () => {
    expect(orphans(invokeChannels, liveHandles, 'handle')).toEqual([])
  })

  it('every ipcRenderer.send/sendSync channel has a live ipcMain.on', () => {
    expect(orphans(sendChannels, liveListeners, 'on')).toEqual([])
  })
})
