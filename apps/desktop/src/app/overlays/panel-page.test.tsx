import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PanelPage } from './panel'

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
})
