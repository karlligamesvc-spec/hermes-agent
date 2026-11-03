// First: the recording time zone, before any app module or fixture (time-zone.ts).
import './__identity__/single-thread-shell/time-zone'

import { type ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  type BotProfileRow,
  botRosterFrom,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import {
  type HandoffRecord,
  resetHandoffsForTest,
  setMultiBotHandoffFlagForTest,
  startHandoff
} from '@/store/single-thread-handoff'
import { $toolDisclosureStates, setToolViewMode, type ToolViewMode } from '@/store/tool-view'

import { normalized, seedShellState } from './__identity__/single-thread-shell/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1089 identity guard (hard rule 11) for the 「交给 X」 next-step option.
 *
 * The `plain-*` goldens under `__identity__/next-steps-handoff/` were recorded on
 * e3a59a64b3 (fork main aa8e554e + the hc-1086 relay interface), before any
 * hc-1089 code existed: the transcript under a finished reply whose 「下一步」
 * block has two ordinary options, in every state where a 「交给」 option must
 * stay hidden, and in the one where it shows:
 *
 * - `classic`: single_thread off;
 * - `one-assistant`: single_thread on, multi_bot off (multi_bot_handoff on);
 * - `developer`: multi_bot and multi_bot_handoff on, developer mode;
 * - `several`: multi_bot and multi_bot_handoff on, product mode.
 *
 * A diff here means the ordinary row moved: fix the code, do not re-record.
 *
 * The same reply with a 「交给」 option in front of the two (`MIXED`) must draw
 * exactly those goldens wherever the option is hidden: the three states above
 * plus, with several assistants in product mode, the relay switch off, a name
 * that is no assistant, the assistant on screen itself, and an assistant on
 * screen that is working on a relay (接手的不能再往外交). Only `handoff-several`
 * (recorded with hc-1089) shows it: 「交给小红书文案：写成笔记」 first, then the two.
 */

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getMoaModels: vi.fn(async () => null),
  getSkills: vi.fn(async () => [])
}))

stubThreadEnvironment()
stubThreadViewportSize()

const GOLDEN = './__identity__/next-steps-handoff'

const ROSTER_ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  { name: 'writer', ui_meta: { apex: { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' } } },
  { name: 'scripts', ui_meta: { apex: { color: 'orange', created: 2, name: '带货脚本', shape: 'hexagon' } } }
]

const ANSWER = '标题写好了：\n\n1. 不打孔也能装的收纳架\n2. 9.9 元改造衣柜'
const PLAIN = ['再写 3 个 | 再写 3 个标题', '就用第 1 个 | 就用第 1 个标题']

const HANDOFF = (name: string) => `@${name} | 写成笔记 | 把第 1 个标题写成小红书笔记`
const MIXED = [HANDOFF('小红书文案'), ...PLAIN]

const replyWith = (lines: readonly string[]) => `${ANSWER}\n\n<!-- apex:next\n${lines.join('\n')}\n-->`

interface Switches {
  handoff: boolean
  multiBot: boolean
  singleThread: boolean
  toolView: ToolViewMode
}

const STATES: Readonly<Record<'classic' | 'developer' | 'one-assistant' | 'several', Switches>> = {
  classic: { handoff: false, multiBot: false, singleThread: false, toolView: 'product' },
  developer: { handoff: true, multiBot: true, singleThread: true, toolView: 'technical' },
  'one-assistant': { handoff: true, multiBot: false, singleThread: true, toolView: 'product' },
  several: { handoff: true, multiBot: true, singleThread: true, toolView: 'product' }
}

function applySwitches(switches: Switches): void {
  setSingleThreadFlagForTest(switches.singleThread)
  setMultiBotFlagForTest(switches.multiBot)
  setMultiBotHandoffFlagForTest(switches.handoff)
  setToolViewMode(switches.toolView)
  resetBotRosterForTest(switches.multiBot ? botRosterFrom(ROSTER_ROWS, () => true) : undefined)
}

const settle = (ms = 30) =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })

