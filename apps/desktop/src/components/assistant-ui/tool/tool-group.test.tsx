import { type ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'

import { $displayTimestamps } from '@/store/display-timestamps'
import { clearAllPrompts, setApprovalRequest } from '@/store/prompts'
import { $activeSessionId } from '@/store/session'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '../test-utils'
import { Thread } from '../thread'
import { formatTimelineRange } from '../thread/timestamp'

// Timeline timestamps render only when `display.timestamps` is enabled.
$displayTimestamps.set(true)

// A turn's tool calls fold into one process line (hc-973). The rule that keeps
// the "approval must never be buried" bug fixed is that an inline ApprovalBar
// for a pending call hangs off that line, not off a row behind a disclosure.
// These cover both halves — the folding itself, and the approval staying in
// the visual flow.

const createdAt = new Date('2026-06-03T00:00:00.000Z')

const resizeObservers = new Set<TestResizeObserver>()

// This suite drives resizes by hand, so it needs observers it can reach.
class TestResizeObserver {
  private target: Element | null = null

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.add(this)
  }

  observe(target: Element) {
    this.target = target
  }

  unobserve() {}

  disconnect() {
    resizeObservers.delete(this)
  }
}

stubThreadEnvironment()
stubThreadViewportSize()
vi.stubGlobal('ResizeObserver', TestResizeObserver)

// A running assistant message with two tools: a completed read_file plus a
// pending terminal (no result), rendered as a flat two-row list.
function groupedPendingMessage(): ThreadMessage {
  return {
    id: 'assistant-group-1',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read-1',
        toolName: 'read_file',
        args: { path: '/etc/hosts' },
        argsText: JSON.stringify({ path: '/etc/hosts' }),
        result: { content: '127.0.0.1 localhost' }
      },
      {
        type: 'tool-call',
        toolCallId: 'term-1',
        toolName: 'terminal',
        args: { command: 'rm -rf /tmp/x' },
        argsText: JSON.stringify({ command: 'rm -rf /tmp/x' })
      }
    ],
    status: { type: 'running' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as unknown as ThreadMessage
}

function pendingOnlyMessage(): ThreadMessage {
  return {
    id: 'assistant-pending-only',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'term-only',
        toolName: 'terminal',
        args: { command: 'sleep 10' },
        argsText: JSON.stringify({ command: 'sleep 10' })
      }
    ],
    status: { type: 'running' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as unknown as ThreadMessage
}

function completedOnlyMessage(): ThreadMessage {
  return {
    id: 'assistant-completed-only',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read-only',
        toolName: 'read_file',
        args: { path: '/etc/hosts' },
        argsText: JSON.stringify({ path: '/etc/hosts' }),
        timestamp: createdAt.getTime() / 1000 + 10.125,
        completedAt: createdAt.getTime() / 1000 + 12.875,
        result: { content: '127.0.0.1 localhost' }
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
  } as unknown as ThreadMessage
}

function failedOnlyMessage(): ThreadMessage {
  return {
    id: 'assistant-failed-only',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'term-failed',
        toolName: 'terminal',
        args: { command: 'exit 1' },
        argsText: JSON.stringify({ command: 'exit 1' }),
        isError: true,
        result: { stderr: 'boom' }
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
  } as unknown as ThreadMessage
}

// Two settled activity calls in a row, so the run earns a summary line and
// collapses behind it.
function settledRunMessage(): ThreadMessage {
  return {
    id: 'assistant-settled-run',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read-2',
        toolName: 'read_file',
        args: { path: '/repo/src/wiring.tsx' },
        argsText: JSON.stringify({ path: '/repo/src/wiring.tsx' }),
        timestamp: createdAt.getTime() / 1000 + 20,
        completedAt: createdAt.getTime() / 1000 + 21,
        result: { content: 'export const Wiring = () => null' }
      },
      {
        type: 'tool-call',
        toolCallId: 'term-3',
        toolName: 'terminal',
        args: { command: 'ls -la' },
        argsText: JSON.stringify({ command: 'ls -la' }),
        timestamp: createdAt.getTime() / 1000 + 22,
        completedAt: createdAt.getTime() / 1000 + 23.5,
        result: { exit_code: 0, stdout: 'wiring.tsx' }
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
  } as unknown as ThreadMessage
}

