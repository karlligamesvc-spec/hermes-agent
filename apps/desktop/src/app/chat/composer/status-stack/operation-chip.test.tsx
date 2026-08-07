import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { $activeOperationBySession, clearActiveOperation, setActiveOperation } from '@/store/active-operation'

import { ComposerStatusStack } from './index'

// hc-555 显化 — these assert the chip through the STACK, not the leaf: the
// component itself survived the v0.19.0 rebase, its mount did not, and an
// orphaned chip renders nothing no matter how correct it is.

// The stack measures itself to publish --status-stack-measured-height; jsdom
// has no ResizeObserver.
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
})

function renderStack(onStopOperation?: () => void) {
  return render(
    <MemoryRouter>
      <ComposerStatusStack onStopOperation={onStopOperation} queue={null} sessionId="s1" />
    </MemoryRouter>
  )
}

// The chip's own slot — `role="status"` is shared with the spinner inside it.
const chip = (view: { container: HTMLElement }) =>
  view.container.querySelector<HTMLElement>('[data-slot="operation-chip"]')

const browserOperation = {
  action: 'navigate',
  surface: 'browser' as const,
  target: 'example.com',
  toolCallId: 'call-1',
  toolName: 'browser_navigate'
}

afterEach(() => {
  cleanup()
  $activeOperationBySession.set({})
})

describe('ComposerStatusStack operation chip', () => {
  it('renders nothing while no surface is being driven', () => {
    const { container } = renderStack()

    expect(container.firstChild).toBeNull()
  })

  it('opens the stack for a live operation even with no other status to show', () => {
    setActiveOperation('s1', browserOperation)
    const view = renderStack()

    expect(chip(view)).not.toBeNull()
    expect(screen.getByText('example.com')).toBeTruthy()
  })

  it('warns louder for the real desktop than for a headless page', () => {
    setActiveOperation('s1', { ...browserOperation, surface: 'computer', toolName: 'computer_use' })
    const view = renderStack()

    expect(chip(view)?.dataset.surface).toBe('computer')
  })

  it('wires Stop to the turn interrupt — the only cancel the runtime exposes', () => {
    const onStop = vi.fn()
    setActiveOperation('s1', browserOperation)
    renderStack(onStop)

    fireEvent.click(screen.getAllByRole('button', { name: /stop/i })[0])

    expect(onStop).toHaveBeenCalledOnce()
  })

  it('closes the stack again once the operation clears', () => {
    setActiveOperation('s1', browserOperation)
    const { container } = renderStack()

    expect(container.firstChild).not.toBeNull()

    act(() => clearActiveOperation('s1', 'call-1'))

    expect(container.firstChild).toBeNull()
  })
})
