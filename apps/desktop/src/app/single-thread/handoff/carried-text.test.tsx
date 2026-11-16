/**
 * hc-1253: the reply a relay (接力) carries reads as prose. Desktop stores a reply after
 * renderMediaTags (lib/chat-messages/parts.ts), so each file it delivered on a `MEDIA:` line is a
 * `[Audio: x.mp3](#media:%2F…)` link by then, and a relay plan's next baton carries what the last
 * one handed back as the engine wrote it, `MEDIA:/Users/…` and all. Both went along as they were:
 *
 * - the confirm card counted the links (329 字 for a reply of 63);
 * - the receiver's 「上一条结果」, a plain-text quote, showed the encoded path, and the next
 *   baton's showed the path itself (hc-1131: no local paths in product mode);
 * - the 交回摘要 quote showed `MEDIA:/…` when the receiver wrote no block;
 * - the receiver read `#media:` hrefs it could copy into its 交回摘要.
 *
 * Now the receiver reads 〔文件：<file name>〕 where each file was (its path is listed below the
 * quote), every quote on a card is the prose alone (the files are the chips and cards beside it)
 * and the count is what the quote shows.
 *
 * Replies are built the way Desktop stores them, through renderMediaTags, or the way the engine
 * wrote them where that is what a relay reads (a handed-back result).
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
import {
  handbackResult,
  HANDOFF_RESULT_MAX_CHARS,
  handoffCarryText,
  handoffQuoteText,
  handoffRequestText
} from '@/lib/handoff-text'
import { $authState } from '@/store/auth'
import { noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  type BotProfileRow,
  botRosterFrom,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import {
  $handoffs,
  type HandoffRecord,
  resetHandoffsForTest,
  setMultiBotHandoffFlagForTest,
  startHandoff
} from '@/store/single-thread-handoff'
import { $handoffProposal, dismissHandoffProposal } from '@/store/single-thread-handoff-confirm'
import { setToolViewMode } from '@/store/tool-view'

stubThreadEnvironment()
stubThreadViewportSize()

const ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  { name: 'writer', ui_meta: { apex: { color: 'rose', created: 1, name: '小红书文案', shape: 'squircle' } } },
  { name: 'cutter', ui_meta: { apex: { color: 'teal', created: 2, name: '剪辑助手', shape: 'cloud' } } }
]

const VOICEOVER = '/Users/me/.apexnodes/cache/audio/tts_20261115_101010.mp3'
const SCRIPT = '/Users/me/APEX/成片/口播稿 第二版_4a2ea035.docx'
const NOTE = 'https://www.xiaohongshu.com/explore/a'

/** APEX's reply as the engine wrote it: two files on `MEDIA:` lines and a link in the prose. */
const RAW = `配音和口播稿都好了，照着[这篇笔记](${NOTE})的节奏写的：\n\nMEDIA:${VOICEOVER}\n\nMEDIA:${SCRIPT}`

/** What every card quotes of it: the prose, the link its text. */
const PROSE = '配音和口播稿都好了，照着这篇笔记的节奏写的：'

/** What the receiver reads of it: each file where it was, by name. */
const CARRIED = `配音和口播稿都好了，照着[这篇笔记](${NOTE})的节奏写的：\n\n〔文件：tts_20261115_101010.mp3〕\n\n〔文件：口播稿 第二版_4a2ea035.docx〕`