// Activity, an edit, then more activity — all adjacent, so assistant-ui hands
// the whole stretch over as one group. The edit is the deliverable and has to
// survive that as its own card.
function editBetweenRunsMessage(): ThreadMessage {
  return {
    id: 'assistant-edit-between-runs',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read-5',
        toolName: 'read_file',
        args: { path: '/repo/src/a.ts' },
        argsText: JSON.stringify({ path: '/repo/src/a.ts' }),
        result: { content: 'a' }
      },
      {
        type: 'tool-call',
        toolCallId: 'search-3',
        toolName: 'search_files',
        args: { query: 'toolRuns' },
        argsText: JSON.stringify({ query: 'toolRuns' }),
        result: { hits: [] }
      },
      {
        type: 'tool-call',
        toolCallId: 'patch-2',
        toolName: 'patch',
        args: { path: '/repo/src/wiring.tsx' },
        argsText: JSON.stringify({ path: '/repo/src/wiring.tsx' }),
        result: { path: '/repo/src/wiring.tsx', inline_diff: '--- a\n+++ b\n+added line\n-removed line' }
      },
      {
        type: 'tool-call',
        toolCallId: 'read-6',
        toolName: 'read_file',
        args: { path: '/repo/src/b.ts' },
        argsText: JSON.stringify({ path: '/repo/src/b.ts' }),
        result: { content: 'b' }
      },
      {
        type: 'tool-call',
        toolCallId: 'term-4',
        toolName: 'terminal',
        args: { command: 'ls' },
        argsText: JSON.stringify({ command: 'ls' }),
        result: { exit_code: 0 }
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
  } as unknown as ThreadMessage
}

// A finished turn that left a call without a result — interrupted, or the
// result landed elsewhere. The run is history and has to behave like it.
function abandonedRunMessage(): ThreadMessage {
  return {
    id: 'assistant-abandoned-run',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read-3',
        toolName: 'read_file',
        args: { path: '/repo/src/status.tsx' },
        argsText: JSON.stringify({ path: '/repo/src/status.tsx' }),
        result: { content: 'export const Status = () => null' }
      },
      {
        type: 'tool-call',
        toolCallId: 'search-1',
        toolName: 'search_files',
        args: { query: 'toolRuns' },
        argsText: JSON.stringify({ query: 'toolRuns' })
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
  } as unknown as ThreadMessage
}

// The gap between one sequential call finishing and the next arriving: the
// turn is still running, the run is still the tail, but for this instant every
// call has a result.
function betweenSequentialCallsMessage(): ThreadMessage {
  return {
    id: 'assistant-between-calls',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'term-a',
        toolName: 'terminal',
        args: { command: 'sleep 2; echo alpha' },
        argsText: JSON.stringify({ command: 'sleep 2; echo alpha' }),
        result: { exit_code: 0, stdout: 'alpha' }
      },
      {
        type: 'tool-call',
        toolCallId: 'term-b',
        toolName: 'terminal',
        args: { command: 'sleep 2; echo bravo' },
        argsText: JSON.stringify({ command: 'sleep 2; echo bravo' }),
        result: { exit_code: 0, stdout: 'bravo' }
      }
    ],
    status: { type: 'running' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as unknown as ThreadMessage
}

// Still streaming, but the agent has moved past its first run and left both of
// its calls unresolved. Only the run at the tail is still live.
function movedOnMessage(): ThreadMessage {
  return {
    id: 'assistant-moved-on',
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read-4',
        toolName: 'read_file',
        args: { path: '/repo/src/status.tsx' },
        argsText: JSON.stringify({ path: '/repo/src/status.tsx' })
      },
      {
        type: 'tool-call',
        toolCallId: 'search-2',
        toolName: 'search_files',
        args: { query: 'toolRuns' },
        argsText: JSON.stringify({ query: 'toolRuns' })
      },
      { type: 'text', text: 'Let me read the rest of the file.' },
      {
        type: 'tool-call',
        toolCallId: 'term-2',
        toolName: 'terminal',
        args: { command: 'ls' },
        argsText: JSON.stringify({ command: 'ls' })
      }
    ],
    status: { type: 'running' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as unknown as ThreadMessage
}

