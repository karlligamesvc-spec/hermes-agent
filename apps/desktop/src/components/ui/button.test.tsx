import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Badge } from './badge'
import { Button } from './button'

afterEach(cleanup)

describe('APEX shared action hierarchy', () => {
  it('keeps primary, secondary, tertiary and destructive actions distinct in rendered output', () => {
    const onPrimary = vi.fn()
    const onSecondary = vi.fn()
    const onTertiary = vi.fn()
    const onDestructive = vi.fn()

    render(
      <div>
        <Button onClick={onPrimary}>Save</Button>
        <Button onClick={onSecondary} variant="outline">
          Edit
        </Button>
        <Button onClick={onTertiary} variant="ghost">
          Back
        </Button>
        <Button onClick={onDestructive} variant="destructive">
          Delete
        </Button>
      </div>
    )

    const primary = screen.getByRole('button', { name: 'Save' })
    const secondary = screen.getByRole('button', { name: 'Edit' })
    const tertiary = screen.getByRole('button', { name: 'Back' })
    const destructive = screen.getByRole('button', { name: 'Delete' })

    expect(primary.getAttribute('data-variant')).toBe('default')
    expect(primary.className).toContain('bg-(--dt-primary-solid)')
    expect(primary.className).toContain('text-(--dt-primary-solid-foreground)')
    expect(primary.className).toContain('hover:bg-[color-mix(in_srgb,var(--dt-primary-solid)_90%,black)]')
    expect(primary.className).toContain('focus-visible:ring-[0.1875rem]')
    expect(primary.className).toContain('active:brightness-[0.96]')
    expect(secondary.getAttribute('data-variant')).toBe('outline')
    expect(tertiary.getAttribute('data-variant')).toBe('ghost')
    expect(destructive.getAttribute('data-variant')).toBe('destructive')

    fireEvent.click(primary)
    fireEvent.click(secondary)
    fireEvent.click(tertiary)
    fireEvent.click(destructive)

    expect(onPrimary).toHaveBeenCalledTimes(1)
    expect(onSecondary).toHaveBeenCalledTimes(1)
    expect(onTertiary).toHaveBeenCalledTimes(1)
    expect(onDestructive).toHaveBeenCalledTimes(1)
  })

  it('makes disabled and loading state perceivable and prevents disabled repeat actions', () => {
    const onClick = vi.fn()

    render(
      <Button aria-busy disabled onClick={onClick}>
        Saving
      </Button>
    )

    const button = screen.getByRole('button', { name: 'Saving' }) as HTMLButtonElement

    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('preserves semantic badge tone and size for status metadata', () => {
    render(
      <>
        <Badge>Live</Badge>
        <Badge variant="muted">Queued</Badge>
        <Badge size="xs" variant="destructive">
          Failed
        </Badge>
      </>
    )

    const live = screen.getByText('Live')
    const queued = screen.getByText('Queued')
    const failed = screen.getByText('Failed')

    expect(live.getAttribute('data-variant')).toBe('default')
    expect(live.getAttribute('data-size')).toBe('default')
    expect(queued.getAttribute('data-variant')).toBe('muted')
    expect(queued.getAttribute('data-size')).toBe('default')
    expect(failed.getAttribute('data-variant')).toBe('destructive')
    expect(failed.getAttribute('data-size')).toBe('xs')
  })
})
