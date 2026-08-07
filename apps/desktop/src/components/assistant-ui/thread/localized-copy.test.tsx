import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { setSessionCompacting } from '@/store/compaction'
import { $activeSessionId } from '@/store/session'

import { Thread } from '.'

// The thread's meta lines — the steer note, a background process's "output"
// disclosure, the compaction hint, the timeline's accessible name — are written
// in the tree upstream owns, and upstream writes them in English. Ours are
// localized in all four desktop locales, and a hard-coded string here reads as
// an English app to a Chinese user without failing anything else: the surface
// still renders, the tests still pass, only the language is wrong.
//
// hc-589 lost the product's face exactly this way. Behavioral, at zh, because
// that is the default locale.

const createdAt = new Date('2026-07-27T00:00:00.000Z')

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver)
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0)
)
vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
vi.stubGlobal('CSS', { escape: (str: string) => str })

Element.prototype.scrollTo = function scrollTo() {}

function systemMessage(id: string, text: string): ThreadMessage {
  return {
    id,
    role: 'system',
    content: [{ type: 'text', text }],
    createdAt,
    metadata: { custom: {} }
  } as unknown as ThreadMessage
}

function userMessage(id: string, text: string): ThreadMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    attachments: [],
    createdAt,
    metadata: { custom: {} }
  } as ThreadMessage
}

function renderThread(messages: ThreadMessage[], loading?: 'response' | 'session') {
  function Harness() {
    const runtime = useExternalStoreRuntime<ThreadMessage>({
      messages,
      isRunning: loading === 'response',
      onNew: async () => {}
    })

    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread loading={loading} />
      </AssistantRuntimeProvider>
    )
  }

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <Harness />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  setSessionCompacting($activeSessionId.get(), false)
  $activeSessionId.set(null)
})

describe('thread meta lines speak the user language', () => {
  it('labels a steer note in the active locale', async () => {
    renderThread([userMessage('u1', 'hi'), systemMessage('s1', 'steer:改用更短的回答')])

    expect(await screen.findByText('已引导')).toBeTruthy()
    expect(screen.queryByText('steered')).toBeNull()
  })

  it('labels a background process output disclosure in the active locale', async () => {
    renderThread([userMessage('u1', '[IMPORTANT: Background process 42 finished\nnpm run build\ndone]')])

    expect(await screen.findByText('输出')).toBeTruthy()
    expect(screen.queryByText('output')).toBeNull()
  })

  it('names the conversation timeline in the active locale', async () => {
    // MIN_ENTRIES = 4 user turns before the rail appears.
    renderThread(['一', '二', '三', '四', '五'].map((text, i) => userMessage(`u${i}`, text)))

    expect(await screen.findByRole('navigation', { name: '对话时间线' })).toBeTruthy()
  })

  it('announces auto-compaction in the active locale', async () => {
    $activeSessionId.set('sess-1')
    setSessionCompacting('sess-1', true)

    renderThread([userMessage('u1', 'hi')], 'response')

    expect(await screen.findByRole('status', { name: '正在整理对话' })).toBeTruthy()
    expect(screen.queryByText('Summarizing thread')).toBeNull()
  })
})
