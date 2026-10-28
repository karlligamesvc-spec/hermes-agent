import { type ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale, setRuntimeI18nLocale } from '@/i18n'
import { NEXT_STEPS_COPY } from '@/i18n/next-steps'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  type BotProfileRow,
  botRosterFrom,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import { $handoffs, resetHandoffsForTest, setMultiBotHandoffFlagForTest } from '@/store/single-thread-handoff'
import type * as HandoffStore from '@/store/single-thread-handoff'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'

import { createdAt, stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from './test-utils'
import { Thread } from './thread'

// hc-1089 「交给 X」: a 「交给」 option in the 「下一步」 block (`@助手名字 | 按钮字 | 要它做什么`) hands its
// sentence, with the reply above as the carried result, to another assistant through the relay
// (hc-1086 startHandoff) — never as a message in this thread. Which states hide it is pinned
// byte for byte by src/next-steps-handoff-identity.test.tsx; this file pins what a click does.

const submitted = vi.hoisted(() => [] as string[])
const refuse = vi.hoisted(() => ({ reason: null as null | string }))

vi.mock('@/app/chat/composer/focus', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  requestComposerSubmit: (text: string) => {
    submitted.push(text)

    return true
  }
}))

vi.mock('@/store/single-thread-handoff', async importActual => {
  const actual = await importActual<typeof HandoffStore>()

  return {
    ...actual,
    startHandoff: (input: Parameters<typeof actual.startHandoff>[0]) =>
      refuse.reason ? { ok: false, reason: refuse.reason } : actual.startHandoff(input)
  }
})

stubThreadEnvironment()
stubThreadViewportSize()

