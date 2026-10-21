/**
 * hc-1015 identity guard (hard rule 11): with `desktop_features.single_thread`
 * off, the chat looks exactly as it did before the switch existed.
 *
 * The goldens under `__identity__/single-thread/` were recorded on fork main
 * 4ee99a81d6, before any single-thread code was written, and the switch must
 * not change one byte of them: the message area of a finished, a running, a
 * stuck and a tool-less turn (Chinese, product and developer mode), the
 * process steps opened, and the composer row with its "+" menu. A diff here
 * means the off path moved: fix the code, do not re-record the golden unless
 * the change is meant to reach every user.
 */
import { type ThreadMessage } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatBar } from '@/app/chat/composer'
import type { ChatBarState } from '@/app/chat/composer/types'
import { createdAt, stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { clearSessionDraft } from '@/store/composer'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'
import { remixFailedTurn, remixLiveTurn, remixRunningTurn } from '@/test/remix-turn'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getSkills: vi.fn(async () => []),
  getMoaModels: vi.fn(async () => null)
}))

stubThreadEnvironment()
stubThreadViewportSize()

const GOLDEN = './__identity__/single-thread'

const STATE: ChatBarState = {
  model: { canSwitch: true, model: 'apex-flash', provider: 'custom' },
  tools: { enabled: true, label: 'Add context' },
  voice: { enabled: true, active: false }
}

/** A turn that only thought, then answered: no tool work at all. */
function thoughtTurn(): ThreadMessage[] {
  const T0 = Date.UTC(2026, 9, 18, 10, 0, 0) / 1000

  return [
    {
      id: 'thought-ask',
      role: 'user',
      content: [{ type: 'text', text: '给我起 3 个标题' }],
      attachments: [],
      createdAt,
      metadata: { custom: {} }
    } as ThreadMessage,
    {
      id: 'thought-answer',
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '先想想这条的卖点。', timestamp: T0, completedAt: T0 + 6 },
        { type: 'text', text: '1. 9.9 元的收纳，我只留了这 3 样\n2. 别再买贵的收纳盒了\n3. 租房党 9.9 元改造衣柜' }
      ],
      status: { type: 'complete', reason: 'stop' },
      createdAt,
      metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: { durationS: 9 } }
    } as unknown as ThreadMessage
  ]
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
    await new Promise(resolve => setTimeout(resolve, 30))
  })

async function renderThread(messages: ThreadMessage[]) {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )

  await waitFor(() => expect(view.container.querySelector('[data-role="assistant"]')).not.toBeNull())
  await settle()

  return view.container
}

/** Every assistant row of the transcript, in order. */
function messageArea(container: HTMLElement): string {
  return normalized(
    [...container.querySelectorAll('[data-slot="aui_assistant-message-root"]')].map(node => node.outerHTML).join('\n')
  )
}

async function renderComposer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const view = render(
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

  return view.container
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

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setToolViewMode('product')
  $activeSessionId.set('session-identity')
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
  clearDismissedToolRows()
  clearSessionDraft(null)
  signInApexAccount()
})

afterEach(() => {
  cleanup()
  setRuntimeI18nLocale('en')
  setToolViewMode('product')
  $activeSessionId.set(null)
  $toolDisclosureStates.set({})
})

describe('single_thread off: the message area is unchanged', () => {
  it.each([
    ['finished', remixLiveTurn],
    ['running', remixRunningTurn],
    ['stuck', remixFailedTurn],
    ['thought-only', thoughtTurn]
  ])('a %s turn', async (name, turn) => {
    const container = await renderThread(turn())

    await expect(messageArea(container)).toMatchFileSnapshot(`${GOLDEN}/thread-${name}.html`)
  })

  it('a finished turn with its steps and thoughts opened', async () => {
    const container = await renderThread(remixLiveTurn())

    fireEvent.click(await screen.findByRole('button', { name: '看步骤' }))
    fireEvent.click(screen.getByRole('button', { name: /想了|想过了/ }))
    await settle()

    await expect(messageArea(container)).toMatchFileSnapshot(`${GOLDEN}/thread-finished-opened.html`)
  })

  it('a finished turn in developer mode', async () => {
    setToolViewMode('technical')

    const container = await renderThread(remixLiveTurn())

    await expect(messageArea(container)).toMatchFileSnapshot(`${GOLDEN}/thread-finished-developer.html`)
  })
})

describe('single_thread off: the composer is unchanged', () => {
  it('the composer row on an APEX account', async () => {
    const container = await renderComposer()
    const form = container.querySelector('form')

    expect(form).not.toBeNull()
    await expect(normalized(form!.outerHTML)).toMatchFileSnapshot(`${GOLDEN}/composer-row.html`)
  })
})
