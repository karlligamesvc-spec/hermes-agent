// First, before any app module: pin the zone the goldens were recorded in (CI
// runs in UTC, and a date formatter cached at import would keep the old zone).
import './__identity__/single-thread-shell/time-zone'

import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { setRuntimeI18nLocale } from '@/i18n'
import { noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  type BotProfileRow,
  botRosterFrom,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import { resetHandoffsForTest, setMultiBotHandoffFlagForTest } from '@/store/single-thread-handoff'
import { setToolViewMode } from '@/store/tool-view'

import { atPopoverHtml, threadRowsHtml } from './__identity__/handoff-ui/render'
import { seedShellState } from './__identity__/single-thread-shell/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1087 identity guard (hard rule 11) for the relay (接力) screens.
 *
 * The goldens under `__identity__/handoff-ui/` were recorded before any relay
 * screen existed — on hc-1086's branch 84072562 with fork main 56bb78eb merged
 * in — with the same harness (render.tsx): APEX's transcript rows and the
 * composer's `@` list, with several assistants on, in product mode and in
 * developer mode, relay switch off.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

stubThreadEnvironment()
stubThreadViewportSize()

const GOLDEN = './__identity__/handoff-ui'

const ROSTER_ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  { name: 'writer', ui_meta: { apex: { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' } } },
  { name: 'cutter', ui_meta: { apex: { color: 'teal', created: 2, name: '剪辑助手', shape: 'cloud' } } }
]

afterAll(restoreRecordingTimeZone)

afterEach(() => {
  cleanup()
  resetHandoffsForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  resetBotRosterForTest()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetMainThreadForTest()
  $activeGatewayProfile.set('default')
  setRuntimeI18nLocale('en')
  vi.useRealTimers()
  localStorage.clear()
})

describe.each([
  ['several assistants, product mode', 'product', 'product'],
  ['several assistants, developer mode', 'developer', 'technical']
] as const)('single_thread on, %s, relay off', (_label, prefix, toolView) => {
  beforeEach(() => {
    resetMainThreadForTest()
    seedShellState()
    setSingleThreadFlagForTest(true)
    setMultiBotFlagForTest(true)
    setToolViewMode(toolView)
    resetBotRosterForTest(botRosterFrom(ROSTER_ROWS, () => true))
    noteMainThreadClaimed('default', 'chat-a')
  })

  it('APEX’s transcript rows', async () => {
    await expect(await threadRowsHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-thread.html`)
  })

  it('the composer’s @ list', async () => {
    await expect(atPopoverHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-at-list.html`)
  })
})
