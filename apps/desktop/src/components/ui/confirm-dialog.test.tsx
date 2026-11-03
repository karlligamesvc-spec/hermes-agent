import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConfirmDialog } from './confirm-dialog'

afterEach(cleanup)

describe('ConfirmDialog when the caller takes over', () => {
  it('skips the done beat and the timed close when onConfirm resolves to handled', async () => {
    vi.useFakeTimers()

    try {
      const onClose = vi.fn()

      render(<ConfirmDialog confirmLabel="Go" doneLabel="All done" onClose={onClose} onConfirm={async () => 'handled' as const} open title="Sure?" />)

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Go' }))
      })
      expect(screen.queryByText('All done')).toBeNull()
      expect((screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement).disabled).toBe(false)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still shows the done beat and closes otherwise', async () => {
    vi.useFakeTimers()

    try {
      const onClose = vi.fn()

      render(<ConfirmDialog confirmLabel="Go" doneLabel="All done" onClose={onClose} onConfirm={async () => {}} open title="Sure?" />)

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Go' }))
      })
      expect(screen.getByText('All done')).toBeTruthy()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ConfirmDialog secondary action', () => {
  function renderWithSecondary() {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    const onSecondary = vi.fn()

    render(
      <ConfirmDialog
        onClose={onClose}
        onConfirm={onConfirm}
        open
        secondaryAction={{ label: 'Remove from sidebar', onClick: onSecondary }}
        title="Remove worktree?"
      />
    )

    return { onClose, onConfirm, onSecondary }
  }

  it('runs the secondary action and closes without confirming', async () => {
    const { onClose, onConfirm, onSecondary } = renderWithSecondary()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove from sidebar' }))

    expect(onSecondary).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('still opens focused on Confirm, so Enter confirms rather than picking the secondary', async () => {
    const { onConfirm, onSecondary } = renderWithSecondary()

    const dialog = await screen.findByRole('dialog')

    // eslint-disable-next-line no-restricted-globals -- asserting real focus requires the live document
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    // eslint-disable-next-line no-restricted-globals -- asserting real focus requires the live document
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onSecondary).not.toHaveBeenCalled()
  })
})
