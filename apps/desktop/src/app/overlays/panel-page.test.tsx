import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PanelEmpty, PanelHeader, PanelPage, PanelPageBody } from './panel'

describe('PanelPage', () => {
  it('renders durable content without modal, backdrop, or close chrome', () => {
    const { container } = render(
      <PanelPage aria-label="Scheduled jobs" data-cron-surface="page">
        <h1>Scheduled jobs</h1>
      </PanelPage>
    )

    expect(screen.getByRole('region', { name: 'Scheduled jobs' }).getAttribute('data-cron-surface')).toBe('page')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
  })

  it('gives the body and empty state all space remaining below the header', () => {
    const { container } = render(
      <PanelPage aria-label="Scheduled jobs">
        <PanelHeader subtitle="0 jobs" title="Scheduled jobs" />
        <PanelPageBody>
          <PanelEmpty description="Create the first job" title="No scheduled jobs" />
        </PanelPageBody>
      </PanelPage>
    )

    const page = screen.getByRole('region', { name: 'Scheduled jobs' })
    const body = container.querySelector('[data-panel-page-body]')
    const empty = container.querySelector('[data-panel-empty]')

    expect(body).not.toBeNull()
    expect(empty).not.toBeNull()
    expect(body?.parentElement).toBe(page)
    expect(empty?.parentElement).toBe(body)
    expect(body?.className.split(' ')).toEqual(
      expect.arrayContaining(['flex', 'min-h-0', 'min-w-0', 'flex-1', 'flex-col', 'overflow-hidden'])
    )
    expect(empty?.className.split(' ')).toEqual(
      expect.arrayContaining(['grid', 'min-h-0', 'min-w-0', 'w-full', 'flex-1', 'place-items-center'])
    )
  })
})
