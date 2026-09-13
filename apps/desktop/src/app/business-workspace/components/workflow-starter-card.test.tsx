import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BusinessWorkflowStarter } from '../view-model/workflow-starters'

import { WorkflowStarterCard } from './workflow-starter-card'

afterEach(cleanup)

const recommended = [
  ['market-launch', 'assets/workflow-commerce-minimal.png'],
  ['geo-brand-audit', 'assets/workflow-geo-minimal.png'],
  ['content-review', 'assets/workflow-content-minimal.png']
] as const

function starter(id: BusinessWorkflowStarter['id'], recommended = true): BusinessWorkflowStarter {
  return {
    businessPath: id,
    icon: 'globe',
    id,
    prompt: `prompt ${id}`,
    recommended,
    slug: id as BusinessWorkflowStarter['slug'],
    summary: `summary ${id}`,
    title: `title ${id}`,
    version: 1
  }
}

describe('APEX workflow starter artwork', () => {
  it.each(recommended)('maps %s to its approved image asset', (id, asset) => {
    const onSelect = vi.fn()

    const { container } = render(
      <WorkflowStarterCard action="使用" onSelect={onSelect} starter={starter(id)} variant="featured" />
    )

    const image = container.querySelector<HTMLImageElement>(`[data-workflow-artwork="${id}"]`)

    expect(image?.getAttribute('src')).toContain(asset)
    expect(image?.getAttribute('alt')).toBe('')
    expect(image?.getAttribute('width')).toBe('76')
    expect(image?.getAttribute('height')).toBe('76')

    fireEvent.click(screen.getByRole('button', { name: `title ${id} · 使用` }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('keeps the complete title and summary available to the responsive geometry guard', () => {
    const { container } = render(
      <WorkflowStarterCard action="使用" onSelect={vi.fn()} starter={starter('market-launch')} variant="shelf" />
    )

    const card = screen.getByRole('button', { name: 'title market-launch · 使用' })
    const copy = container.querySelector('[data-workflow-card-copy]')
    const title = container.querySelector('[data-workflow-card-title]')
    const summary = container.querySelector('[data-workflow-card-summary]')
    const action = container.querySelector('[data-workflow-card-action]')

    expect(card.classList.contains('gap-2')).toBe(true)
    expect(card.classList.contains('gap-2.5')).toBe(false)
    expect(copy).toBeTruthy()
    expect(copy?.classList.contains('ml-3')).toBe(false)
    expect(title?.textContent).toBe('title market-launch')
    expect(summary?.textContent).toBe('summary market-launch')
    expect(title?.classList.contains('line-clamp-2')).toBe(false)
    expect(summary?.classList.contains('line-clamp-2')).toBe(false)
    expect(action).toBeTruthy()
    expect(action?.classList.contains('ml-2')).toBe(false)
  })

  it('keeps additional real catalog paths compact instead of borrowing featured artwork', () => {
    const { container } = render(
      <WorkflowStarterCard
        action="使用"
        onSelect={vi.fn()}
        starter={starter('competitor-monitoring', false)}
        variant="compact"
      />
    )

    expect(container.querySelector('[data-workflow-artwork]')).toBeNull()
    expect(container.querySelector('.codicon')).toBeTruthy()
  })

  it.each(['featured', 'shelf', 'compact'] as const)(
    'keeps the %s card fully clickable without letting a repeated CTA consume its text column',
    variant => {
      render(
        <WorkflowStarterCard
          action="使用这个工作流"
          onSelect={vi.fn()}
          starter={starter('market-launch')}
          variant={variant}
        />
      )

      const card = screen.getByRole('button', { name: 'title market-launch · 使用这个工作流' })

      expect(card.textContent).not.toContain('使用这个工作流')
      expect(card.querySelector('[aria-hidden="true"] .codicon-arrow-right')).toBeTruthy()
    }
  )
})