function turn(text: string): ThreadMessage[] {
  const createdAt = new Date(2026, 9, 21, 11, 58)

  return [
    {
      attachments: [],
      content: [{ text: '给我写 2 个收纳视频的标题', type: 'text' }],
      createdAt,
      id: 'handoff-ask',
      metadata: { custom: {} },
      role: 'user'
    },
    {
      content: [{ text, type: 'text' }],
      createdAt,
      id: 'handoff-answer',
      metadata: { custom: {}, steps: [], unstable_annotations: [], unstable_data: [], unstable_state: null },
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' }
    }
  ] as unknown as ThreadMessage[]
}

/** Every assistant row of the transcript under a finished reply carrying `text`, normalized. */
async function transcriptHtml(text: string): Promise<string> {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ThreadRuntime messages={turn(text)}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )

  await waitFor(() => expect(view.container.querySelector('[data-next-steps]')).not.toBeNull())
  await settle()

  const html = [...view.container.querySelectorAll('[data-slot="aui_assistant-message-root"]')]
    .map(node => node.outerHTML)
    .join('\n')

  cleanup()

  return normalized(html) + '\n'
}

afterAll(restoreRecordingTimeZone)

beforeEach(() => {
  seedShellState()
  // hc-1086 starts a relay only once the signed-in account is known (it owns every relay).
  $authState.set({ ...$authState.get(), accountId: 'acct-next-steps-handoff', status: 'signed-in' })
  $activeGatewayProfile.set('default')
  $activeSessionId.set('session-next-steps-handoff')
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
})

afterEach(() => {
  cleanup()
  resetHandoffsForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  resetBotRosterForTest()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  $activeGatewayProfile.set('default')
  $activeSessionId.set(null)
  setRuntimeI18nLocale('en')
  vi.useRealTimers()
})

describe.each(Object.keys(STATES) as (keyof typeof STATES)[])('%s: ordinary options', state => {
  it('draw the row they drew before hc-1089', async () => {
    applySwitches(STATES[state])

    await expect(await transcriptHtml(replyWith(PLAIN))).toMatchFileSnapshot(`${GOLDEN}/plain-${state}.html`)
  })
})

describe.each(['classic', 'one-assistant', 'developer'] as const)('%s: a 「交给」 option', state => {
  it('is left out, and the row is the ordinary golden byte for byte', async () => {
    applySwitches(STATES[state])

    await expect(await transcriptHtml(replyWith(MIXED))).toMatchFileSnapshot(`${GOLDEN}/plain-${state}.html`)
  })
})

describe('several assistants, product mode: a 「交给」 option', () => {
  it('shows first as 「交给小红书文案：写成笔记」', async () => {
    applySwitches(STATES.several)

    await expect(await transcriptHtml(replyWith(MIXED))).toMatchFileSnapshot(`${GOLDEN}/handoff-several.html`)
  })

  it('is left out with the relay switch off', async () => {
    applySwitches({ ...STATES.several, handoff: false })

    await expect(await transcriptHtml(replyWith(MIXED))).toMatchFileSnapshot(`${GOLDEN}/plain-several.html`)
  })

  it('is left out when the name is no assistant on the roster', async () => {
    applySwitches(STATES.several)

    await expect(await transcriptHtml(replyWith([HANDOFF('剪辑助手'), ...PLAIN]))).toMatchFileSnapshot(
      `${GOLDEN}/plain-several.html`
    )
  })

  it('is left out when it names the assistant on screen', async () => {
    applySwitches(STATES.several)
    $activeGatewayProfile.set('writer')

    expect(await transcriptHtml(replyWith(MIXED))).toBe(await transcriptHtml(replyWith(PLAIN)))
  })

  it('is left out while the assistant on screen works on a relay of its own', async () => {
    applySwitches(STATES.several)
    $activeGatewayProfile.set('scripts')

    const nested = startHandoff({
      ask: '写个带货脚本',
      from: { messageId: null, profile: 'default', storedSessionId: null },
      to: 'scripts'
    })

    expect(nested.ok).toBe(true)
    expect((nested as { handoff: HandoffRecord }).handoff.status).toBe('queued')
    expect(await transcriptHtml(replyWith(MIXED))).toBe(await transcriptHtml(replyWith(PLAIN)))
  })
})
