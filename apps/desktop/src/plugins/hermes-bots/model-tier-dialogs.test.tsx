/**
 * hc-960: an assistant's tier lives in its own settings (Kael 2026-10-19,
 * decision B). On an APEX account Bot Mode's "添加助手" and "编辑…" dialogs show
 * Flash / Pro / Max in the main form and no model picker anywhere; the pick
 * is written as the tier alias on the managed relay.
 */

import type * as HermesSdk from '@hermes/plugin-sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as DataModule from './data'
import { translateBots } from './i18n-test-helper'
import type { RosterRow } from './types'

const RELAY = 'custom:apex-nodes.com'

const mocks = vi.hoisted(() => ({
  connections: vi.fn(async () => [] as { id: string; label: string }[]),
  createCanonicalChat: vi.fn(async () => 'session-1'),
  getGlobalModelOptions: vi.fn(),
  notify: vi.fn(),
  notifyError: vi.fn(),
  request: vi.fn(),
  requestProfile: vi.fn(async () => ({})),
  saveBotMeta: vi.fn(),
  tierMode: { value: true }
}))

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const original = await importOriginal<typeof HermesSdk>()

  return {
    ...original,
    host: {
      ...original.host,
      connections: mocks.connections,
      notify: mocks.notify,
      notifyError: mocks.notifyError,
      request: mocks.request,
      requestProfile: mocks.requestProfile
    },
    SkillsView: undefined,
    useModelTierMode: () => mocks.tierMode.value,
    usePluginI18n: () => translateBots
  }
})

// The tier cards read the account's entitled list from the active profile.
vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<object>()),
  getGlobalModelOptions: () => mocks.getGlobalModelOptions()
}))

vi.mock('./canonical-chat', () => ({ createCanonicalChat: mocks.createCanonicalChat }))
vi.mock('./data', async importOriginal => {
  const original = await importOriginal<typeof DataModule>()

  return { ...original, saveBotMeta: mocks.saveBotMeta }
})

vi.setConfig({ testTimeout: 30_000 })

const roster: RosterRow[] = [{ connectionId: 'local', name: 'default' }]

function withQueryClient(children: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  )
}

function calls(method: string) {
  return mocks.request.mock.calls.filter(([name]) => name === method)
}

const MODEL_WORDS = /deepseek|kimi|mimo|gemini|qwen|glm|claude|-APEX|apex-(flash|pro|max)/i

beforeAll(async () => {
  Element.prototype.scrollIntoView = () => undefined
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.setPointerCapture = () => undefined
  await import('./create-dialog')
  await import('./edit-profile-dialog')
}, 120_000)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.tierMode.value = true
  mocks.connections.mockResolvedValue([])
  mocks.saveBotMeta.mockResolvedValue({ serverOutcome: 'persisted' })
  mocks.getGlobalModelOptions.mockResolvedValue({
    providers: [{ models: ['apex-flash', 'apex-pro', 'deepseek-flash-APEX'], name: 'Apex-nodes.com', slug: RELAY }]
  })
  mocks.request.mockImplementation(async (method: string) => {
    switch (method) {
      case 'profiles.describe':
        return {
          mcp_servers: [],
          model: { default: 'deepseek-flash-APEX', provider: 'custom' },
          skills: [],
          toolsets: []
        }

      case 'mcp.catalog':
        return { servers: [] }

      case 'profiles.configure':
        return { applied: { model: true } }

      // What a model picker would list if one were mounted.
      case 'model.options':
        return { providers: [{ models: ['kimi-k2.7-code', 'deepseek-v4-pro'], name: 'Apex-nodes.com', slug: RELAY }] }

      default:
        return {}
    }
  })
})

afterEach(() => {
  cleanup()
})

