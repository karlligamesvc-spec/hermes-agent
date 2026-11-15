/**
 * hc-1247: a relay (接力) takes along the files of the reply it hands on, read from that reply as
 * Desktop stores it. The stream and the transcript both store an assistant reply after
 * renderMediaTags (lib/chat-messages/parts.ts), so by then each `MEDIA:` line the reply delivered a
 * file with (hc-1130) is a `[Audio: x.mp3](#media:%2F…)` link. The relay read only raw `MEDIA:`
 * lines: 「交给」 under a result, `@助手` after it and a relay plan it proposed took none of its
 * voiceovers, videos or documents along. The confirm card said 「上面那条结果（N 字）和你这句话」
 * and the hand-over listed no files.
 *
 * Every reply here is built the way it is stored, through renderMediaTags; a raw `MEDIA:` line
 * would pass whether or not the stored shape is read.
 */
// First: the recording time zone (the shell harness's fixtures are wall-clock times).
import '@/__identity__/single-thread-shell/time-zone'

import type { ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { seedShellState } from '@/__identity__/single-thread-shell/render'
import { restoreRecordingTimeZone } from '@/__identity__/single-thread-shell/time-zone'
import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { I18nProvider, type Locale, setRuntimeI18nLocale } from '@/i18n'
import { renderMediaTags } from '@/lib/chat-messages/parts'
import { handoffRequestText, replyAttachments } from '@/lib/handoff-text'
import { $authState } from '@/store/auth'
import { $handoffPlans, resetHandoffPlansForTest } from '@/store/handoff-plan'
import { noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $gatewayState, $messages, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  type BotProfileRow,
  botRosterFrom,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import {
  $handoffs,
  handoffById,
  type HandoffRecord,
  resetHandoffsForTest,
  setMultiBotHandoffFlagForTest
} from '@/store/single-thread-handoff'
import { $handoffProposal, dismissHandoffProposal } from '@/store/single-thread-handoff-confirm'
import { setToolViewMode } from '@/store/tool-view'

import { handoffMentionSend, lastReply, mentionPrevious } from './mention'

stubThreadEnvironment()
stubThreadViewportSize()

const ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  { name: 'writer', ui_meta: { apex: { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' } } },
  { name: 'cutter', ui_meta: { apex: { color: 'teal', created: 2, name: '剪辑助手', shape: 'cloud' } } }
]

// A voiceover text_to_speech named by the clock, and a document named after its title (a space in it).
const VOICEOVER = '/Users/me/.apexnodes/cache/audio/tts_20261115_101010.mp3'
const SCRIPT = '/Users/me/APEX/成片/口播稿 第二版_4a2ea035.docx'
const NOTE = 'https://www.xiaohongshu.com/explore/a'

/** APEX's reply as the engine wrote it: two files delivered on `MEDIA:` lines, and a link in the prose. */
const RAW = `配音和口播稿都好了，照着[这篇笔记](${NOTE})的节奏写的：\n\nMEDIA:${VOICEOVER}\n\nMEDIA:${SCRIPT}`

/** The same reply as Desktop stores and shows it, with a block after it. */
function stored(block = ''): string {
  const text = renderMediaTags(block ? `${RAW}\n\n${block}` : RAW)

  // The shape under test: no raw tag is left for the old reading to find.
  expect(text).not.toContain('MEDIA:')
  expect(text.match(/\]\(#media:/g)).toHaveLength(2)

  return text
}

const at = (minute: number) => new Date(2026, 9, 21, 9, minute)

function user(id: string, minute: number, text: string): ThreadMessage {
  return {
    attachments: [],
    content: [{ text, type: 'text' }],
    createdAt: at(minute),
    id,
    metadata: { custom: {} },
    role: 'user'
  } as ThreadMessage
}

function assistant(id: string, minute: number, text: string): ThreadMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt: at(minute),
    id,
    metadata: { custom: {}, steps: [], unstable_annotations: [], unstable_data: [], unstable_state: null },
    role: 'assistant',
    status: { reason: 'stop', type: 'complete' }
  } as unknown as ThreadMessage
}

function relayOn(locale: Locale = 'zh'): void {
  seedShellState()
  setRuntimeI18nLocale(locale)
  setToolViewMode('product')
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(true)
  resetBotRosterForTest(botRosterFrom(ROWS, () => true))
  $activeGatewayProfile.set('default')
  $activeSessionId.set('session-carry')
  $gatewayState.set('open')
  $authState.set({ ...$authState.get(), accountId: 'acc-1', status: 'signed-in' })
  noteMainThreadClaimed('default', 'chat-a')
  $selectedStoredSessionId.set('chat-a')
}

async function renderThread(messages: ThreadMessage[], locale: Locale = 'zh'): Promise<HTMLElement> {
  const view = render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )

  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

  return view.container
}

/** The hand-over message the relay runner submits for a record (handoff-runner.ts `submit`). */
const handOverText = (record: HandoffRecord) =>
  handoffRequestText({
    ask: record.ask,
    carry: record.carry,
    files: record.carry.files,
    from: record.from.profile,
    fromName: record.from.name || record.from.profile,
    id: record.id,
    links: record.carry.links
  })

const CARRIED = `里面的文件和链接：\n- ${VOICEOVER}\n- ${SCRIPT}\n- ${NOTE}`

beforeEach(() => {
  localStorage.clear()
  resetMainThreadForTest()
  resetHandoffsForTest()
  resetHandoffPlansForTest()
})

afterEach(() => {
  cleanup()
  dismissHandoffProposal()
  resetHandoffsForTest()
  resetHandoffPlansForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  resetMainThreadForTest()
  $messages.set([])
  $activeGatewayProfile.set('default')
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  setRuntimeI18nLocale('en')
  localStorage.clear()
})

afterAll(restoreRecordingTimeZone)

describe('「交给」 under a result (下一步)', () => {
  it.each<[Locale, RegExp, string]>([
    ['zh', /^会带上：上面那条结果（\d+ 字）、2 个文件、1 个链接和你这句话。/, '交给它'],
    ['en', /^Takes the reply above \(\d+ characters\), 2 files, 1 link and what you wrote\./, 'Hand it over']
  ])('%s: the confirm card and the hand-over take the reply’s files along', async (locale, carryLine, confirm) => {
    relayOn(locale)

    // An id of its own: a 「下一步」 row once used stays used for that reply (next-steps.tsx `used`).
    const container = await renderThread(
      [
        user(`${locale}-ask`, 20, '把口播稿配个音'),
        assistant(
          `${locale}-answer`,
          21,
          stored('<!-- apex:next\n@小红书文案 | 写成笔记 | 用这段配音和口播稿写一篇小红书笔记\n-->')
        )
      ],
      locale
    )

    fireEvent.click(container.querySelector<HTMLElement>('[data-next-step-handoff="writer"]')!)

    expect($handoffProposal.get()?.input.previous).toMatchObject({ files: [VOICEOVER, SCRIPT], links: [NOTE] })

    const card = container.querySelector<HTMLElement>('[data-handoff-card="confirm"]')!

    expect([...card.querySelectorAll('p')].map(line => line.textContent)).toContainEqual(
      expect.stringMatching(carryLine)
    )
    expect(card.querySelectorAll('[data-handoff-items] li')).toHaveLength(3)
    // The path never shows on the card (hc-1131): the chips name the files.
    expect(card.textContent).not.toContain('/Users/')

    fireEvent.click(within(card).getByRole('button', { name: confirm }))

    const [record] = $handoffs.get()

    expect(record?.carry).toMatchObject({ files: [VOICEOVER, SCRIPT], links: [NOTE] })
    expect(handOverText(record!)).toContain(CARRIED)
  })
})

describe('@助手 after a result', () => {
  function inApexThread(): void {
    relayOn()
    $messages.set([
      { id: 'u1', parts: [{ text: '把口播稿配个音', type: 'text' as const }], role: 'user' as const },
      { id: 'a1', parts: [{ text: stored(), type: 'text' as const }], role: 'assistant' as const }
    ] as never)
  }

  it('mentionPrevious takes the reply’s files after the ones attached to the send', () => {
    inApexThread()

    const reply = lastReply($messages.get())

    expect(mentionPrevious(reply, [{ id: 'f', kind: 'file', label: '素材', path: '/Users/me/素材.mp4' }])).toEqual({
      files: ['/Users/me/素材.mp4', VOICEOVER, SCRIPT],
      links: [NOTE],
      text: reply!.text
    })
  })

  it('the composer’s send naming another assistant proposes them', () => {
    inApexThread()

    expect(handoffMentionSend({ text: '@剪辑助手 用这段配音剪一条 15 秒的' })).toBeNull()
    expect($handoffProposal.get()?.input).toMatchObject({
      ask: '用这段配音剪一条 15 秒的',
      previous: { files: [VOICEOVER, SCRIPT], links: [NOTE] },
      to: 'cutter'
    })
  })
})

describe('a relay plan proposed by a result', () => {
  it('「开始」 gives the first baton the reply’s files', async () => {
    relayOn()

    const container = await renderThread([
      user('t1-ask', 20, '配好音再发一篇笔记、剪一条短视频'),
      assistant(
        't1-answer',
        21,
        stored(
          '<!-- apex:plan\n' +
            '@小红书文案 | 写笔记 | 用这段配音和口播稿写一篇小红书笔记\n' +
            '@剪辑助手 | 剪成 15 秒 | 用配音和小红书文案交回的笔记剪一条 15 秒竖屏\n' +
            '-->'
        )
      )
    ])

    const plan = container.querySelector<HTMLElement>('[data-handoff-card="plan"]')!

    await act(async () => {
      fireEvent.click(within(plan).getByRole('button', { name: '开始' }))
    })

    const first = handoffById($handoffPlans.get()[0]!.batons[0]!)!

    expect(first).toMatchObject({ status: 'queued', to: 'writer' })
    expect(first.carry).toMatchObject({ files: [VOICEOVER, SCRIPT], links: [NOTE] })
    expect(handOverText(first)).toContain(CARRIED)
  })
})

describe('replyAttachments: the files of a reply as stored', () => {
  it.each([
    [
      'a standalone line, a space in the name',
      '口播稿：\nMEDIA:/Users/me/APEX/口播稿 第二版.docx',
      ['/Users/me/APEX/口播稿 第二版.docx']
    ],
    ['tags inside a sentence', '音频：MEDIA:/tmp/voice.mp3 和 MEDIA:/tmp/b.mp3', ['/tmp/voice.mp3', '/tmp/b.mp3']],
    ['a quoted tag', 'MEDIA:`/Users/me/成片 v2.mp4`', ['/Users/me/成片 v2.mp4']],
    // The link text escapes them (media.ts `mediaDisplayLabel`): `[Image: 封面\[终版\]_….png](#media:…)`.
    ['brackets in the name', 'MEDIA:/Users/me/封面[终版]_9a8b7c6d.png', ['/Users/me/封面[终版]_9a8b7c6d.png']],
    ['a Windows path', 'MEDIA:C:\\Users\\me\\成片\\开场.mp4', ['C:\\Users\\me\\成片\\开场.mp4']],
    ['a file: URL', 'MEDIA:file:///Users/me/a.mp3', ['file:///Users/me/a.mp3']],
    ['a clip on the web', 'MEDIA:https://cdn.example.com/v/a.mp4', ['https://cdn.example.com/v/a.mp4']]
  ])('%s: the file its card plays or saves', (_label, raw, files) => {
    const text = renderMediaTags(raw)

    expect(text).toContain('](#media:')
    expect(text).not.toContain('MEDIA:')
    expect(replyAttachments(text)).toEqual({ files, links: [] })
  })

  it('a file once, whether the reply links it itself or delivers it, and web links stay links', () => {
    const text = renderMediaTags(
      `[原片](/Users/me/原片.mp4) 剪好了：\nMEDIA:/Users/me/成片.mp4\nMEDIA:/Users/me/原片.mp4\n参考 ${NOTE}`
    )

    expect(replyAttachments(text)).toEqual({ files: ['/Users/me/原片.mp4', '/Users/me/成片.mp4'], links: [NOTE] })
  })
})
