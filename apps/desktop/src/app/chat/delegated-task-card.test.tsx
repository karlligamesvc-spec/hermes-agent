// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { DelegatedTaskCard } from './delegated-task-card'

const NOW = 1_700_000_000_000

afterEach(cleanup)

describe('DelegatedTaskCard', () => {
  it('shows the task title and a fresh heartbeat for a running task', () => {
    const { container } = render(
      <DelegatedTaskCard
        heartbeatAt={NOW - 8_000}
        now={NOW}
        status="running"
        target="cloud"
        title="竞品监控 · 抖音店「XX饰品」"
      />
    )

    expect(screen.getByText(/XX饰品/)).toBeTruthy()
    // 8s-ago heartbeat surfaces the elapsed seconds…
    expect(container.textContent).toMatch(/8/)
    // …and a fresh running task reads healthy (good/primary dot, not warn).
    expect(container.querySelector('.bg-primary')).toBeTruthy()
    expect(container.querySelector('.bg-amber-500')).toBeNull()
  })

  it('marks a running task with a cold heartbeat as stale (warn)', () => {
    const { container } = render(
      <DelegatedTaskCard heartbeatAt={NOW - 120_000} now={NOW} status="running" target="cloud" title="stale task" />
    )

    expect(container.querySelector('.bg-amber-500')).toBeTruthy()
  })

  it('uses a bad dot for a failed task regardless of heartbeat', () => {
    const { container } = render(
      <DelegatedTaskCard heartbeatAt={NOW - 1_000} now={NOW} status="failed" target="local" title="failed task" />
    )

    expect(container.querySelector('.bg-destructive')).toBeTruthy()
  })

  it('omits the heartbeat line when no heartbeat is known', () => {
    const { container } = render(<DelegatedTaskCard status="queued" target="cloud" title="queued task" />)
    expect(container.textContent ?? '').not.toMatch(/ago|前|前に/)
  })

  it('renders a source-channel avatar only when a source channel is given', () => {
    // WeChat resolves to a brand glyph (an <svg>); the card otherwise has none.
    const withSource = render(
      <DelegatedTaskCard sourceChannelId="weixin" sourceChannelName="WeChat" status="running" target="local" title="from wechat" />
    )

    expect(withSource.container.querySelector('svg')).toBeTruthy()
    cleanup()

    const noSource = render(<DelegatedTaskCard status="running" target="local" title="no source" />)
    expect(noSource.container.querySelector('svg')).toBeNull()
  })
})