const ROSTER_ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  { name: 'writer', ui_meta: { apex: { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' } } },
  { name: 'captions', ui_meta: { apex: { color: 'orange', created: 2, name: 'Captions 2', shape: 'hexagon' } } }
]

const ANSWER = '标题写好了：\n\n1. 不打孔也能装的收纳架\n\n参考了[这条爆款](https://www.douyin.com/video/7)。'

const reply = (...lines: string[]) => `${ANSWER}\n\n<!-- apex:next\n${lines.join('\n')}\n-->`

const TO_WRITER = '@小红书文案 | 写成笔记 | 把第 1 个标题写成小红书笔记'

// Every StartHandoffRefusal of hc-1086 (store/single-thread-handoff.ts).
const REFUSALS = ['empty', 'nested', 'off', 'self', 'too_many_batons', 'unknown_continues', 'unknown_receiver'] as const
const PLAIN = '再写 3 个 | 再写 3 个标题'

let answers = 0

function thread(text: string): ThreadMessage[] {
  const id = `handoff-answer-${++answers}`

  return [
    {
      attachments: [],
      content: [{ text: '给我写个标题', type: 'text' }],
      createdAt,
      id: `handoff-ask-${answers}`,
      metadata: { custom: {} },
      role: 'user'
    },
    {
      content: [{ text, type: 'text' }],
      createdAt,
      id,
      metadata: { custom: {}, steps: [], unstable_annotations: [], unstable_data: [], unstable_state: null },
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' }
    }
  ] as unknown as ThreadMessage[]
}

function renderReply(text: string, locale: Locale = 'zh') {
  setRuntimeI18nLocale(locale)

  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <ThreadRuntime messages={thread(text)}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )
}

async function rowButtons(name = '下一步') {
  const group = await waitFor(() => screen.getByRole('group', { name }))

  return within(group).getAllByRole('button')
}

function relayOn(on = true) {
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(on)
  setToolViewMode('product')
  resetBotRosterForTest(botRosterFrom(ROSTER_ROWS, () => true))
}

beforeEach(() => {
  submitted.length = 0
  refuse.reason = null
  resetHandoffsForTest()
  $activeGatewayProfile.set('default')
  $activeSessionId.set('session-handoff')
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
  $activeSessionId.set(null)
  setRuntimeI18nLocale('en')
})

describe('a 「交给」 option with the relay on', () => {
  it('names the assistant on the button and says what it will be asked on hover', async () => {
    relayOn()
    renderReply(reply(TO_WRITER, PLAIN))

    const [handoff, plain] = await rowButtons()

    expect(handoff.textContent).toBe('交给小红书文案：写成笔记')
    expect(handoff.getAttribute('title')).toBe('点一下交给小红书文案：把第 1 个标题写成小红书笔记')
    expect(handoff.getAttribute('data-next-step-handoff')).toBe('writer')
    expect(plain.textContent).toBe('再写 3 个')
  })

  it('hands the sentence and the reply above to that assistant, and sends nothing here', async () => {
    relayOn()
    renderReply(reply(TO_WRITER, PLAIN))

    const [handoff, plain] = await rowButtons()

    fireEvent.click(handoff)

    expect(submitted).toEqual([])
    const [record] = $handoffs.get()
    expect($handoffs.get()).toHaveLength(1)
    expect(record).toMatchObject({
      ask: '把第 1 个标题写成小红书笔记',
      carry: { files: [], links: ['https://www.douyin.com/video/7'], text: ANSWER, truncated: false },
      from: { messageId: `handoff-answer-${answers}`, profile: 'default', storedSessionId: null },
      status: 'queued',
      to: 'writer'
    })
    // One click per reply, like the other buttons.
    await waitFor(() => expect(handoff).toHaveProperty('disabled', true))
    expect(plain).toHaveProperty('disabled', true)
  })

  it.each(REFUSALS)('says why in plain words when the relay refuses (%s), and the row stays usable', async reason => {
    relayOn()
    refuse.reason = reason
    const { container } = renderReply(reply(TO_WRITER, PLAIN))

    const [handoff, plain] = await rowButtons()

    expect(container.querySelector('[data-next-step-handoff-refused]')).toBeNull()
    fireEvent.click(handoff)

    const note = await waitFor(() => screen.getByRole('status'))
    expect(note.getAttribute('data-next-step-handoff-refused')).toBe(reason)
    expect(note.textContent).toBe(NEXT_STEPS_COPY.zh.refused[reason]('小红书文案'))
    expect($handoffs.get()).toEqual([])
    expect(handoff).toHaveProperty('disabled', false)
    fireEvent.click(plain)
    expect(submitted).toEqual(['再写 3 个标题'])
  })

  it('clears the note once a later click goes through', async () => {
    relayOn()
    refuse.reason = 'off'
    const { container } = renderReply(reply(TO_WRITER, PLAIN))

    const [handoff] = await rowButtons()

    fireEvent.click(handoff)
    await waitFor(() => expect(container.querySelector('[data-next-step-handoff-refused]')).not.toBeNull())
    refuse.reason = null
    fireEvent.click(handoff)

    await waitFor(() => expect(container.querySelector('[data-next-step-handoff-refused]')).toBeNull())
    expect($handoffs.get()).toHaveLength(1)
  })

  it('matches the name the way the sidebar shows it: any case, runs of spaces', async () => {
    relayOn()
    renderReply(reply('@CAPTIONS  2 | Add subtitles | Add burned-in subtitles to this cut'), 'en')

    const [handoff] = await rowButtons('Next steps')

    expect(handoff.textContent).toBe('Hand to Captions 2: Add subtitles')
    expect(handoff.getAttribute('title')).toBe('Hands this to Captions 2: Add burned-in subtitles to this cut')
    expect(handoff.getAttribute('data-next-step-handoff')).toBe('captions')
  })
})

describe('the refusal lines', () => {
  it.each(['zh', 'zh-hant', 'en'] as const)('name the assistant for every hc-1086 refusal (%s)', locale => {
    const copy = NEXT_STEPS_COPY[locale].refused

    expect(Object.keys(copy).sort()).toEqual([...REFUSALS].sort())

    for (const reason of REFUSALS) {
      expect(copy[reason]('剪辑助手')).toContain('剪辑助手')
    }
  })

  it('keeps Chinese lines free of English words and internal names', () => {
    for (const locale of ['zh', 'zh-hant'] as const) {
      for (const reason of REFUSALS) {
        const line = NEXT_STEPS_COPY[locale].refused[reason]('剪辑助手')

        expect(line).not.toMatch(/[A-Za-z]/)
      }
    }
  })
})

describe('a block whose only option is a 「交给」 one', () => {
  it('draws no row while the relay is off', async () => {
    relayOn(false)
    const { container } = renderReply(reply(TO_WRITER))

    await waitFor(() => expect(container.textContent).toContain('不打孔也能装的收纳架'))
    expect(container.querySelector('[data-next-steps]')).toBeNull()
    expect(container.textContent).not.toContain('小红书文案')
  })

  it('draws just that button while it is on', async () => {
    relayOn()
    renderReply(reply(TO_WRITER))

    expect((await rowButtons()).map(button => button.textContent)).toEqual(['交给小红书文案：写成笔记'])
  })
})
