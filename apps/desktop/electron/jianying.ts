/**
 * jianying.ts — 「在剪映中打开」 on the card of a 剪映 draft the engine wrote (hc-1219).
 *
 * The engine's `jianying_draft` tool writes the draft into 剪映's own draft folder
 * (apex_overlay/jianying_build.py) and the renderer draws its result as a card
 * (src/components/chat/jianying-draft-card.tsx). The button asks main to start
 * 剪映专业版; the user then opens the draft from 剪映's home page and exports it
 * there. Nothing here clicks inside 剪映 (Kael 2026-11-11: the user exports).
 *
 * What main checks before starting 剪映: the folder it was given is a draft the
 * engine wrote (`draft_info.json` and `draft_meta_info.json` in it), so the
 * renderer cannot make main start anything for an arbitrary path; the path itself
 * is only read. It then starts the app — macOS by bundle id through
 * LaunchServices, Windows the launcher in %LOCALAPPDATA%\JianyingPro\Apps — and
 * reads 剪映's plaintext list of drafts, `root_meta_info.json`, for up to
 * LISTING_WAIT_MS: a draft written while 剪映 was closed is only taken in when it
 * starts, so the card can then say whether it is on the home page. 剪映's other
 * files are never read (once open in 剪映 they are no longer JSON).
 *
 * Electron-free: unit-tested with `vitest --project electron`.
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const JIANYING_BUNDLE_ID = 'com.lemon.lvpro'
export const JIANYING_WINDOWS_LAUNCHER = 'JianyingPro.exe'
/** Registered in apex-account-reads.ts (main.ts may not grow); written there as a literal for ipc-channel-parity. */
export const JIANYING_OPEN_CHANNEL = 'hermes:jianying:open'
/** `detached`: a Windows GUI app started on its own, so it outlives APEX; macOS asks LaunchServices (`open -b`). */
export interface LaunchCommand {
  args: string[]
  detached?: boolean
  file: string
}
export const LISTING_WAIT_MS = 15_000
const LISTING_POLL_MS = 500
const DRAFT_FILES = ['draft_info.json', 'draft_meta_info.json'] as const
const ROOT_META = 'root_meta_info.json'

export type JianyingOpenResult =
  | { ok: true; listed: boolean }
  | { ok: false; reason: 'launch_failed' | 'not_a_draft' | 'not_installed' | 'unsupported' }

export interface JianyingDeps {
  env: Record<string, string | undefined>
  exists: (target: string) => boolean
  isDirectory: (target: string) => boolean
  /** Start a GUI app and resolve with an error message, or '' when it started. */
  launch: (command: LaunchCommand) => Promise<string>
  log: (line: string) => void
  platform: NodeJS.Platform
  readText: (target: string) => null | string
  sleep: (ms: number) => Promise<void>
  waitMs?: number
}

/** A folder the engine wrote: absolute, a directory, with both of the draft's own files. */
export function isEngineDraftFolder(folder: unknown, deps: Pick<JianyingDeps, 'exists' | 'isDirectory'>): boolean {
  if (typeof folder !== 'string' || !folder || !path.isAbsolute(folder) || !deps.isDirectory(folder)) {
    return false
  }

  return DRAFT_FILES.every(name => deps.exists(path.join(folder, name)))
}

/** How to start 剪映 here, or null where APEX does not know it (or it is not installed). */
export function jianyingLaunchCommand(deps: Pick<JianyingDeps, 'env' | 'exists' | 'platform'>): LaunchCommand | null {
  if (deps.platform === 'darwin') {
    return { file: 'open', args: ['-b', JIANYING_BUNDLE_ID] }
  }

  if (deps.platform === 'win32' && deps.env.LOCALAPPDATA) {
    const launcher = path.win32.join(deps.env.LOCALAPPDATA, 'JianyingPro', 'Apps', JIANYING_WINDOWS_LAUNCHER)

    return deps.exists(launcher) ? { file: launcher, args: [], detached: true } : null
  }

  return null
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (value: string) => {
    const resolved = path.normalize(value).replace(/[\\/]+$/, '')

    return platform === 'win32' ? resolved.replace(/\//g, '\\').toLowerCase() : resolved
  }

  return norm(a) === norm(b)
}

/** Does 剪映's own list name this folder with a timeline that exists and a duration above 0. */
export function draftListed(folder: string, deps: Pick<JianyingDeps, 'exists' | 'platform' | 'readText'>): boolean {
  const text = deps.readText(path.join(path.dirname(folder), ROOT_META))

  if (!text) {
    return false
  }

  let entries: unknown

  try {
    entries = (JSON.parse(text) as { all_draft_store?: unknown }).all_draft_store
  } catch {
    return false
  }

  return (
    Array.isArray(entries) &&
    entries.some(entry => {
      const item = (entry ?? {}) as { draft_fold_path?: unknown; draft_json_file?: unknown; tm_duration?: unknown }

      return (
        typeof item.draft_fold_path === 'string' &&
        samePath(item.draft_fold_path, folder, deps.platform) &&
        typeof item.draft_json_file === 'string' &&
        deps.exists(item.draft_json_file) &&
        typeof item.tm_duration === 'number' &&
        item.tm_duration > 0
      )
    })
  )
}

export async function openDraftInJianying(folder: unknown, deps: JianyingDeps): Promise<JianyingOpenResult> {
  if (deps.platform !== 'darwin' && deps.platform !== 'win32') {
    return { ok: false, reason: 'unsupported' }
  }

  if (!isEngineDraftFolder(folder, deps)) {
    return { ok: false, reason: 'not_a_draft' }
  }

  const command = jianyingLaunchCommand(deps)

  if (!command) {
    return { ok: false, reason: 'not_installed' }
  }

  const failure = await deps.launch(command)

  if (failure) {
    deps.log(`[jianying] could not start 剪映: ${failure}`)

    return { ok: false, reason: deps.platform === 'darwin' ? 'not_installed' : 'launch_failed' }
  }

  const draft = folder as string
  const deadline = Date.now() + (deps.waitMs ?? LISTING_WAIT_MS)

  while (!draftListed(draft, deps)) {
    if (Date.now() >= deadline) {
      return { ok: true, listed: false }
    }

    await deps.sleep(LISTING_POLL_MS)
  }

  return { ok: true, listed: true }
}

function startDetached(file: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    try {
      // detached-spawn: ok — 剪映 is the user's app; it must stay open when APEX quits.
      const child = spawn(file, args, { detached: true, stdio: 'ignore' })
      child.once('error', error => resolve(error.message))
      child.once('spawn', () => {
        child.unref()
        resolve('')
      })
    } catch (error) {
      resolve(error instanceof Error ? error.message : String(error))
    }
  })
}

/** The real deps: `open -b` on macOS (LaunchServices finds 剪映 wherever it is), the launcher on Windows. */
export function jianyingDeps(log: (line: string) => void = () => undefined): JianyingDeps {
  return {
    env: process.env,
    exists: target => fs.existsSync(target),
    isDirectory: target => {
      try {
        return fs.statSync(target).isDirectory()
      } catch {
        return false
      }
    },
    launch: ({ args, detached, file }) =>
      detached
        ? startDetached(file, args)
        : new Promise(resolve => {
            execFile(file, args, { timeout: 15_000 }, error => resolve(error ? error.message : ''))
          }),
    log,
    platform: process.platform,
    readText: target => {
      try {
        return fs.readFileSync(target, 'utf8')
      } catch {
        return null
      }
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
  }
}
