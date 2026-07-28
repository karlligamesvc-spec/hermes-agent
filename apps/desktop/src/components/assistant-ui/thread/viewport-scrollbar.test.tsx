import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Thread } from '.'

// Kael, hc-590 review: the centre column scrolls but never shows a bar — the
// zero state AND the live conversation. The zero state's own scroller is
// covered in empty-state.test.tsx; this is the session message viewport, the
// element use-stick-to-bottom owns.
//
// Two halves, and both matter: the bar must be hidden on every engine (each
// vendor prefix is a separate switch — drop one and only that platform
// regresses, which nobody running the other two would ever notice), and the
// container must still SCROLL. Reaching for `overflow-hidden` would also hide
// the bar, and would strand every message above the fold.

const createdAt = new Date('2026-07-28T00:00:00.000Z')

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

function userMessage(id: string): ThreadMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    attachments: [],
    createdAt,
    metadata: { custom: {} }
  } as ThreadMessage
}

function renderSessionThread() {
  function Harness() {
    const runtime = useExternalStoreRuntime<ThreadMessage>({
      messages: [userMessage('u1'), userMessage('u2')],
      isRunning: false,
      onNew: async () => {}
    })

    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread />
      </AssistantRuntimeProvider>
    )
  }

  return render(<Harness />)
}

afterEach(cleanup)

describe('session message viewport', () => {
  it('hides its scrollbar on every engine', () => {
    const { container } = renderSessionThread()
    const viewport = container.querySelector('[data-slot="aui_thread-viewport"]')

    expect(viewport, 'the session scroll container moved — re-point this guard at it').not.toBeNull()

    for (const idiom of ['[-ms-overflow-style:none]', '[scrollbar-width:none]', '[&::-webkit-scrollbar]:hidden']) {
      expect(
        viewport?.className,
        `${idiom} is gone — the conversation scrollbar comes back on that engine only`
      ).toContain(idiom)
    }
  })

  it('still scrolls with the bar hidden', () => {
    const { container } = renderSessionThread()
    const viewport = container.querySelector('[data-slot="aui_thread-viewport"]')

    expect(
      viewport?.className,
      'the viewport stopped scrolling — hiding the bar must never turn into clipping the overflow'
    ).toContain('overflow-y-auto')
    expect(viewport?.className).not.toContain('overflow-y-hidden')
  })
})