const GroupHarness = ({ message }: { message: ThreadMessage }) => (
  <ThreadRuntime messages={[message]}>
    <Thread />
  </ThreadRuntime>
)

const status = (container: HTMLElement) => container.querySelector('[data-process-status]')

beforeEach(() => {
  clearAllPrompts()
  setToolViewMode('product')
  $activeSessionId.set('sess-1')
  $toolDisclosureStates.set({})
  clearDismissedToolRows()
})

afterEach(() => {
  cleanup()
  clearAllPrompts()
  setToolViewMode('product')
  $activeSessionId.set(null)
  clearDismissedToolRows()
})

// hc-973: a turn's tool activity is one process line — the steps done, or the
// one in progress — and its rows live behind developer mode.
describe('settled turn', () => {
  it('collapses to one line naming the steps', async () => {
    const { container } = render(<GroupHarness message={settledRunMessage()} />)

    await waitFor(() => expect(status(container)?.textContent).toContain('Read file → Work on your computer'))
    expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-process-step]')).toHaveLength(0)
  })

  it('opens onto its steps when asked', async () => {
    const { container } = render(<GroupHarness message={settledRunMessage()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Show steps' }))

    await waitFor(() => expect(container.querySelectorAll('[data-process-step]')).toHaveLength(2))
    expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(0)
  })

  it('reads a lone call as a one-step line', async () => {
    const { container } = render(<GroupHarness message={completedOnlyMessage()} />)

    await waitFor(() => expect(status(container)?.textContent).toContain('Read file'))
    expect(container.querySelectorAll('[data-process-block]')).toHaveLength(1)
  })
})

// A diff is what the user reviews, so it is never what gets folded away. It
// stays on screen at the point in the turn where it happened; the activity
// either side of it is one process line, after the last of it.
describe('a file edit among ordinary activity', () => {
  it('stays in place while the activity around it folds into one line', async () => {
    const { container } = render(<GroupHarness message={editBetweenRunsMessage()} />)

    await waitFor(() => expect(status(container)).not.toBeNull())

    const shape = [...container.querySelectorAll('[data-process-block],[data-tool-row]')].map(node =>
      node.hasAttribute('data-process-block') ? 'process' : 'row'
    )

    expect(shape).toEqual(['row', 'process'])
    // Five steps, so the chain is cut short — the edit among them.
    expect(status(container)?.textContent).toContain(
      'Read file → Search files → Edit file → … → Work on your computer 5 steps in all'
    )
  })

  it('keeps the diff itself on screen rather than behind the process line', async () => {
    const { container } = render(<GroupHarness message={editBetweenRunsMessage()} />)

    await waitFor(() => {
      expect(container.querySelector('[data-tool-row][data-file-edit]')).not.toBeNull()
    })
  })
})

// The transcript rests its scaffolding at a fade, keyed off one attribute. A
// surface that renders without it is brighter than everything around it, which
// is how two adjacent, identical rows came to sit at two opacities.
describe('transcript fade', () => {
  it('marks every row and the process block as scaffolding', async () => {
    const { container } = render(<GroupHarness message={editBetweenRunsMessage()} />)

    await waitFor(() => expect(status(container)).not.toBeNull())

    const unmarked = [...container.querySelectorAll('[data-process-block],[data-tool-row]')].filter(
      node => !node.hasAttribute('data-conversation-scaffold')
    )

    expect(unmarked).toHaveLength(0)
  })
})

describe('live turn', () => {
  it('names only the step in progress', async () => {
    const { container } = render(<GroupHarness message={groupedPendingMessage()} />)

    await waitFor(() => expect(status(container)?.getAttribute('data-state')).toBe('running'))
    expect(status(container)?.textContent).toContain('Working on your computer…')
    expect(status(container)?.textContent).toContain('Step 2')
    expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(0)
  })

  it('honors explicit disclosure across live updates and completion', async () => {
    const message = groupedPendingMessage()
    const { container, rerender } = render(<GroupHarness message={message} />)
    const toggle = () => container.querySelector('[data-process-toggle]') as HTMLButtonElement

    await waitFor(() => expect(toggle()).not.toBeNull())
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')

    const next = {
      ...message,
      content: [
        ...message.content,
        {
          type: 'tool-call',
          toolCallId: 'read-next',
          toolName: 'read_file',
          args: { path: '/tmp/next' },
          argsText: '{}'
        }
      ]
    } as ThreadMessage

    rerender(<GroupHarness message={next} />)
    await waitFor(() => expect(container.querySelectorAll('[data-process-step]')).toHaveLength(3))
    rerender(<GroupHarness message={{ ...next, status: { type: 'complete', reason: 'stop' } }} />)
    await waitFor(() => expect(status(container)?.getAttribute('data-state')).not.toBe('running'))
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle())
    expect(container.querySelectorAll('[data-process-step]')).toHaveLength(0)
  })

  it('updates the methods it used when a skill’s name arrives late', async () => {
    const message = groupedPendingMessage()
    const first = { ...message.content[0], toolName: 'skill_view', args: {}, result: { success: true } }

    const { container, rerender } = render(
      <GroupHarness message={{ ...message, content: [first, message.content[1]] } as ThreadMessage} />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Show steps' }))
    expect(container.textContent).not.toContain('Methods used')

    const named = { ...first, args: { name: 'research-notes' } }

    rerender(<GroupHarness message={{ ...message, content: [named, message.content[1]] } as ThreadMessage} />)
    await waitFor(() => expect(container.textContent).toContain('Methods used: research-notes'))
  })

  // Liveness must not need an unresolved call, which is false for the instant
  // between one sequential call finishing and the next arriving — the line
  // would flick to "done" between every command.
  it('stays live in the gap between two sequential calls', async () => {
    const { container } = render(<GroupHarness message={betweenSequentialCallsMessage()} />)

    await waitFor(() => expect(status(container)?.getAttribute('data-state')).toBe('running'))
    expect(container.querySelector('[data-process-toggle]')).not.toBeNull()
  })
})

// A call that never resolved used to read as live forever, stranding the turn
// in the present tense.
describe('tool work left unresolved', () => {
  it('settles with the turn rather than narrating work that stopped', async () => {
    const { container } = render(<GroupHarness message={abandonedRunMessage()} />)

    await waitFor(() => expect(status(container)?.getAttribute('data-state')).toBe('stopped'))
    expect(status(container)?.textContent).toContain('Stopped at Search files')
    expect(container.querySelector('[data-state="running"]')).toBeNull()
  })

  it('settles once the agent moves on, even mid-turn', async () => {
    const { container } = render(<GroupHarness message={movedOnMessage()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Show steps' }))

    await waitFor(() =>
      expect(
        [...container.querySelectorAll('[data-process-step]')].map(step => step.getAttribute('data-state'))
      ).toEqual(['stopped', 'stopped', 'running'])
    )
  })
})

describe('approval surfacing', () => {
  it('renders no inline approval bar when there is no live approval', async () => {
    const { container } = render(<GroupHarness message={groupedPendingMessage()} />)

    await waitFor(() => {
      expect(container.querySelectorAll('[data-slot="tool-block"]').length).toBeGreaterThan(0)
    })
    expect(container.querySelector('[data-slot="tool-approval-inline"]')).toBeNull()
  })

  it('surfaces the approval inline under the process line, never under a hidden ancestor', async () => {
    setApprovalRequest({ command: 'rm -rf /tmp/x', description: 'dangerous command', sessionId: 'sess-1' })

    const { container } = render(<GroupHarness message={groupedPendingMessage()} />)

    await waitFor(() => {
      const bar = container.querySelector('[data-process-block] [data-slot="tool-approval-inline"]')
      expect(bar).not.toBeNull()
      expect(bar?.closest('[hidden]')).toBeNull()
    })
  })
})

// Developer mode keeps each call's own row under its step: dismissable once
// settled, with the error and the timings it carries.
describe('developer mode rows', () => {
  beforeEach(() => setToolViewMode('technical'))

  it('lets completed tool rows be dismissed', async () => {
    const { container } = render(<GroupHarness message={completedOnlyMessage()} />)

    const dismiss = await screen.findByLabelText('Dismiss')

    expect(container.querySelectorAll('[data-tool-row]').length).toBeGreaterThan(0)

    fireEvent.click(dismiss)

    await waitFor(() => {
      expect(screen.queryByLabelText('Dismiss')).toBeNull()
    })
  })

  it('keeps a dismissed row hidden after a remount (virtualization)', async () => {
    // The thread virtualizes, so a row's component unmounts/remounts as it
    // scrolls. Dismissal must persist across that — component-local state would
    // forget it and the row would pop back. Simulate the remount by unmounting
    // and rendering the same message fresh.
    const first = render(<GroupHarness message={completedOnlyMessage()} />)

    fireEvent.click(await screen.findByLabelText('Dismiss'))

    await waitFor(() => {
      expect(screen.queryByLabelText('Dismiss')).toBeNull()
    })

    first.unmount()

    render(<GroupHarness message={completedOnlyMessage()} />)

    await waitFor(() => {
      expect(screen.queryByLabelText('Dismiss')).toBeNull()
    })
  })

  it('lets failed tool rows be dismissed', async () => {
    render(<GroupHarness message={failedOnlyMessage()} />)

    const dismiss = await screen.findByLabelText('Dismiss')

    fireEvent.click(dismiss)

    await waitFor(() => {
      expect(screen.queryByLabelText('Dismiss')).toBeNull()
    })
  })

  it('does not show dismiss for pending tool rows', async () => {
    const { container } = render(<GroupHarness message={pendingOnlyMessage()} />)

    await waitFor(() => {
      expect(container.querySelectorAll('[data-tool-row]').length).toBeGreaterThan(0)
    })

    expect(screen.queryByLabelText('Dismiss')).toBeNull()
  })

  it('keeps lookup misses neutral and exposes actual failures when expanded', async () => {
    for (const [error, destructive] of [
      ['File not found: /repo/session-view.ts', false],
      ['Permission denied reading /repo/session-view.ts', true]
    ] as const) {
      const message = completedOnlyMessage()

      assert(message.role === 'assistant')

      const part = message.content[0]!

      assert(part.type === 'tool-call')

      const { container, unmount } = render(
        <GroupHarness
          message={{
            ...message,
            content: [{ ...part, result: { error }, args: { path: '/repo/session-view.ts' } }]
          }}
        />
      )

      fireEvent.click(await screen.findByText('Read session-view.ts'))

      await waitFor(() => expect(container.textContent).toContain(error))
      expect(Boolean(container.querySelector('[data-tool-row] .text-destructive'))).toBe(destructive)
      unmount()
      $toolDisclosureStates.set({})
    }
  })
})

describe('tool lifecycle timestamps', () => {
  it('shows the precise call and completion times on a settled turn', async () => {
    const { container } = render(<GroupHarness message={completedOnlyMessage()} />)

    await waitFor(() => expect(status(container)).not.toBeNull())

    const timestamps = Array.from(container.querySelectorAll('[data-slot="timeline-timestamp"]')).map(node =>
      node.textContent?.trim()
    )

    const startedAt = createdAt.getTime() / 1000 + 10.125

    expect(timestamps).toContain(formatTimelineRange(startedAt, createdAt.getTime() / 1000 + 12.875))
  })

  it('shows the full lifecycle range when settled calls are folded', async () => {
    const { container } = render(<GroupHarness message={settledRunMessage()} />)

    await waitFor(() => expect(status(container)).not.toBeNull())

    const timestamps = Array.from(container.querySelectorAll('[data-slot="timeline-timestamp"]')).map(node =>
      node.textContent?.trim()
    )

    expect(timestamps).toContain(
      formatTimelineRange(createdAt.getTime() / 1000 + 20, createdAt.getTime() / 1000 + 23.5)
    )
  })
})
