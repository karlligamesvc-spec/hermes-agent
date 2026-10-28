/**
 * hc-1085 identity guard harness for the command palette (⌘K). Opens the real
 * CommandPalette over the real core contributions and bundled plugins (the
 * caller imports app/contrib/controller) and lists every group and row the
 * way the goldens beside this file were recorded on fork main aa8e554e38,
 * before hc-1085 folded any row. It must keep using only APIs main already
 * had: the same file recorded the goldens there.
 */
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { CommandPalette } from '@/app/command-palette'
import { I18nProvider } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { closeCommandPalette, openCommandPalette } from '@/store/command-palette'

/** Every group heading with its rows' visible text (label, state, shortcut), in order. */
export async function paletteJson(): Promise<string> {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/chat-a']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <CommandPalette />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )

  act(() => openCommandPalette())
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 100))
  })

  const groups = [...document.querySelectorAll('[cmdk-group]')].map(group => ({
    heading: group.querySelector('[cmdk-group-heading]')?.textContent ?? '',
    rows: [...group.querySelectorAll('[cmdk-item]')].map(item => (item.textContent ?? '').trim())
  }))

  act(() => closeCommandPalette())
  cleanup()

  return JSON.stringify(groups, null, 2) + '\n'
}
