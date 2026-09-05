import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { onComposerSubmitRequest } from '@/app/chat/composer/focus'
import { $gatewayState } from '@/store/session'

import { Thread } from '.'

// hc-575's generation-ladder cards are a platform feature with no upstream
// counterpart: `gen_ladder` tool results carry a `gen-ladder/1` card that the
// desktop draws inline, and every control tap goes back to the agent as a fresh
// user turn. Upstream's ChainToolFallback has no such branch, so a `gen_ladder`
// part would fall through to the generic tool row — a JSON blob where a card
// with priced buttons belongs. hc-590 retired the monolith that owned this
// branch; these pin it in the tree that replaced it.

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

function stubOffsetDimension(
  prop: 'offsetHeight' | 'offsetWidth',
  clientProp: 'clientHeight' | 'clientWidth',
  fallback: number
) {
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)

  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get() {
      return previous?.get?.call(this) || (this as HTMLElement)[clientProp] || fallback
    }
  })
}

stubOffsetDimension('offsetWidth', 'clientWidth', 800)
stubOffsetDimension('offsetHeight', 'clientHeight', 600)

// A `gen-ladder/1` envelope exactly as the platform tool returns it: the card
// under `card`, plus the agent-private fields the render layer must ignore.
function genLadderResult() {
  return {
    directive: 'wait for the user to confirm before spending',
    internal: { ledger_ref: 'must-not-render' },
    card: {
      protocol_version: 'gen-ladder/1',
      type: 'draft_gate',
      stage: 'prompt',
      modality: 'image',
      language: 'en',
      title: 'Ready to draft',
      ladder: [
        { key: 'prompt', label: 'Prompt', status: 'done' },
        { key: 'draft', label: 'Drafts', status: 'current' }
      ],
      actions: [
        {
          id: 'draft_go',
          label: 'Draft it',
          kind: 'spend',
          target_stage: 'draft',
          price: { display: '¥1.20', amount_cents: 120, currency: 'CNY' }
        }
      ]
    }
  }
}

function toolMessage(toolName: string, result: unknown): ThreadMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName,
        args: {},
        argsText: '{}',
        result
      }
    ],
    status: { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as ThreadMessage
}

function Harness({ result, toolName = 'gen_ladder' }: { result: unknown; toolName?: string }) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: [toolMessage(toolName, result)],
    isRunning: false,
    onNew: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div data-composer-surface-id="main-test-surface" data-composer-target="main">
        <Thread />
      </div>
    </AssistantRuntimeProvider>
  )
}

beforeEach(() => {
  $gatewayState.set('open')
})

afterEach(() => {
  cleanup()
  $gatewayState.set('idle')
})

describe('gen_ladder tool part', () => {
  it('draws the card instead of the generic tool row', async () => {
    const { container } = render(<Harness result={genLadderResult()} />)

    expect(await screen.findByText('Ready to draft')).toBeTruthy()
    expect(container.querySelector('[data-slot="gen-ladder-card"]')).not.toBeNull()
    expect(
      container.querySelector('[data-tool-row]'),
      'gen_ladder fell through to the generic tool fallback — the card branch is gone'
    ).toBeNull()
  })

  it('never surfaces the agent-private envelope fields', async () => {
    const { container } = render(<Harness result={genLadderResult()} />)

    await screen.findByText('Ready to draft')

    expect(container.textContent).not.toContain('must-not-render')
    expect(container.textContent).not.toContain('wait for the user to confirm')
  })

  it('forwards a priced tap to the composer as a user turn', async () => {
    const submitted: string[] = []
    const unsubscribe = onComposerSubmitRequest(detail => submitted.push(detail.text))

    render(<Harness result={genLadderResult()} />)

    fireEvent.click(await screen.findByRole('button', { name: /Draft it/ }))

    // The bus defers to a macrotask so the click handler finishes first.
    await waitFor(() => expect(submitted).toEqual(['Confirm: Draft it']))

    unsubscribe()
  })

  it('locks the card while the gateway is down, so a priced button cannot fire', async () => {
    $gatewayState.set('connecting')

    const submitted: string[] = []
    const unsubscribe = onComposerSubmitRequest(detail => submitted.push(detail.text))

    render(<Harness result={genLadderResult()} />)

    fireEvent.click(await screen.findByRole('button', { name: /Draft it/ }))
    await new Promise(resolve => window.setTimeout(resolve, 0))

    expect(submitted).toEqual([])

    unsubscribe()
  })

  it('renders nothing when the result carries no card', async () => {
    const { container } = render(<Harness result={{ ok: true }} />)

    await waitFor(() => expect(container.querySelector('[data-slot="aui_thread-viewport"]')).not.toBeNull())

    expect(container.querySelector('[data-slot="gen-ladder-card"]')).toBeNull()
    expect(container.querySelector('[data-tool-row]')).toBeNull()
  })
})
