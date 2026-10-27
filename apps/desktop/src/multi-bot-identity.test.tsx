// First, before any app module: pin the zone the goldens were recorded in (CI
// runs in UTC, and a date formatter cached at import would keep the old zone).
import './__identity__/single-thread-shell/time-zone'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { setRuntimeI18nLocale } from '@/i18n'
import { resetMainThreadForTest } from '@/store/main-thread'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import {
  approvalFloatingHtml,
  approvalInlineHtml,
  clearProductState,
  composerHtml,
  emptyThreadHtml,
  headerHtml,
  memoryNotedHtml,
  runningTurnHtml,
  seedProductState,
  sidebarHtml
} from './__identity__/multi-bot/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1077 identity guard (hard rule 11) for several assistants in single-thread
 * mode (`desktop_features.multi_bot`).
 *
 * The goldens under `__identity__/multi-bot/` were recorded on fork main
 * 50a50d1bf7 with the same harness (render.tsx), before any multi-bot code
 * existed: every single-thread surface that names the assistant or reads the
 * one thread, in product mode (`product-*`) and in developer mode
 * (`developer-*`), both with single_thread on.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

stubThreadEnvironment()
stubThreadViewportSize()

const GOLDEN = './__identity__/multi-bot'

afterAll(restoreRecordingTimeZone)

afterEach(() => {
  clearProductState()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetMainThreadForTest()
  setRuntimeI18nLocale('en')
  vi.useRealTimers()
})

describe.each([
  ['product', 'product'],
  ['developer', 'technical']
] as const)('single_thread on, %s mode: the surfaces a second assistant would rename', (prefix, toolView) => {
  beforeEach(() => {
    resetMainThreadForTest()
    seedProductState()
    setSingleThreadFlagForTest(true)
    setToolViewMode(toolView)
  })

  it('the sidebar with a reply not yet seen', async () => {
    await expect(sidebarHtml('idle')).toMatchFileSnapshot(`${GOLDEN}/${prefix}-sidebar-idle.html`)
  })

  it('the sidebar while the assistant works', async () => {
    await expect(sidebarHtml('working')).toMatchFileSnapshot(`${GOLDEN}/${prefix}-sidebar-working.html`)
  })

  it('the composer', async () => {
    await expect(await composerHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-composer.html`)
  })

  it('a running turn', async () => {
    await expect(await runningTurnHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-running-turn.html`)
  })

  it('code waiting on approval, inline', async () => {
    await expect(await approvalInlineHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-approval-inline.html`)
  })

  it('code waiting on approval, as the floating bar', async () => {
    await expect(await approvalFloatingHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-approval-floating.html`)
  })

  it('a reply the assistant remembered something in (the 「记下了」 line in product mode)', async () => {
    const html = await memoryNotedHtml()

    expect(html.includes('data-memory-noted')).toBe(prefix === 'product')
    await expect(html).toMatchFileSnapshot(`${GOLDEN}/${prefix}-memory-noted.html`)
  })
})

describe('single_thread on, product mode: the thread-only surfaces', () => {
  beforeEach(() => {
    resetMainThreadForTest()
    seedProductState()
    setSingleThreadFlagForTest(true)
    setToolViewMode('product')
  })

  it('the header pill', async () => {
    await expect(headerHtml()).toMatchFileSnapshot(`${GOLDEN}/product-header.html`)
  })

  it('the empty thread', async () => {
    await expect(await emptyThreadHtml()).toMatchFileSnapshot(`${GOLDEN}/product-empty-thread.html`)
  })
})
