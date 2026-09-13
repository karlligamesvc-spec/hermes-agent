import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HermesConfigRecord } from '@/hermes'
import { type I18nConfigClient, I18nProvider } from '@/i18n'

import { LanguageSwitcher } from './language-switcher'

// cmdk (the searchable list) wires a ResizeObserver and scrolls the active
// item into view — neither exists in jsdom. Stub them, matching the polyfill
// idiom in assistant-ui/tool/approval-group.test.tsx.
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', TestResizeObserver)

Element.prototype.scrollIntoView = function scrollIntoView() {}

describe('LanguageSwitcher', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps a parked pointer inert, then persists a real move-and-click language change', async () => {
    const saveConfig = vi.fn().mockResolvedValue({ ok: true })
    const latestConfig: HermesConfigRecord = { display: { language: 'en', skin: 'slate' } }

    const configClient: I18nConfigClient = {
      getConfig: vi.fn().mockResolvedValue(latestConfig),
      saveConfig
    }

    render(
      <I18nProvider configClient={configClient}>
        <LanguageSwitcher />
      </I18nProvider>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Switch language' }).hasAttribute('disabled')).toBe(false)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Switch language' }))
    const option = screen.getByRole('option', { name: /日本語/i })
    const commandList = option.closest('[data-slot="command-list"]')

    expect(commandList).toBeTruthy()
    expect(commandList!.className).toContain('pointer-events-none')

    // A real pointer cannot target the inert list yet; its first movement lands
    // on the surrounding command surface, whose window-capture listener wakes
    // all options without treating the parked cursor as selection intent.
    fireEvent.mouseMove(commandList!.parentElement!)
    await waitFor(() => expect(commandList!.className).not.toContain('pointer-events-none'))

    fireEvent.click(option)

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1))
    expect(saveConfig).toHaveBeenCalledWith({ display: { language: 'ja', skin: 'slate' } })
  })
})
