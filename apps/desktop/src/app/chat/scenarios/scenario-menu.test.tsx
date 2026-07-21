import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_CATALOG, type ScenarioItem } from './catalog'
import { ScenarioMenu } from './scenario-menu'

afterEach(cleanup)

describe('ScenarioMenu', () => {
  it('renders the category rail and the active category items', () => {
    render(<ScenarioMenu catalog={FALLBACK_CATALOG} onPick={() => undefined} />)

    // Category tabs (section titles from the catalog).
    expect(screen.getByRole('button', { name: '社媒' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '电商' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '更多' })).toBeTruthy()

    // Active (first) category's items.
    expect(screen.getByRole('button', { name: /热榜/ })).toBeTruthy()
  })

  it('calls onPick with the live item when a row is clicked', () => {
    const onPick = vi.fn<(item: ScenarioItem) => void>()
    render(<ScenarioMenu catalog={FALLBACK_CATALOG} onPick={onPick} />)

    fireEvent.click(screen.getByRole('button', { name: /热榜/ }))

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0]?.[0]?.key).toBe('trending')
  })

  it('renders a coming-soon item as non-interactive (no button, no pick)', () => {
    const onPick = vi.fn()
    render(<ScenarioMenu catalog={FALLBACK_CATALOG} onPick={onPick} />)

    // Switch to 电商 where 竞品监控 (coming_soon) lives.
    fireEvent.click(screen.getByRole('button', { name: '电商' }))

    // Present as text, but not a button — so it can't be picked.
    expect(screen.getByText('竞品监控')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /竞品监控/ })).toBeNull()
  })

  it('filters the active category by the search query', () => {
    render(<ScenarioMenu catalog={FALLBACK_CATALOG} onPick={() => undefined} />)

    fireEvent.click(screen.getByRole('button', { name: '电商' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'listing' } })

    expect(screen.getByText('Listing·评价')).toBeTruthy()
    expect(screen.queryByText('爆品分析')).toBeNull()
  })
})
