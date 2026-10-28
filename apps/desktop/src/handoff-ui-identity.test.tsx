// First, before any app module: pin the zone the goldens were recorded in (CI
// runs in UTC, and a date formatter cached at import would keep the old zone).
import './__identity__/single-thread-shell/time-zone'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { setRuntimeI18nLocale } from '@/i18n'
import { $mainThreadsByProfile, noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $selectedStoredSessionId } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  $botLastSessions,
  type BotProfileRow,
  botRosterFrom,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import { type HandoffRecord, resetHandoffsForTest, setMultiBotHandoffFlagForTest } from '@/store/single-thread-handoff'
import { $botSeenReplyIds } from '@/store/single-thread-presence'
import { $threadActivity } from '@/store/thread-signals'
import { setToolViewMode } from '@/store/tool-view'

import { atPopoverHtml, threadRowsHtml } from './__identity__/handoff-ui/render'
import { normalized, renderSidebar, seedShellState } from './__identity__/single-thread-shell/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1087 identity guard (hard rule 11) for the relay (接力) screens.
 *
 * The goldens under `__identity__/handoff-ui/` were recorded before any relay
 * screen existed — on hc-1086's branch 84072562 with fork main 56bb78eb merged
 * in — with the same harness (render.tsx): APEX's transcript rows and the
 * composer's `@` list, with several assistants on, in product mode and in
 * developer mode, relay switch off.
 *
 * - relay off: byte-identical, both modes.
 * - relay on in developer mode: the developer goldens (relay counts only in
 *   single-thread product mode).
 * - relay on in product mode with no relay in play, or only relays between
 *   assistants not on screen: the product transcript golden, and hc-1077's
 *   several-assistants sidebar golden (`__identity__/multi-bot/`).
 *   Our `@` list replaces the composer's there by design (L10), so the product
 *   `@` golden is pinned with relay off only.
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

const elsewhere: HandoffRecord = {
  ask: '剪成 30 秒',
  attempts: 1,
  baton: 1,
  cancelReason: null,
  carry: { files: [], links: [], text: '', truncated: false },
  chainId: 'ho_x',
  createdAt: 1,
  failure: null,
  finishedAt: 2,
  from: { messageId: null, name: '小红书文案', profile: 'writer', storedSessionId: null },
  id: 'ho_x',
  notBefore: null,
  owner: 'acc-1',
  queueReason: null,
  result: null,
  startedAt: 1,
  status: 'failed',
  to: 'cutter',
  turn: null,
  updatedAt: 2,
  waitingFor: null
}

describe.each([
  ['several assistants, product mode, relay on, nothing in play', 'product', 'product', []],
  ['several assistants, product mode, relay on, a relay between two others', 'product', 'product', [elsewhere]],
  ['several assistants, developer mode, relay on', 'developer', 'technical', [elsewhere]]
] as const)('single_thread on, %s', (_label, prefix, toolView, records) => {
  beforeEach(() => {
    resetMainThreadForTest()
    seedShellState()
    setSingleThreadFlagForTest(true)
    setMultiBotFlagForTest(true)
    setMultiBotHandoffFlagForTest(true)
    setToolViewMode(toolView)
    resetBotRosterForTest(botRosterFrom(ROSTER_ROWS, () => true))
    noteMainThreadClaimed('default', 'chat-a')
    resetHandoffsForTest(records)
  })

  it('APEX’s transcript rows: the relay-off golden', async () => {
    await expect(await threadRowsHtml()).toMatchFileSnapshot(`${GOLDEN}/${prefix}-thread.html`)
  })

  if (prefix === 'developer') {
    it('the composer’s @ list: the relay-off golden', async () => {
      await expect(atPopoverHtml()).toMatchFileSnapshot(`${GOLDEN}/developer-at-list.html`)
    })
  }
})

describe('relay on, product mode, nothing in play: hc-1077’s several-assistants sidebar, byte for byte', () => {
  it('⑥ the sidebar on APEX, one assistant replied in the background', () => {
    seedShellState()
    setSingleThreadFlagForTest(true)
    setMultiBotFlagForTest(true)
    setMultiBotHandoffFlagForTest(true)
    setToolViewMode('product')
    resetBotRosterForTest(
      botRosterFrom(
        [
          { is_default: true, name: 'default' },
          { name: 'writer', ui_meta: { apex: { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' } } },
          { name: 'scripts', ui_meta: { apex: { color: 'orange', created: 2, name: '带货脚本', shape: 'hexagon' } } }
        ],
        () => true
      )
    )
    $activeGatewayProfile.set('default')

    const found = (profile: string, id: string) => ({
      ids: [id],
      profile,
      rootId: id,
      status: 'found' as const,
      tipId: id
    })

    $mainThreadsByProfile.set({
      default: found('default', 'chat-a'),
      scripts: found('scripts', 'scripts-root'),
      writer: found('writer', 'writer-root')
    })
    noteMainThreadClaimed('default', 'chat-a')
    $selectedStoredSessionId.set('chat-a')
    $threadActivity.set({ text: '在剪 · 第 2 镜，共 4 镜', waiting: false })
    $botSeenReplyIds.set({ writer: 'w-1' })
    $botLastSessions.set({ scripts: { id: 'scripts-root', preview: '好，定稿了。下次换款直接丢链接' } })

    const reply = (id: string, text: string) => ({ id, parts: [{ text, type: 'text' }], role: 'assistant' })

    $sessionStates.set({
      apex: { busy: true, messages: [], needsInput: false, storedSessionId: 'chat-a' },
      writer: {
        busy: false,
        messages: [reply('w-1', '收纳那条'), reply('w-2', '标题写好了 3 个')],
        needsInput: false,
        storedSessionId: 'writer-root'
      }
    } as never)

    try {
      expect(normalized(renderSidebar('/chat-a', 'chat').container.innerHTML) + '\n').toBe(
        readFileSync(join(__dirname, '__identity__', 'multi-bot', 'multi-bot-sidebar.html'), 'utf8')
      )
    } finally {
      $threadActivity.set(null)
      $botSeenReplyIds.set({})
      $botLastSessions.set({})
      $sessionStates.set({})
      $mainThreadsByProfile.set({})
      $selectedStoredSessionId.set(null)
    }
  })
})
