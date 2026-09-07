import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { ActivityToastButton } from './activity-toast-button'

const labels = {
  off: '活动通知已关闭 — 点按开启',
  on: '活动通知已开启 — 点按关闭'
}

it('names the BOTS activity control in Chinese and exposes its pressed state', () => {
  const onToggle = vi.fn()
  const { rerender } = render(<ActivityToastButton enabled={false} labels={labels} onToggle={onToggle} />)

  const off = screen.getByRole('button', { name: labels.off })
  expect(off.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(off)
  expect(onToggle).toHaveBeenCalledTimes(1)

  rerender(<ActivityToastButton enabled labels={labels} onToggle={onToggle} />)
  expect(screen.getByRole('button', { name: labels.on }).getAttribute('aria-pressed')).toBe('true')
})
