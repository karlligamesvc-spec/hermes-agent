/**
 * hc-1137 identity guard (hard rule 11): the paste-to-act chips a pasted
 * short-video link offers above the chat composer, in product mode and in
 * developer mode, recorded on fork main before hc-1137 touched them. hc-1137
 * adds one chip (复刻成我的); everything else in the strip must stay byte-for-
 * byte as it was. A diff that is not that one chip means something else moved:
 * fix the code, do not re-record the golden unless the change is meant to
 * reach every user.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatBar } from '@/app/chat/composer'
import { RICH_INPUT_SLOT } from '@/app/chat/composer/rich-editor'
import type { ChatBarState } from '@/app/chat/composer/types'
import { stubThreadEnvironment, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import type { Locale } from '@/i18n/types'
import { $authState } from '@/store/auth'
import { clearSessionDraft, mainComposerScope } from '@/store/composer'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { $singleThreadFlag } from '@/store/single-thread'
import { setToolViewMode, type ToolViewMode } from '@/store/tool-view'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getSkills: vi.fn(async () => []),
  getMoaModels: vi.fn(async () => null)
}))

stubThreadEnvironment()

const GOLDEN = './__identity__/paste-chips'
const LINK = 'https://v.douyin.com/iRNBho6u/'

const STATE: ChatBarState = {
  model: { canSwitch: true, model: 'apex-flash', provider: 'custom' },
  tools: { enabled: true, label: 'Add context' },
  voice: { enabled: true, active: false }
}

const normalized = (html: string) => html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 40))
  })

/** The strip above the composer once a Douyin link sits in the draft. */
async function pasteStrip(locale: Locale): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale={locale}>
          <ThreadRuntime messages={[]}>
            <ChatBar
              busy={false}
              disabled={false}
              onCancel={() => {}}
              onPickFiles={() => {}}
              onPickFolders={() => {}}
              onPickImages={() => {}}
              onSteer={async () => true}
              onSubmit={async () => true}
              state={STATE}
            />
          </ThreadRuntime>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )

  await settle()
  const editor = container.querySelector<HTMLElement>(`[data-slot="${RICH_INPUT_SLOT}"]`)!

  editor.append(window.document.createTextNode(LINK))
  fireEvent.input(editor)
  await settle()

  const group = container.querySelector('[data-slot="composer-paste-actions"]')

  expect(group).not.toBeNull()

  return normalized(group!.parentElement!.outerHTML)
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

beforeEach(() => {
  $activeSessionId.set('session-identity')
  $gatewayState.set('open')
  clearSessionDraft(null)
  $authState.set({
    ...$authState.get(),
    enabled: true,
    gateReason: null,
    modelTierMax: false,
    modelTiers: false,
    status: 'signed-in'
  })
})

afterEach(() => {
  cleanup()
  mainComposerScope.clear()
  clearSessionDraft(null)
  $singleThreadFlag.set(false)
  setRuntimeI18nLocale('en')
  setToolViewMode('product')
  $activeSessionId.set(null)
})

const CASES: [string, Locale, ToolViewMode, boolean][] = [
  ['product-zh', 'zh', 'product', true],
  ['product-zh-hant', 'zh-hant', 'product', true],
  ['product-en', 'en', 'product', true],
  ['developer-zh', 'zh', 'technical', false]
]

describe('the paste-to-act strip over a pasted Douyin link', () => {
  it.each(CASES)('%s', async (name, locale, mode, singleThread) => {
    setRuntimeI18nLocale(locale)
    setToolViewMode(mode)
    $singleThreadFlag.set(singleThread)

    await expect(await pasteStrip(locale)).toMatchFileSnapshot(`${GOLDEN}/${name}.html`)
  })
})
