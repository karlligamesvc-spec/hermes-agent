import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CronResult } from '@/lib/chat-messages/cron-result'

import { stubThreadEnvironment } from '../test-utils'

import { Thread } from '.'

const openSession = vi.fn()

vi.mock('@/app/open-session', () => ({ openSession: (...args: unknown[]) => openSession(...args) }))

stubThreadEnvironment()

const RESULT = 'Silver Lake and PIF offer $25B for **Unity** (Reuters)'

function Harness({ cronResult }: { cronResult: CronResult }) {
  const message = {
    id: 'cron-1',
    role: 'system',
    content: [{ type: 'text', text: 'Scheduled job "Tech news" result' }],
    createdAt: new Date('2026-11-08T17:35:27Z'),
    metadata: { custom: { cronResult } }
  } as unknown as ThreadMessage

  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages: [message],
    isRunning: false,
    onNew: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  )
}

afterEach(() => {
  cleanup()
  openSession.mockReset()
})

describe('scheduled job result card', () => {
  it('shows the result in full without a click, under its job', () => {
    const { container } = render(
      <Harness cronResult={{ jobName: 'Tech news', failed: false, text: RESULT, runSessionId: 'cron_5270_1' }} />
    )

    const card = container.querySelector('[data-cron-result="ok"]')

    expect(card?.textContent).toContain('Scheduled job "Tech news" result')
    expect(card?.querySelector('[data-cron-result-text]')?.textContent).toContain(
      'Silver Lake and PIF offer $25B for Unity'
    )
    expect(container.querySelector('[data-role="user"]')).toBeNull()
  })

  it('opens the run that produced it', async () => {
    const { getByRole } = render(
      <Harness cronResult={{ jobName: 'Tech news', failed: false, text: RESULT, runSessionId: 'cron_5270_1' }} />
    )

    fireEvent.click(getByRole('button', { name: 'View this run' }))

    await waitFor(() => expect(openSession).toHaveBeenCalledWith('cron_5270_1', expect.any(Function), 'tab'))
  })

  it('has no button when the run left no conversation (a script-only job)', () => {
    const { container, queryByRole } = render(<Harness cronResult={{ jobName: 'Ping', failed: false, text: 'pong' }} />)

    expect(queryByRole('button', { name: 'View this run' })).toBeNull()
    expect(container.textContent).toContain('pong')
  })

  it('marks a failed run', () => {
    const { container } = render(
      <Harness cronResult={{ jobName: 'Tech news', failed: true, text: 'model unreachable' }} />
    )

    expect(container.querySelector('[data-cron-result="failed"]')?.textContent).toContain('model unreachable')
  })
})
