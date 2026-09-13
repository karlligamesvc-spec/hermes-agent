import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { SearchField } from './search-field'

describe('SearchField', () => {
  it('fills its owning search row and uses the shared focus surface instead of a native square outline', () => {
    const onChange = vi.fn()

    const { container } = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <SearchField containerClassName="w-full" onChange={onChange} placeholder="搜索会话…" value="" />
      </I18nProvider>
    )

    const input = screen.getByRole('textbox', { name: '搜索会话…' })

    expect(input.className).toContain('flex-1')
    expect(input.className).toContain('focus:outline-none')
    expect(input.className).not.toContain('[field-sizing:content]')
    expect(input.parentElement?.className).toContain('focus-within:border-(--ui-stroke-secondary)')
    expect(container.firstElementChild?.className).toContain('w-full')

    fireEvent.change(input, { target: { value: '项目' } })
    expect(onChange).toHaveBeenCalledWith('项目')
  })
})
