import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RowButton } from './row-button'

afterEach(cleanup)

describe('RowButton', () => {
  it('renders a real <button> with type=button and the row-button slot', () => {
    const { getByText } = render(<RowButton>Row</RowButton>)
    const el = getByText('Row')

    expect(el.tagName).toBe('BUTTON')
    expect(el.getAttribute('type')).toBe('button')
    expect(el.getAttribute('data-slot')).toBe('row-button')
  })

  it('keeps caller layout classes and native disabled behavior', () => {
    const onClick = vi.fn()

    render(
      <>
        <RowButton className="custom-row" onClick={onClick}>
          Hit
        </RowButton>
        <RowButton disabled onClick={onClick}>
          Disabled row
        </RowButton>
      </>
    )

    const enabled = screen.getByRole('button', { name: 'Hit' })
    const disabled = screen.getByRole('button', { name: 'Disabled row' }) as HTMLButtonElement

    expect(enabled.className).toContain('custom-row')
    enabled.focus()
    expect(globalThis.document.activeElement).toBe(enabled)
    fireEvent.click(enabled)
    fireEvent.click(disabled)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(disabled.disabled).toBe(true)
  })

  it('allows the native button type to be overridden', () => {
    const { getByText } = render(<RowButton type="submit">Go</RowButton>)

    expect(getByText('Go').getAttribute('type')).toBe('submit')
  })
})
