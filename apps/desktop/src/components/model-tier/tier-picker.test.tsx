import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'
import { MODEL_TIER_LABEL, type ModelTier } from '@/lib/model-tiers'
import { $authState } from '@/store/auth'

import { ModelTierPicker } from './tier-picker'

/**
 * hc-1134: a locked card names the plan that opens it, and a plan has one name
 * everywhere: FREE, PRO, MAX. The card's own title is the model tier (Flash, Pro,
 * Max), which is what an assistant runs on, not a plan, so it does not change.
 *
 * Not tied to a mode: the plan belongs to the account, and developer mode and
 * switch off draw this same picker for an account in tier mode.
 */

const signedOut = $authState.get()

function renderPicker({ locale = 'zh', maxOpen = true }: { locale?: Locale; maxOpen?: boolean } = {}) {
  $authState.set({
    ...signedOut,
    account: { email: 'kael@example.com', name: 'Kael', plan: 'free' },
    accountId: 'acct-1',
    enabled: true,
    modelTierMax: maxOpen,
    modelTiers: true,
    status: 'signed-in'
  })

  return render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider configClient={null} initialLocale={locale}>
        <ModelTierPicker
          availability={{ status: 'ready', tiers: new Set<ModelTier>(['flash']) }}
          onChange={() => undefined}
          value="flash"
        />
      </I18nProvider>
    </QueryClientProvider>
  )
}

const card = (tier: ModelTier) => document.querySelector<HTMLElement>(`[data-tier="${tier}"]`)!

afterEach(() => {
  cleanup()
  $authState.set(signedOut)
})

describe('a locked card names the plan', () => {
  it.each([
    ['zh', 'PRO 起可用', 'MAX 起可用', 'Pro 档需要 PRO 或以上的套餐。', 'Max 档需要 MAX 或以上的套餐。'],
    ['zh-hant', 'PRO 起可用', 'MAX 起可用', 'Pro 檔需要 PRO 或以上的方案。', 'Max 檔需要 MAX 或以上的方案。'],
    ['en', 'PRO plan and up', 'MAX plan and up', 'Pro needs the PRO plan or higher.', 'Max needs the MAX plan or higher.'],
    ['ja', 'PRO plan and up', 'MAX plan and up', 'Pro needs the PRO plan or higher.', 'Max needs the MAX plan or higher.'],
    ['ar', 'PRO plan and up', 'MAX plan and up', 'Pro needs the PRO plan or higher.', 'Max needs the MAX plan or higher.']
  ] as const)('%s: the badge, and what a click on it says', (locale, proBadge, maxBadge, proNotice, maxNotice) => {
    renderPicker({ locale })

    expect(card('pro').dataset.state).toBe('locked')
    expect(card('pro').textContent).toContain(proBadge)
    expect(card('max').dataset.state).toBe('locked')
    expect(card('max').textContent).toContain(maxBadge)

    fireEvent.click(card('pro'))
    expect(screen.getByRole('status').textContent).toBe(proNotice)

    fireEvent.click(card('max'))
    expect(screen.getByRole('status').textContent).toBe(maxNotice)
  })

  it.each(['zh', 'zh-hant', 'en'] as const)('%s: none of the old names is left', locale => {
    const { container } = renderPicker({ locale })

    fireEvent.click(card('pro'))

    expect(container.textContent).not.toMatch(/快速版|高级版|進階版|Fast plan|Advanced plan/)
  })

  it('while Max is closed its card says so and names no plan: 「MAX 起可用」 is only for when it is open', () => {
    renderPicker({ maxOpen: false })

    expect(card('max').dataset.state).toBe('coming-soon')
    expect(card('max').textContent).toContain('即将开放')
    expect(card('max').textContent).not.toContain('MAX')
    expect(card('pro').textContent).toContain('PRO 起可用')
  })
})

describe('the tiers keep their own names', () => {
  it('the labels are still Flash, Pro and Max', () => {
    expect(MODEL_TIER_LABEL).toEqual({ flash: 'Flash', max: 'Max', pro: 'Pro' })
  })

  it.each([
    ['flash', 'Flash'],
    ['pro', 'Pro'],
    ['max', 'Max']
  ] as const)('the %s card is titled %s', (tier, title) => {
    renderPicker()

    expect(card(tier).querySelector('span span')?.textContent).toBe(title)
  })
})
