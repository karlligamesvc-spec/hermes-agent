/**
 * hc-1060 identity guard (hard rule 11): the composer states the prototype v2
 * composer changes, recorded with `desktop_features.single_thread` off before
 * any hc-1060 code was written. src/single-thread-identity.test.tsx already
 * pins the idle composer row; these add the states hc-1060 reaches into: a
 * running turn (the Stop button), a typed draft (Send) and both at once, the
 * row in developer mode, the "+" menu's 高级 fold, and the shortcut table
 * (⌘D is the default-profile chord).
 *
 * With the switch off nothing here may move by one byte, and with the switch
 * on, developer mode renders against the same developer-mode goldens. A diff
 * means the off path moved: fix the code, do not re-record the golden unless
 * the change is meant to reach every user.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatBar } from '@/app/chat/composer'
import { RICH_INPUT_SLOT } from '@/app/chat/composer/rich-editor'
import type { ChatBarState } from '@/app/chat/composer/types'
import { stubThreadEnvironment, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { allKeybindActions } from '@/lib/keybinds/actions'
import { $authState } from '@/store/auth'
import { clearSessionDraft, mainComposerScope } from '@/store/composer'
import { $comboIndex } from '@/store/keybinds'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { $singleThreadFlag } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getSkills: vi.fn(async () => []),
  getMoaModels: vi.fn(async () => null)
}))

stubThreadEnvironment()

const GOLDEN = './__identity__/single-thread-composer'

const STATE: ChatBarState = {
  model: { canSwitch: true, model: 'apex-flash', provider: 'custom' },
  tools: { enabled: true, label: 'Add context' },
  voice: { enabled: true, active: false }
}

/** React's generated ids differ by render order, and the composer draws its
 *  placeholder from a rotating set; neither is what the guard is about. */
function normalized(html: string): string {
  return html
    .replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
    .replace(/data-placeholder="[^"]*"/g, 'data-placeholder="«rotating»"')
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 40))
  })

async function renderComposer(busy: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <ThreadRuntime messages={[]}>
            <ChatBar
              busy={busy}
              disabled={false}
              onCancel={() => {}}
              onPickFiles={() => {}}
              onPickFolders={() => {}}
              onPickImages={() => {}}
              onSteer={async () => true}
              onSubmit={async () => true}
              state={STATE}
            />
          </ThreadRuntime>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )

  await settle()

  return view.container
}

async function typeDraft(container: HTMLElement, text: string) {
  const editor = container.querySelector<HTMLElement>(`[data-slot="${RICH_INPUT_SLOT}"]`)!

  editor.append(window.document.createTextNode(text))
  fireEvent.input(editor)
  await settle()
}

async function composerRow(busy: boolean, draft?: string): Promise<string> {
  const container = await renderComposer(busy)

  if (draft) {
    await typeDraft(container, draft)
  }

  const form = container.querySelector('form')

  expect(form).not.toBeNull()

  return normalized(form!.outerHTML)
}

/** The "+" menu with its 高级 fold opened: every menu Radix has portalled out. */
async function advancedMenu(): Promise<string> {
  await renderComposer(false)

  const trigger = screen.getByRole('button', { name: '添加图片、文件和更多' })

  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)

  const row = await screen.findByRole('menuitem', { name: /^高级/ })

  row.focus()
  fireEvent.keyDown(row, { key: 'ArrowRight' })
  await settle()

  return normalized(
    [
      ...window.document.querySelectorAll(
        '[data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"]'
      )
    ]
      .map(node => node.outerHTML)
      .join('\n')
  )
}

/** The shortcut table as dispatch sees it: every action's defaults, and who owns ⌘D. */
function keybindTable(): string {
  return JSON.stringify(
    {
      actions: allKeybindActions().map(action => [action.id, action.category, action.defaults]),
      modD: $comboIndex.get().get('mod+d') ?? null
    },
    null,
    2
  )
}

function signInApexAccount() {
  $authState.set({
    ...$authState.get(),
    enabled: true,
    gateReason: null,
    modelTierMax: false,
    modelTiers: false,
    status: 'signed-in'
  })
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setToolViewMode('product')
  $activeSessionId.set('session-identity')
  $gatewayState.set('open')
  clearSessionDraft(null)
  signInApexAccount()
})

afterEach(() => {
  cleanup()
  mainComposerScope.clear()
  clearSessionDraft(null)
  $singleThreadFlag.set(false)
  setRuntimeI18nLocale('en')
  setToolViewMode('product')
  $activeSessionId.set(null)
})

const ROWS: [string, boolean, string | undefined][] = [
  ['busy', true, undefined],
  ['typed', false, '顺便起 3 个标题'],
  ['busy-typed', true, '顺便起 3 个标题']
]

describe('single_thread off: the composer states hc-1060 touches are unchanged', () => {
  it.each(ROWS)('the %s composer row', async (name, busy, draft) => {
    await expect(await composerRow(busy, draft)).toMatchFileSnapshot(`${GOLDEN}/composer-${name}.html`)
  })

  it('the "+" menu with 高级 open', async () => {
    await expect(await advancedMenu()).toMatchFileSnapshot(`${GOLDEN}/plus-menu-advanced.html`)
  })

  it('the shortcut table', async () => {
    await expect(keybindTable()).toMatchFileSnapshot(`${GOLDEN}/keybinds.json`)
  })
})

describe('developer mode is the composer it was, with the switch off or on', () => {
  it.each([false, true])('switch on: %s', async on => {
    $singleThreadFlag.set(on)
    setToolViewMode('technical')

    await expect(await composerRow(false)).toMatchFileSnapshot(`${GOLDEN}/developer-idle.html`)
  })

  it.each([false, true])('switch on: %s, a running turn with a draft', async on => {
    $singleThreadFlag.set(on)
    setToolViewMode('technical')

    await expect(await composerRow(true, '顺便起 3 个标题')).toMatchFileSnapshot(`${GOLDEN}/developer-busy-typed.html`)
  })

  it.each([false, true])('switch on: %s, the "+" menu', async on => {
    $singleThreadFlag.set(on)
    setToolViewMode('technical')
    await renderComposer(false)

    const trigger = screen.getByRole('button', { name: '添加图片、文件和更多' })

    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
    fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 })
    fireEvent.click(trigger)
    await screen.findAllByRole('menuitem')
    await settle()

    const menu = normalized(window.document.querySelector('[data-slot="dropdown-menu-content"]')!.outerHTML)

    await expect(menu).toMatchFileSnapshot(`${GOLDEN}/developer-plus-menu.html`)
  })

  it.each([false, true])('switch on: %s, the shortcut table', async on => {
    $singleThreadFlag.set(on)
    setToolViewMode('technical')
    await renderComposer(false)

    await expect(keybindTable()).toMatchFileSnapshot(`${GOLDEN}/keybinds.json`)
  })
})
