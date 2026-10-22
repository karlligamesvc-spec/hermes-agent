/**
 * hc-1015 on the real chat composer: with `desktop_features.single_thread` on,
 * an APEX account picks no model, no reasoning level, no scenario and no
 * approval mode in the composer (Kael 2026-10-21, decision 5: tiers are not
 * shown; the platform routes). The user's-own-key path keeps its model pill,
 * as in hc-960 tier mode, and developer mode keeps every control. The flag-off
 * composer is pinned byte for byte in src/single-thread-identity.test.tsx.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { clearSessionDraft, mainComposerScope } from '@/store/composer'
import { $singleThreadFlag } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import type { ChatBarState } from './types'

import { ChatBar } from '.'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getSkills: vi.fn(async () => []),
  getMoaModels: vi.fn(async () => null)
}))

const STATE: ChatBarState = {
  model: { canSwitch: true, model: 'apex-flash', provider: 'custom' },
  tools: { enabled: true, label: 'Add context' },
  voice: { enabled: true, active: false }
}

function signIn(managed: boolean) {
  $authState.set({
    ...$authState.get(),
    enabled: managed,
    gateReason: null,
    modelTierMax: false,
    modelTiers: false,
    status: managed ? 'signed-in' : 'signed-out'
  })
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

async function renderChatBar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <ThreadRuntime messages={[]}>
            <ChatBar
              busy={false}
              disabled={false}
              onCancel={() => {}}
              onPickFiles={() => {}}
              onPickFolders={() => {}}
              onPickImages={() => {}}
              onSubmit={async () => true}
              state={STATE}
            />
          </ThreadRuntime>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )

  await settle()
}

const toolbarButtons = () =>
  within(window.document.querySelector('[data-slot="composer-layout"]') as HTMLElement)
    .queryAllByRole('button')
    .map(button => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '')

function openPlusMenu() {
  const trigger = screen.getByRole('button', { name: '添加图片、文件和更多' })

  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
}

async function openSubmenu(name: string) {
  const row = await screen.findByRole('menuitem', { name: new RegExp(`^${name}`) })

  row.focus()
  fireEvent.keyDown(row, { key: 'ArrowRight' })
  await settle()
}

const rowNames = () => screen.queryAllByRole('menuitem').map(item => item.textContent?.trim() ?? '')

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

beforeEach(() => {
  stubThreadEnvironment()
  setRuntimeI18nLocale('zh')
  setToolViewMode('product')
  $singleThreadFlag.set(true)
  signIn(true)
})

afterEach(() => {
  cleanup()
  mainComposerScope.clear()
  clearSessionDraft(null)
  $singleThreadFlag.set(false)
  setToolViewMode('product')
  setRuntimeI18nLocale('en')
  vi.unstubAllGlobals()
})

describe('single_thread on, APEX account', () => {
  it('shows attach, voice and send — no model pill', async () => {
    await renderChatBar()

    expect(toolbarButtons()).toEqual(['添加图片、文件和更多', '开始语音对话', '发送'])
  })

  it('keeps 高级 without 场景 or 审批方式, and the generation rows without a model picker', async () => {
    await renderChatBar()
    openPlusMenu()

    for (const name of ['图片', '视频']) {
      const row = screen.getByRole('menuitem', { name: new RegExp(`^${name}`) })

      // A plain row (the default model), not a submenu of models.
      expect(row.getAttribute('aria-haspopup')).toBeNull()
    }

    await openSubmenu('高级')

    expect(await screen.findByRole('menuitem', { name: /^语音设置/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /^已启用技能/ })).toBeTruthy()
    expect(rowNames()).not.toContain('场景…')
    expect(rowNames().some(name => name.startsWith('审批方式'))).toBe(false)
  })
})

describe('single_thread on, the user’s own key', () => {
  it('keeps the model pill: their model is theirs to pick', async () => {
    signIn(false)
    await renderChatBar()

    expect(toolbarButtons()).toContain('打开模型选择器')
  })
})

describe('single_thread on, developer mode', () => {
  it('keeps the model pill and the inline scenario and approval pills', async () => {
    setToolViewMode('technical')
    await renderChatBar()

    expect(toolbarButtons()).toContain('打开模型选择器')
    expect(window.document.querySelector('[data-slot="composer-toolbar-start"]')?.textContent).toMatch(/审批/)
  })
})
