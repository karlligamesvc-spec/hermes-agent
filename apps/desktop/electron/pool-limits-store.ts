/**
 * Pool limits — the main-process half: the userData file and the
 * 'hermes:pool-limits:*' IPC surface. Kept out of pool-limits.ts because that
 * module is shared with the renderer (Settings imports POOL_LIMITS_BOUNDS) and
 * must stay free of fs/electron.
 */
import fs from 'node:fs'
import path from 'node:path'

import type { IpcMain } from 'electron'

import { clampPoolLimits, mergePoolLimitsPatch, parsePoolLimits, POOL_LIMITS_DEFAULTS, type PoolLimits } from './pool-limits'

type Log = (message: string) => void

interface PoolLimitsEnv {
  HERMES_DESKTOP_POOL_MAX?: string
  HERMES_DESKTOP_POOL_IDLE_MS?: string
}

/** Saved file first; without one, the legacy HERMES_DESKTOP_POOL_* env vars
 *  (scripted/headless setups), then defaults. */
export function readPersistedPoolLimits(filePath: string, env: PoolLimitsEnv, log: Log): PoolLimits {
  try {
    const limits = parsePoolLimits(fs.readFileSync(filePath, 'utf8'))
    log(`[pool-limits] loaded from ${filePath}: maxBackends=${limits.maxBackends}, idleMs=${limits.idleMs}`)

    return limits
  } catch {
    // No persisted file yet — fall back to the legacy env vars so scripted
    // setups keep working. Log which source won: a silently-ignored env var
    // here costs a scripted-setup user a debugging session.
    const fromEnv = clampPoolLimits({
      maxBackends: Number(env.HERMES_DESKTOP_POOL_MAX) || undefined,
      idleMs: Number(env.HERMES_DESKTOP_POOL_IDLE_MS) || undefined
    })

    if (fromEnv.maxBackends !== POOL_LIMITS_DEFAULTS.maxBackends || fromEnv.idleMs !== POOL_LIMITS_DEFAULTS.idleMs) {
      log(`[pool-limits] no saved file; using env-var overrides: maxBackends=${fromEnv.maxBackends}, idleMs=${fromEnv.idleMs}`)
    } else {
      log('[pool-limits] no saved file and no env overrides; using defaults')
    }

    return fromEnv
  }
}

/** Returns false (and logs) when the write failed. */
export function persistPoolLimits(filePath: string, limits: PoolLimits, log: Log): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    // Atomic write: write to a temp file in the same directory, then rename.
    // A crash mid-write would otherwise leave truncated JSON and silently
    // lose the user's saved sizing.
    const tmpPath = `${filePath}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(limits, null, 2), 'utf8')
    fs.renameSync(tmpPath, filePath)

    return true
  } catch (error) {
    log(`[pool-limits] write failed: ${error instanceof Error ? error.message : String(error)}`)

    return false
  }
}

interface PoolLimitsIpcDependencies {
  /** Limits currently in force. */
  current: () => PoolLimits
  /** Persist and apply limits live; ok is false when only the live pool took them. */
  apply: (limits: PoolLimits) => { ok: boolean; limits: PoolLimits }
}

/**
 * hc-914: preload has always bridged getPoolLimits/setPoolLimits, but main
 * never registered these handlers, so every Settings → Advanced pool row
 * read/save rejected with "No handler registered" (guarded by
 * ipc-channel-parity.test.ts). Settings saves one knob per call, so set merges
 * the patch onto the limits in force before applying.
 */
export function registerPoolLimitsIpc(ipcMain: Pick<IpcMain, 'handle'>, dependencies: PoolLimitsIpcDependencies): void {
  ipcMain.handle('hermes:pool-limits:get', () => ({ ...dependencies.current() }))
  ipcMain.handle('hermes:pool-limits:set', (_event, patch: unknown) =>
    dependencies.apply(mergePoolLimitsPatch(dependencies.current(), patch))
  )
}