describe('添加助手', () => {
  async function openCreate() {
    const { CreateAgentDialog } = await import('./create-dialog')

    const view = render(withQueryClient(<CreateAgentDialog onClose={() => undefined} open roster={roster} />))

    fireEvent.change(screen.getByPlaceholderText('inbox-triage'), { target: { value: 'script-writer' } })

    return view
  }

  it('starts a new assistant on Flash, with no model picker even under Advanced', async () => {
    await openCreate()

    const flash = await screen.findByRole('radio', { name: /Flash/ })
    expect(flash.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    // Advanced loads its capability catalog; a mounted model picker would ask
    // for model.options in the same tick. Wait for the former, then require
    // that the latter never happened and nothing on screen names a model.
    await waitFor(() => expect(calls('mcp.catalog').length).toBeGreaterThan(0))
    await act(async () => undefined)
    expect(calls('model.options')).toHaveLength(0)
    expect(screen.queryByText('Provider')).toBeNull()
    expect(globalThis.document.body.textContent ?? '').not.toMatch(MODEL_WORDS)

    fireEvent.click(screen.getByRole('button', { name: 'Add assistant' }))

    await waitFor(() => expect(calls('profiles.create')).toHaveLength(1))
    expect(calls('profiles.create')[0][1]).toMatchObject({
      model: 'apex-flash',
      name: 'script-writer',
      provider: RELAY
    })
  })

  it('writes the tier picked in the main form', async () => {
    await openCreate()

    const pro = await screen.findByRole('radio', { name: /Pro/ })
    await waitFor(() => expect(pro.getAttribute('data-state')).toBe('available'))
    fireEvent.click(pro)
    fireEvent.click(screen.getByRole('button', { name: 'Add assistant' }))

    await waitFor(() => expect(calls('profiles.create')).toHaveLength(1))
    expect(calls('profiles.create')[0][1]).toMatchObject({ model: 'apex-pro', provider: RELAY })
  })

  it('(control) keeps the plain model picker without tier mode', async () => {
    mocks.tierMode.value = false
    await openCreate()

    expect(screen.queryByRole('radio', { name: /Flash/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    expect(await screen.findByText('Provider')).toBeTruthy()
    expect(calls('model.options').length).toBeGreaterThan(0)
  })
})

describe('编辑…', () => {
  const bot: RosterRow = { connectionId: 'local', name: 'script-writer' }

  it('reads the assistant’s current tier and saves a new one through profiles.configure', async () => {
    const { EditProfileDialog } = await import('./edit-profile-dialog')

    render(withQueryClient(<EditProfileDialog bot={bot} onClose={() => undefined} open />))

    // The pre-tier seed reads as Flash.
    const flash = await screen.findByRole('radio', { name: /Flash/ })
    await waitFor(() => expect(flash.getAttribute('aria-checked')).toBe('true'))
    expect(globalThis.document.body.textContent ?? '').not.toMatch(MODEL_WORDS)

    const pro = screen.getByRole('radio', { name: /Pro/ })
    await waitFor(() => expect(pro.getAttribute('data-state')).toBe('available'))
    fireEvent.click(pro)

    // The advanced editor below the fold loads the profile but mounts no
    // model picker, and its late load does not undo the tier just picked.
    fireEvent.click(screen.getByRole('button', { name: 'Advanced — skills, toolsets, SOUL.md' }))
    await waitFor(() => expect(calls('mcp.catalog').length).toBeGreaterThan(0))
    await act(async () => undefined)
    expect(calls('model.options')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /Save|保存/ }))

    await waitFor(() => expect(calls('profiles.configure')).toHaveLength(1))
    expect(calls('profiles.configure')[0][1]).toEqual({ model: 'apex-pro', name: 'script-writer', provider: RELAY })
  })

  it('writes nothing when the tier did not change', async () => {
    const { EditProfileDialog } = await import('./edit-profile-dialog')

    render(withQueryClient(<EditProfileDialog bot={bot} onClose={() => undefined} open />))

    await screen.findByRole('radio', { name: /Flash/ })
    fireEvent.click(screen.getByRole('button', { name: /Save|保存/ }))

    await waitFor(() => expect(mocks.saveBotMeta).toHaveBeenCalled())
    expect(calls('profiles.configure')).toHaveLength(0)
  })
})
