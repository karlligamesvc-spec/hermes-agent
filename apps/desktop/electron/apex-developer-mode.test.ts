import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerApexAccountReads } from './apex-account-reads'
import { developerModeMarkerPath, syncDeveloperModeMarker } from './apex-developer-mode'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-developer-mode-'))
})

afterEach(() => {
  fs.rmSync(home, { force: true, recursive: true })
})

describe('syncDeveloperModeMarker', () => {
  it('creates the marker, with its folder, while developer mode is on', () => {
    syncDeveloperModeMarker(home, true, vi.fn())

    expect(fs.existsSync(path.join(home, 'apex', 'developer-mode'))).toBe(true)
  })

  it('removes the marker when developer mode goes off', () => {
    syncDeveloperModeMarker(home, true, vi.fn())
    syncDeveloperModeMarker(home, false, vi.fn())

    expect(fs.existsSync(developerModeMarkerPath(home))).toBe(false)
  })

  it('has nothing to do with no marker and no folder', () => {
    const log = vi.fn()

    syncDeveloperModeMarker(home, false, log)

    expect(fs.existsSync(path.join(home, 'apex'))).toBe(false)
    expect(log).not.toHaveBeenCalled()
  })

  it('logs a failed write instead of throwing', () => {
    const log = vi.fn()

    fs.writeFileSync(path.join(home, 'apex'), 'a file where the folder goes')

    expect(() => syncDeveloperModeMarker(home, true, log)).not.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[developer-mode] marker update failed'))
  })
})

describe('the channel the renderer calls', () => {
  function handler() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

    registerApexAccountReads(
      { handle: (channel, listener) => handlers.set(channel, listener) },
      { log: vi.fn() } as never,
      home
    )

    return handlers.get('hermes:apex:developerMode')!
  }

  it('turns the marker on and off', async () => {
    const invoke = handler()

    await invoke({}, true)
    expect(fs.existsSync(developerModeMarkerPath(home))).toBe(true)

    await invoke({}, false)
    expect(fs.existsSync(developerModeMarkerPath(home))).toBe(false)
  })

  it.each([['true'], [1], [null], [undefined], [{}]])('reads anything but true as off: %j', async value => {
    const invoke = handler()

    await invoke({}, true)
    await invoke({}, value)

    expect(fs.existsSync(developerModeMarkerPath(home))).toBe(false)
  })

  it('is the channel preload sends on', () => {
    const preload = fs.readFileSync(path.join(import.meta.dirname, 'preload.ts'), 'utf8')

    expect(preload).toContain("syncDeveloperMode: on => ipcRenderer.invoke('hermes:apex:developerMode', on)")
  })
})