/** The same reply as Desktop stores and shows it. */
function stored(block = ''): string {
  const text = renderMediaTags(block ? `${RAW}\n\n${block}` : RAW)

  // The shape under test: the files are `#media:` links, no tag is left.
  expect(text).not.toContain('MEDIA:')
  expect(text.match(/\]\(#media:/g)).toHaveLength(2)

  return text
}

/** Nothing on a card is a path, an encoded one, a tag or the receiver's file marker. */
function expectNoPath(html: string): void {
  expect(html).not.toContain('/Users/')
  expect(html).not.toContain('%2FUsers')
  expect(html).not.toContain('#media:')
  expect(html).not.toContain('MEDIA:')
  expect(html).not.toContain('〔文件')
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

function relayOn(locale: Locale, onScreen = 'default', storedId = 'chat-a'): void {
  seedShellState()
  setRuntimeI18nLocale(locale)
  setToolViewMode('product')
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(true)
  resetBotRosterForTest(botRosterFrom(ROWS, () => true))
  $activeGatewayProfile.set(onScreen)
  $activeSessionId.set(`session-${onScreen}`)
  $gatewayState.set('open')
  $authState.set({ ...$authState.get(), accountId: 'acc-1', status: 'signed-in' })
  noteMainThreadClaimed(onScreen, storedId)
  $selectedStoredSessionId.set(storedId)
}

async function renderThread(messages: ThreadMessage[], locale: Locale): Promise<HTMLElement> {
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

const quoteOf = (card: HTMLElement) => card.querySelector('p[class*="line-clamp-6"]')?.textContent ?? null

beforeEach(() => {
  localStorage.clear()
  resetMainThreadForTest()
  resetHandoffsForTest()
})

afterEach(() => {
  cleanup()
  dismissHandoffProposal()
  resetHandoffsForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  resetMainThreadForTest()
  $activeGatewayProfile.set('default')
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  setRuntimeI18nLocale('en')
  localStorage.clear()
})

afterAll(restoreRecordingTimeZone)

describe('handoffCarryText: what the receiver reads of the result', () => {
  it.each([
    ['a voiceover on its own line', `配好了：\nMEDIA:${VOICEOVER}`, '配好了：\n〔文件：tts_20261115_101010.mp3〕'],
    ['a document with a space in its name', `MEDIA:${SCRIPT}`, '〔文件：口播稿 第二版_4a2ea035.docx〕'],
    // The link text escapes them (media.ts `mediaDisplayLabel`): `[Image: 封面\[终版\]_….png](#media:…)`.
    ['brackets in the name', 'MEDIA:/Users/me/封面[终版]_9a8b7c6d.png', '〔文件：封面[终版]_9a8b7c6d.png〕'],
    ['a Windows path', 'MEDIA:C:\\Users\\me\\成片\\开场.mp4', '〔文件：开场.mp4〕'],
    ['a file: URL', 'MEDIA:file:///Users/me/%E9%85%8D%E9%9F%B3.mp3', '〔文件：配音.mp3〕'],
    [
      'tags inside a sentence',
      '音频：MEDIA:/tmp/voice.mp3 和 MEDIA:/tmp/b.mp3',
      '音频：〔文件：voice.mp3〕 和 〔文件：b.mp3〕'
    ],
    ['a quoted tag', 'MEDIA:`/Users/me/成片 v2.mp4`', '〔文件：成片 v2.mp4〕']
  ])('%s, stored or as the engine wrote it', (_label, raw, carried) => {
    const fromStored = handoffCarryText(renderMediaTags(raw))

    expect(fromStored).toEqual({ text: carried, truncated: false })
    // A relay plan's next baton carries the handed-back reply as the engine wrote it.
    expect(handoffCarryText(raw)).toEqual(fromStored)
    // 「换个办法」 carries the carried text once more (cards.tsx FailedBody).
    expect(handoffCarryText(fromStored.text)).toEqual(fromStored)
  })

  it('keeps the prose and its links; only the files the reply delivered change', () => {
    expect(handoffCarryText(stored()).text).toBe(CARRIED)
  })

  it('a link that does not decode stays as it was (replyAttachments lists no file for it either)', () => {
    expect(handoffCarryText('[Audio: a.mp3](#media:%E0%A4%A)').text).toBe('[Audio: a.mp3](#media:%E0%A4%A)')
  })

  it('the 2,000 characters are the result as carried, not its encoded links', () => {
    const prose = '字'.repeat(1_950)
    const carried = handoffCarryText(renderMediaTags(`${prose}\n\nMEDIA:${VOICEOVER}`))

    expect(carried).toEqual({ text: `${prose}\n\n〔文件：tts_20261115_101010.mp3〕`, truncated: false })
    expect([...carried.text].length).toBeLessThan(HANDOFF_RESULT_MAX_CHARS)
  })
})

describe('handoffQuoteText: what a card quotes', () => {
  it.each([
    ['the files carried', CARRIED, PROSE],
    ['a reply as stored (a hand-over sent before hc-1253 quotes it)', renderMediaTags(RAW), PROSE],
    ['a reply as the engine wrote it (a 交回摘要 with no block)', RAW, PROSE],
    ['a tag inside a sentence', '配音 MEDIA:/tmp/voice.mp3 好了', '配音  好了'],
    ['a link to a local file keeps its text', '[原片](/Users/me/原片.mp4)剪好了', '原片剪好了'],
    ['an image keeps its alt text', '封面：![封面图](/Users/me/封面.png)', '封面：封面图'],
    ['escaped brackets in a link’s text', '[第\\[2\\]版](https://example.com/b)', '第[2]版'],
    ['a reply that is only files', `MEDIA:${VOICEOVER}\n\nMEDIA:${SCRIPT}`, ''],
    [
      'prose without files stays as it is',
      '## 30 秒口播脚本\n\n1. 开头：三秒抓人\n2. 中段',
      '## 30 秒口播脚本\n\n1. 开头：三秒抓人\n2. 中段'
    ]
  ])('%s', (_label, text, quote) => {
    expect(handoffQuoteText(text)).toBe(quote)
  })
})

describe('「交给」 under a result: the confirm card, the relay card and the receiver’s card', () => {
  it.each<[Locale, string, string, string, string]>([
    [
      'zh',
      '会带上：上面那条结果（22 字）、2 个文件、1 个链接和你这句话。',
      '交给它',
      '带过去的：上面这条结果（22 字）、2 个文件、1 个链接和你这句话。',
      'APEX 上一条结果'
    ],
    [
      'en',
      'Takes the reply above (22 characters), 2 files, 1 link and what you wrote.',
      'Hand it over',
      'Took the reply above (22 characters), 2 files, 1 link and what you wrote.',
      'APEX’s last result'
    ]
  ])(
    '%s: counts and quotes the prose; the receiver reads where each file was',
    async (locale, line, confirm, took, label) => {
      relayOn(locale)

      // An id of its own: a 「下一步」 row once used stays used for that reply (next-steps.tsx `used`).
      const sender = await renderThread(
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

      fireEvent.click(sender.querySelector<HTMLElement>('[data-next-step-handoff="writer"]')!)
      expect($handoffProposal.get()?.input.previous?.text).toContain('](#media:')

      const confirmCard = sender.querySelector<HTMLElement>('[data-handoff-card="confirm"]')!

      expect(confirmCard.textContent).toContain(line)
      expectNoPath(confirmCard.outerHTML)

      fireEvent.click(within(confirmCard).getByRole('button', { name: confirm }))

      const [record] = $handoffs.get()

      const relayCard = sender.querySelector<HTMLElement>(
        `[data-handoff-card="relay"][data-handoff-id="${record!.id}"]`
      )!

      expect(relayCard.textContent).toContain(took)
      expect(record!.carry).toMatchObject({ files: [VOICEOVER, SCRIPT], links: [NOTE], text: CARRIED })

      const handover = handOverText(record!)

      expect(handover).toContain('> 〔文件：tts_20261115_101010.mp3〕\n>\n> 〔文件：口播稿 第二版_4a2ea035.docx〕')
      expect(handover).not.toContain('#media:')
      expect(handover).toContain(`里面的文件和链接：\n- ${VOICEOVER}\n- ${SCRIPT}\n- ${NOTE}`)

      cleanup()

      // The receiver's thread, with this install's record and with the hand-over message alone.
      for (const records of [[record!], []]) {
        relayOn(locale, 'writer', 'writer-root')
        resetHandoffsForTest(records)

        const receiver = await renderThread([user('w1', 30, handover)], locale)
        const received = receiver.querySelector<HTMLElement>('[data-handoff-card="received"]')!

        expect(received.textContent).toContain(label)
        expect(quoteOf(received)).toBe(PROSE)
        expect(received.querySelectorAll('[data-handoff-items] li')).toHaveLength(3)
        expectNoPath(received.outerHTML)

        cleanup()
      }
    }
  )

  it('a reply that is only files carries no 「上一条结果」: the card counts and lists the files', async () => {
    relayOn('zh')

    const sender = await renderThread(
      [
        user('only-ask', 20, '配个音'),
        assistant(
          'only-answer',
          21,
          renderMediaTags(
            `MEDIA:${VOICEOVER}\n\n<!-- apex:next\n@剪辑助手 | 剪成 15 秒 | 用这段配音剪一条 15 秒的\n-->`
          )
        )
      ],
      'zh'
    )

    fireEvent.click(sender.querySelector<HTMLElement>('[data-next-step-handoff="cutter"]')!)

    const confirmCard = sender.querySelector<HTMLElement>('[data-handoff-card="confirm"]')!

    expect(confirmCard.textContent).toContain('会带上：1 个文件和你这句话。')
  })

  it('a hand-over sent before hc-1253 (its quote has the stored links) reads the same on the receiver’s card', async () => {
    relayOn('zh', 'writer', 'writer-root')

    const before = handoffRequestText({
      ask: '写成笔记',
      carry: { text: renderMediaTags(RAW), truncated: false },
      files: [VOICEOVER, SCRIPT],
      from: 'default',
      fromName: 'APEX',
      id: 'ho_old',
      links: [NOTE]
    })

    const receiver = await renderThread([user('w1', 30, before)], 'zh')
    const received = receiver.querySelector<HTMLElement>('[data-handoff-card="received"]')!

    expect(quoteOf(received)).toBe(PROSE)
    expectNoPath(received.outerHTML)
  })
})

describe('what a relay hands back, as the engine wrote it', () => {
  /** 剪辑助手's reply with no 交回摘要 block: the summary is its opening, tags and all. */
  const BACK = `成片剪好了，30 秒，用的是这段配音。\n\nMEDIA:/Users/me/.apexnodes/cache/media/样片_竖屏_1a2b3c4d.mp4\n\n字幕要换字体跟我说。`

  function returned(id: string, over: Partial<HandoffRecord> = {}): HandoffRecord {
    const t = at(22).getTime()

    return {
      ask: '用这段配音剪一条 15 秒的',
      attempts: 1,
      baton: 1,
      cancelReason: null,
      carry: { files: [VOICEOVER], links: [], text: '〔文件：tts_20261115_101010.mp3〕', truncated: false },
      chainId: id,
      createdAt: t,
      failure: null,
      finishedAt: t + 60_000,
      from: { messageId: 'x-answer', name: 'APEX', profile: 'default', storedSessionId: 'chat-a' },
      id,
      notBefore: null,
      owner: 'acc-1',
      queueReason: null,
      result: { ...handbackResult(BACK), at: t + 60_000 },
      startedAt: t,
      status: 'returned',
      to: 'cutter',
      turn: null,
      updatedAt: t + 60_000,
      waitingFor: null,
      ...over
    }
  }

  it.each<[Locale]>([['zh'], ['en']])(
    '%s: the relay card quotes its prose; the file is the card under it',
    async locale => {
      relayOn(locale)
      resetHandoffsForTest([returned('r1')])

      // The summary as it comes back: the reply's opening with its tag (handoff-text.ts handbackResult).
      expect(returned('r1').result?.summary).toContain('MEDIA:/Users/')

      const sender = await renderThread(
        [user('x-ask', 20, '配个音'), assistant('x-answer', 21, renderMediaTags(`配好了：\n\nMEDIA:${VOICEOVER}`))],
        locale
      )

      const relayCard = sender.querySelector<HTMLElement>('[data-handoff-card="relay"][data-handoff-id="r1"]')!
      const quotes = [...relayCard.querySelectorAll('p')].map(line => line.textContent)

      expect(quotes).toContain('成片剪好了，30 秒，用的是这段配音。\n\n字幕要换字体跟我说。')
      expect(relayCard.querySelector('[data-handoff-returned-items] [data-slot="aui_result-media"]')).not.toBeNull()
      expect(relayCard.textContent).not.toContain('MEDIA:')
      expect(relayCard.textContent).not.toContain('/Users/')
    }
  )

  it('the next baton of a plan reads it with the file by name, and its card quotes the prose', async () => {
    relayOn('zh')
    // The plan's first baton: 剪辑助手 handed its clip back.
    resetHandoffsForTest([returned('b1')])

    const next = startHandoff({
      ask: '按剪好的成片写一篇小红书笔记',
      continues: 'b1',
      from: { messageId: 'x-answer', name: 'APEX', profile: 'default', storedSessionId: 'chat-a' },
      to: 'writer'
    })

    expect(next.ok).toBe(true)

    const record = next.ok ? next.handoff : null

    expect(record?.carry.text).toBe(
      '成片剪好了，30 秒，用的是这段配音。\n\n〔文件：样片_竖屏_1a2b3c4d.mp4〕\n\n字幕要换字体跟我说。'
    )

    cleanup()
    relayOn('zh', 'writer', 'writer-root')
    resetHandoffsForTest([record!])

    const receiver = await renderThread([user('w1', 40, handOverText(record!))], 'zh')
    const received = receiver.querySelector<HTMLElement>('[data-handoff-card="received"]')!

    expect(quoteOf(received)).toBe('成片剪好了，30 秒，用的是这段配音。\n\n字幕要换字体跟我说。')
    expectNoPath(received.outerHTML)
  })
})
