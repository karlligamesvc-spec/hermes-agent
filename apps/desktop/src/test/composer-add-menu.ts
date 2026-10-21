import { fireEvent, screen, within } from '@testing-library/react'
import { vi } from 'vitest'

/** What Radix menus call on open that jsdom lacks. */
export function stubMenuPointerApis() {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
}

/** Open a composer's "+" menu: Radix opens a dropdown on pointerdown, not on a
 *  bare click. */
export function openAddMenu(scope: HTMLElement, name: string) {
  const trigger = within(scope).getByRole('button', { name })

  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
}

/** Open a submenu row the keyboard way (jsdom has no hover). */
export async function openSubmenu(name: string) {
  const row = await screen.findByRole('menuitem', { name: new RegExp(`^${name}`) })

  row.focus()
  fireEvent.keyDown(row, { key: 'ArrowRight' })
}

/** The Start input's workflow choice, which lives under "+" › 高级 outside
 *  developer mode (WP4: attach · voice · send). */
export async function chooseWorkflowFromAddMenu(
  form: HTMLElement,
  copy: { addMenu: string; advanced: string },
  label: RegExp | string
) {
  openAddMenu(form, copy.addMenu)
  await openSubmenu(copy.advanced)
  fireEvent.click(await screen.findByRole('menuitem', { name: label }))
}
