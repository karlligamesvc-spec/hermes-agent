/**
 * hc-1193 identity guard harness for Settings › 语音's 「文字转语音提供方」 row.
 * Renders the real ConfigSettings voice page (the caller mocks the config API)
 * and reads what the row shows, what its list offers and which voice fields the
 * page mounts. The goldens beside this file were recorded with it on fork main
 * 598bf3e896, before hc-1193 changed the row; it uses only APIs main had.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { MemoryRouter } from 'react-router'

import { ConfigSettings } from '@/app/settings/config-settings'
import { I18nProvider } from '@/i18n'

export interface VoiceProviderRow {
  /** What the closed select reads. */
  shown: string
  /** The list it opens, in order. */
  options: string[]
  /** The page's config rows, by key. */
  fields: string[]
}

export async function voiceProviderRow(): Promise<VoiceProviderRow> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings?tab=config:voice']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <ConfigSettings activeSectionId="voice" importInputRef={createRef<HTMLInputElement>()} />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )

  const trigger = await waitFor(() => {
    const element = document.getElementById('setting-field-tts.provider')?.querySelector('[role="combobox"]')

    if (!element) {
      throw new Error('no 文字转语音提供方 row yet')
    }

    return element
  })

  const shown = (trigger.textContent ?? '').trim()

  const fields = [...document.querySelectorAll('[id^="setting-field-"]')].map(element =>
    element.id.slice('setting-field-'.length)
  )

  act(() => {
    fireEvent.click(trigger)
  })

  const options = (await screen.findAllByRole('option')).map(option => (option.textContent ?? '').trim())

  cleanup()

  return { fields, options, shown }
}
