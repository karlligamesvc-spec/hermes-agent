import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { POOL_LIMITS_DEFAULTS, type PoolLimits } from './pool-limits'
import { persistPoolLimits, readPersistedPoolLimits, registerPoolLimitsIpc } from './pool-limits-store'

let dir: string
let logs: string[]
const log = (message: string) => void logs.push(message)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-limits-store-'))
  logs = []
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('readPersistedPoolLimits', () => {
  it('prefers the saved file over env overrides', () => {
    const file = path.join(dir, 'pool-limits.json')
    fs.writeFileSync(file, JSON.stringify({ maxBackends: 9, idleMs: 120_000 }))

    expect(readPersistedPoolLimits(file, { HERMES_DESKTOP_POOL_MAX: '2' }, log)).toEqual({
      maxBackends: 9,
      idleMs: 120_000
    })
    expect(logs).toEqual([`[pool-limits] loaded from ${file}: maxBackends=9, idleMs=120000`])
  })

  it.each([
    ['env overrides', { HERMES_DESKTOP_POOL_MAX: '5', HERMES_DESKTOP_POOL_IDLE_MS: '90000' }, { maxBackends: 5, idleMs: 90_000 }],
    ['no env', {}, POOL_LIMITS_DEFAULTS],
    ['junk env', { HERMES_DESKTOP_POOL_MAX: 'lots' }, POOL_LIMITS_DEFAULTS]
  ])('falls back without a saved file: %s', (_label, env, expected) => {
    expect(readPersistedPoolLimits(path.join(dir, 'missing.json'), env, log)).toEqual(expected)
  })
})

describe('persistPoolLimits', () => {
  it('round-trips through the reader and leaves no temp file', () => {
    const file = path.join(dir, 'nested', 'pool-limits.json')

    expect(persistPoolLimits(file, { maxBackends: 4, idleMs: 300_000 }, log)).toBe(true)
    expect(readPersistedPoolLimits(file, {}, log)).toEqual({ maxBackends: 4, idleMs: 300_000 })
    expect(fs.readdirSync(path.dirname(file))).toEqual(['pool-limits.json'])
  })

  it('reports false and logs when the directory cannot be created', () => {
    const blocker = path.join(dir, 'not-a-dir')
    fs.writeFileSync(blocker, '')

    expect(persistPoolLimits(path.join(blocker, 'pool-limits.json'), POOL_LIMITS_DEFAULTS, log)).toBe(false)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^\[pool-limits\] write failed: /)
  })
})

describe('registerPoolLimitsIpc', () => {
  function register(initial: PoolLimits) {
    let current = { ...initial }
    const applied: PoolLimits[] = []
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    const ipcMain = {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }
    } as unknown as Pick<IpcMain, 'handle'>

    registerPoolLimitsIpc(ipcMain, {
      current: () => current,
      apply: limits => {
        applied.push(limits)
        current = limits

        return { ok: true, limits: { ...limits } }
      }
    })

    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

    return { applied, handlers, invoke }
  }

  it('registers exactly the two bridged channels', () => {
    expect([...register(POOL_LIMITS_DEFAULTS).handlers.keys()].sort()).toEqual([
      'hermes:pool-limits:get',
      'hermes:pool-limits:set'
    ])
  })

  it('get returns a copy of the limits in force', () => {
    const { invoke } = register({ maxBackends: 7, idleMs: 3_600_000 })
    const got = invoke('hermes:pool-limits:get') as PoolLimits

    expect(got).toEqual({ maxBackends: 7, idleMs: 3_600_000 })
    got.maxBackends = 1
    expect(invoke('hermes:pool-limits:get')).toEqual({ maxBackends: 7, idleMs: 3_600_000 })
  })

  it('set applies a single-knob patch without resetting the other knob', () => {
    const { applied, invoke } = register({ maxBackends: 7, idleMs: 3_600_000 })

    expect(invoke('hermes:pool-limits:set', { maxBackends: 5 })).toEqual({
      ok: true,
      limits: { maxBackends: 5, idleMs: 3_600_000 }
    })
    expect(invoke('hermes:pool-limits:set', { idleMs: 120_000 })).toEqual({
      ok: true,
      limits: { maxBackends: 5, idleMs: 120_000 }
    })
    expect(applied).toEqual([
      { maxBackends: 5, idleMs: 3_600_000 },
      { maxBackends: 5, idleMs: 120_000 }
    ])
  })
})
