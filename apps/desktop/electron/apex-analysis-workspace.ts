/** App-owned output directories. Never discover reports by searching other projects. */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const WORKSPACE_REPORTS = ['ANALYSIS.md', 'TIMELINE.md'] as const

function sourceDirectory(root: string, scope: string, id: string, create: boolean): string {
  if (!/^[0-9a-f-]{36}$/i.test(scope) || !id || id.length > 160) {throw new Error('workspace_invalid')}

  return confinedDirectory(root, ['analysis-workspaces', scope.toLowerCase(), crypto.createHash('sha256').update(id).digest('hex')], create)
}

function confinedDirectory(root: string, parts: string[], create: boolean): string {
  let directory = fs.realpathSync(root)

  for (const part of parts) {
    directory = path.join(directory, part)

    if (create && !fs.existsSync(directory)) {fs.mkdirSync(directory, { mode: 0o700 })}

    let stat: fs.Stats

    try {stat = fs.lstatSync(directory)} catch {throw new Error('workspace_missing')}

    if (!stat.isDirectory() || stat.isSymbolicLink()) {throw new Error('workspace_invalid')}
  }

  return directory
}

function workspaceDirectory(root: string, scope: string, id: string, revision: string, create = false): string {
  if (!/^[a-f0-9]{64}$/.test(revision)) {throw new Error('report_source_changed')}

  return confinedDirectory(sourceDirectory(root, scope, id, create), [revision], create)
}

function verifyReceipt(directory: string, scope: string, id: string, revision: string): void {
  const filename = path.join(directory, 'apex-source.json')
  let fd: number | undefined

  try {
    if (!fs.lstatSync(filename).isFile()) {throw new Error('workspace_invalid')}
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const stat = fs.fstatSync(fd)

    if (!stat.isFile() || stat.size > 4096) {throw new Error('workspace_invalid')}
    const buffer = Buffer.alloc(4097)
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0)

    if (count > 4096) {throw new Error('workspace_invalid')}
    const receipt = JSON.parse(buffer.subarray(0, count).toString('utf8'))

    if (receipt.schema !== 1 || receipt.source_id !== id || receipt.scope !== scope || receipt.revision !== revision) {
      throw new Error('workspace_invalid')
    }
  } catch {throw new Error('workspace_invalid')} finally {if (fd !== undefined) {fs.closeSync(fd)}}
}

export function prepareAnalysisWorkspace(root: string, scope: string, id: string, revision: string): string {
  const directory = workspaceDirectory(root, scope, id, revision, true)
  const filename = path.join(directory, 'apex-source.json')

  if (!fs.existsSync(filename)) {
    fs.writeFileSync(filename, JSON.stringify({ schema: 1, scope, source_id: id, revision }), { flag: 'wx', mode: 0o600 })
  }

  verifyReceipt(directory, scope, id, revision)

  return directory
}

/** Resolve an existing, source-bound directory without creating it. */
export function ownedAnalysisWorkspace(root: string, scope: string, id: string, revision: string): string {
  const directory = workspaceDirectory(root, scope, id, revision)
  verifyReceipt(directory, scope, id, revision)

  return directory
}

/** A filename is a user choice from two known outputs, never a renderer-supplied path. */
export function analysisWorkspaceReport(root: string, scope: string, id: string, revision: string, filename: string): string {
  if (!WORKSPACE_REPORTS.includes(filename as typeof WORKSPACE_REPORTS[number])) {throw new Error('report_invalid')}
  const directory = workspaceDirectory(root, scope, id, revision)
  verifyReceipt(directory, scope, id, revision)
  const file = path.join(directory, filename)
  let stat: fs.Stats

  try {stat = fs.lstatSync(file)} catch {throw new Error('workspace_report_missing')}

  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) {throw new Error('workspace_invalid')}

  return file
}

/** Source deletion also removes its local output directory; symlink children are unlinked, never followed. */
export function deleteAnalysisWorkspace(root: string, scope: string, id: string): void {
  let directory: string

  try {directory = sourceDirectory(root, scope, id, false)} catch (error) {
    if (error instanceof Error && error.message === 'workspace_missing') {return}
    throw error
  }

  fs.rmSync(directory, { recursive: true, force: true })
}
