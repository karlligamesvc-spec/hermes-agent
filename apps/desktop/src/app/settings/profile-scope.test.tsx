// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProfileInfo } from '@/types/hermes'

// Keep store/profile's side-effecting imports inert — same seam as
// store/profile.test.ts / profile-tag.test.tsx.
vi.mock('@/store/gateway', () => ({
  $gateway: atom<unknown>(null),
  ensureGatewayForAgent: vi.fn(async () => undefined),
  ensureGatewayForProfile: vi.fn(async () => undefined),
  openGatewayForProfile: vi.fn(async () => undefined)
}))
vi.mock('@/hermes', () => ({
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  setApiRequestProfile: vi.fn()
}))
vi.mock('@/lib/query-client', () => ({ invalidateProfileScopedQueries: vi.fn() }))
vi.mock('@/store/starmap', () => ({ resetStarmapGraph: vi.fn() }))

const { $activeGatewayProfile, $profiles } = await import('@/store/profile')
const { $settingsScopeOverride } = await import('@/store/settings-scope')
const { setSingleThreadFlagForTest } = await import('@/store/single-thread')
const { setMultiBotFlagForTest } = await import('@/store/single-thread-bots')
const { setToolViewMode } = await import('@/store/tool-view')
const { SettingsProfileScope } = await import('./profile-scope')

const profile = (name: string, isDefault = false): ProfileInfo =>
  ({ has_env: false, is_default: isDefault, model: null, name }) as unknown as ProfileInfo

beforeEach(() => {
  $activeGatewayProfile.set('default')
  $settingsScopeOverride.set(null)
  $profiles.set([])
})

afterEach(cleanup)

describe('SettingsProfileScope', () => {
  it('renders nothing with fewer than two profiles', () => {
    $profiles.set([profile('default', true)])

    const { container } = render(<SettingsProfileScope />)
    expect(container.textContent).toBe('')
  })

  it('shows one chip per profile with the active profile selected by default', () => {
    $profiles.set([profile('default', true), profile('coder')])

    render(<SettingsProfileScope />)

    expect(screen.getByRole('button', { name: 'default' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'coder' })).toBeTruthy()
    // Following the active profile → no override, no "applies to X" note.
    expect($settingsScopeOverride.get()).toBeNull()
  })

  it('selecting another profile sets the shared override; re-selecting the active clears it', () => {
    $profiles.set([profile('default', true), profile('coder')])

    render(<SettingsProfileScope />)

    fireEvent.click(screen.getByRole('button', { name: 'coder' }))
    expect($settingsScopeOverride.get()).toBe('coder')

    fireEvent.click(screen.getByRole('button', { name: 'default' }))
    expect($settingsScopeOverride.get()).toBeNull()
  })
})

describe('hc-1098 several assistants on: the row is gone', () => {
  const SRC = join(__dirname, '..', '..')

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name)

      if (entry.isDirectory()) {
        return entry.name === '__identity__' ? [] : sourceFiles(path)
      }

      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
    })
  }

  function switches(singleThread: boolean, multiBot: boolean, toolView: 'product' | 'technical'): void {
    setSingleThreadFlagForTest(singleThread)
    setMultiBotFlagForTest(multiBot)
    setToolViewMode(toolView)
  }

  beforeEach(() => {
    // M7 on 0.17.66: 剪辑助手 (apex-bot-2) on screen, two more profiles on disk.
    $profiles.set([profile('default', true), profile('apex-bot-2'), profile('apex-bot-3')])
    $activeGatewayProfile.set('apex-bot-2')
  })

  afterEach(() => switches(false, false, 'product'))

  it.each([
    ['product mode with several assistants: no row, nothing to click', true, true, 'product', []],
    ['developer mode keeps the chips', true, true, 'technical', ['default', 'apex-bot-2', 'apex-bot-3']],
    [
      'multi_bot with single_thread off keeps the chips',
      false,
      true,
      'product',
      ['default', 'apex-bot-2', 'apex-bot-3']
    ],
    ['product mode with one assistant keeps the chips', true, false, 'product', ['default', 'apex-bot-2', 'apex-bot-3']]
  ] as const)('%s', (_label, singleThread, multiBot, toolView, chips) => {
    switches(singleThread, multiBot, toolView)

    const { container } = render(<SettingsProfileScope />)

    expect(screen.queryAllByRole('button').map(button => button.textContent)).toEqual(chips)
    expect(container.textContent === '').toBe(chips.length === 0)
  })

  it('goes away when several assistants turn on with the page open, and comes back in developer mode', () => {
    switches(true, false, 'product')
    render(<SettingsProfileScope />)
    expect(screen.queryAllByRole('button')).toHaveLength(3)

    act(() => setMultiBotFlagForTest(true))
    expect(screen.queryAllByRole('button')).toHaveLength(0)

    act(() => setToolViewMode('technical'))
    expect(screen.queryAllByRole('button')).toHaveLength(3)
  })

  it('only this row and its store point the settings pages at a profile', () => {
    const writers = sourceFiles(SRC)
      .filter(path => /setSettingsScope\(|\$settingsScopeOverride\.set\(/.test(readFileSync(path, 'utf8')))
      .map(path => relative(SRC, path))
      .sort()

    expect(writers).toEqual(['app/settings/profile-scope.tsx', 'store/settings-scope.ts'])
  })
})
