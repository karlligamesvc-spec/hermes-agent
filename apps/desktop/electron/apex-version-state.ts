/**
 * apex-version-state.ts — hc-1095 版本照实说: the facts the engine needs to
 * answer "which version is this, is it the newest, how do I update".
 *
 * A user asked APEX which version it was. Nothing it could see said, so it went
 * looking: it ran the engine's own CLI (the open-source engine's name, a build
 * date, "unknown"), compared that with the open-source project's public
 * releases, said it "runs on Hermes Agent" and offered to upgrade its "kernel".
 * The truth was APEX 0.17.63, with 0.17.66 downloaded and waiting for
 * 「安装并重启」.
 *
 * Main owns that truth: the app version, the engine this app ships
 * (bundled-runtime.json's runtime_version / runtime_commit) and the shell
 * updater's state. This module mirrors them into
 * <HERMES_HOME>/apex/desktop-version.json as codes, never copy; apex-overlay
 * words them (apex_overlay/desktop_version.py): its `apex.desktop-version`
 * section gives a new session the state at its start, and its turn hook tells a
 * running session once when the state changes. The file is rewritten only when
 * a fact changes, so download progress ticks never touch the disk.
 *
 * It also relays every shell-update event to the windows, so the updater gets
 * one broadcast function from main. Electron-free.
 */

import fs from 'node:fs'
import path from 'node:path'

import { SHELL_UPDATE_EVENT_CHANNEL } from './shell-updater'

export const VERSION_STATE_DIR = 'apex'
export const VERSION_STATE_FILE = 'desktop-version.json'

/**
 * What the engine says about updates:
 * - unchecked: this launch has not finished a check yet (the first runs 60 s after boot);
 * - latest: the last check found nothing newer;
 * - downloading: a newer version was found and is downloading;
 * - downloaded: it is downloaded and waits for 「安装并重启」;
 * - deferred: the user asked to install and it waits for idle (`reason` says what for);
 * - error: the last check or download failed; the updater retries on its own;
 * - unavailable: this build does not update itself (unpackaged, or updates off by policy).
 */
export type DesktopUpdateStatus =
  | 'deferred'
  | 'downloaded'
  | 'downloading'
  | 'error'
  | 'latest'
  | 'unavailable'
  | 'unchecked'

export interface DesktopUpdateFacts {
  reason: null | string
  status: DesktopUpdateStatus
  version: null | string
}

export interface DesktopVersionState {
  app_version: string
  engine: null | { commit: string; version: string }
  schema: 1
  update: DesktopUpdateFacts
}

interface ShellUpdateSnapshot {
  deferred?: unknown
  deferredReason?: unknown
  phase?: unknown
  version?: unknown
}

interface WindowLike {
  isDestroyed: () => boolean
  webContents: { send: (channel: string, payload: unknown) => void }
}

export interface DesktopVersionMirrorOptions {
  appVersion: string
  enginePin: () => null | { commit?: unknown; version?: unknown }
  hermesHome: string
  log?: (line: string) => void
  windows: () => readonly WindowLike[]
}

const UNCHECKED: DesktopUpdateFacts = { reason: null, status: 'unchecked', version: null }

export function versionStatePath(hermesHome: string): string {
  return path.join(hermesHome, VERSION_STATE_DIR, VERSION_STATE_FILE)
}

function facts(status: DesktopUpdateStatus, version: null | string = null, reason: null | string = null) {
  return { reason, status, version }
}

/**
 * The update facts after one shell-updater state (shell-updater.ts `setState`).
 * `lastPhase` is the phase seen before it: the launch state is `idle` with none,
 * and `idle` after `checking` means the check found nothing newer. A periodic
 * recheck that finds the download already in the cache again keeps saying
 * downloaded (or deferred) instead of flickering through downloading.
 */
export function nextUpdateFacts(
  previous: DesktopUpdateFacts,
  lastPhase: null | string,
  shell: ShellUpdateSnapshot
): DesktopUpdateFacts {
  const version = typeof shell.version === 'string' && shell.version ? shell.version : null

  switch (shell.phase) {
    case 'disabled':
      return facts('unavailable')

    case 'idle':
      return lastPhase === null ? UNCHECKED : facts('latest')

    case 'available':
    case 'downloading': {
      const held = previous.status === 'downloaded' || previous.status === 'deferred'

      return held && previous.version === version ? previous : facts('downloading', version)
    }

    case 'downloaded':
      if (shell.deferred === true) {
        return facts('deferred', version, typeof shell.deferredReason === 'string' ? shell.deferredReason : 'active_work')
      }

      return facts('downloaded', version)

    case 'error':
      return facts('error')

    default:
      // `checking`, or a phase this module does not know: the last facts still hold.
      return previous
  }
}

function engineFacts(enginePin: DesktopVersionMirrorOptions['enginePin'], log: (line: string) => void) {
  try {
    const pin = enginePin()

    if (typeof pin?.version === 'string' && typeof pin.commit === 'string') {
      return { commit: pin.commit, version: pin.version }
    }
  } catch (error) {
    log(`[version-state] shipped engine unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }

  return null
}

/**
 * Keep <HERMES_HOME>/apex/desktop-version.json in step with the shell updater.
 * `follow` takes one updater state (main hands it the initial one);
 * `broadcast` is the updater's broadcast: it sends to every live window and
 * follows shell-update events. Never throws on a write failure.
 */
export function createDesktopVersionMirror(options: DesktopVersionMirrorOptions) {
  const log = options.log ?? (() => undefined)
  const target = versionStatePath(options.hermesHome)
  const engine = engineFacts(options.enginePin, log)
  let update = UNCHECKED
  let lastPhase: null | string = null
  let written: null | string = null

  function write() {
    const state: DesktopVersionState = { app_version: options.appVersion, engine, schema: 1, update }
    const text = `${JSON.stringify(state, null, 2)}\n`

    if (text === written) {
      return
    }

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const temp = `${target}.${process.pid}.tmp`
      fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temp, target)
      written = text
    } catch (error) {
      log(`[version-state] write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function follow(shell: unknown) {
    const snapshot = (shell && typeof shell === 'object' ? shell : {}) as ShellUpdateSnapshot

    update = nextUpdateFacts(update, lastPhase, snapshot)
    lastPhase = typeof snapshot.phase === 'string' ? snapshot.phase : lastPhase
    write()
  }

  function broadcast(channel: string, payload: unknown) {
    for (const win of options.windows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }

    if (channel === SHELL_UPDATE_EVENT_CHANNEL) {
      follow(payload)
    }
  }

  return { broadcast, follow }
}
