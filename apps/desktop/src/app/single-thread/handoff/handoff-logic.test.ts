/**
 * hc-1087 (多助手二期 R2): the relay screens' own rules, without rendering —
 * what each assistant handles (read like the engine reads it), what an `@`
 * names, what goes along, where a card sits, what a hand-over says, and the
 * sidebar's line.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SINGLE_THREAD_HANDOFF_COPY } from '@/i18n/single-thread-handoff'
import { composeHandoffRequest } from '@/lib/handoff-text'
import { $composerDraft, setComposerDraft } from '@/store/composer'
import { $mainThread, noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $messages, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  $botRoster,
  type BotProfileRow,
  botRosterFrom,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'
import { type HandoffRecord, resetHandoffsForTest, setMultiBotHandoffFlagForTest } from '@/store/single-thread-handoff'
import { $handoffProposal, confirmHandoffProposal, dismissHandoffProposal } from '@/store/single-thread-handoff-confirm'
import { setToolViewMode } from '@/store/tool-view'

import { handoffCandidates, handoffRoleLine } from './composer-at'
import { handoffMention, handoffMentionSend, lastReply, mentionPrevious } from './mention'
import { parseHandoffRequest } from './request-view'
import { $botRoles, refreshBotRoles, resetBotRolesForTest, soulRole } from './roles'
import { handoffRowLine } from './row-line'
import { $handoffSlotItems, $handoffThreadProfile, type HandoffSlotItem, rowSlotKeys, slotIndex } from './slots'

interface Cases {
  division: { cases: { about: string; division: { role: null | string }; soul: string }[] }
  request: {
    cases: {
      about: string
      input: {
        ask: string
        files: string[]
        from: string
        from_name: string
        id: string
        links: string[]
        result: null | string
      }
      text: string
    }[]
  }
}

const CASES = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', '..', 'shared', 'apex-handoff-cases.json'), 'utf8')
) as Cases

const ROWS: BotProfileRow[] = [
  { is_default: true, name: 'default' },
  { name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } },
  { name: 'cutter', ui_meta: { apex: { created: 2, name: '剪辑助手' } } },
  { name: 'short', ui_meta: { apex: { created: 3, name: '小红' } } }
]

function relayOn(on = true): void {
  setToolViewMode('product')
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  setMultiBotHandoffFlagForTest(on)
  resetBotRosterForTest(botRosterFrom(ROWS, () => true))
}

const reply = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  parts: [{ text, type: 'text' as const }],
  role: 'assistant' as const,
  ...extra
})

function record(id: string, over: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    ask: '按这个选题写 3 个标题',
    attempts: 1,
    baton: 1,
    cancelReason: null,
    carry: { files: [], links: [], text: '选题', truncated: false },
    chainId: id,
    createdAt: 1_000,
    failure: null,
    finishedAt: null,
    from: { messageId: null, name: 'APEX', profile: 'default', storedSessionId: 'chat-a' },
    id,
    notBefore: null,
    queueReason: null,
    result: null,
    startedAt: 1_000,
    status: 'running',
    to: 'writer',
    turn: null,
    updatedAt: 1_000,
    waitingFor: null,
    ...over
  }
}

beforeEach(() => {
  localStorage.clear()
  resetHandoffsForTest()
  resetMainThreadForTest()
  resetBotRolesForTest()
})

afterEach(() => {
  dismissHandoffProposal()
  resetHandoffsForTest()
  setMultiBotHandoffFlagForTest(false)
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetBotRosterForTest()
  resetMainThreadForTest()
  $messages.set([])
  $selectedStoredSessionId.set(null)
  $activeGatewayProfile.set('default')
  setComposerDraft('')
  localStorage.clear()
})

describe('soulRole: the 「分工」 role, read the way the engine reads it (cases `division`)', () => {
  it.each(CASES.division.cases.map(c => [c.about, c] as const))('%s', (_about, c) => {
    expect(soulRole(c.soul)).toBe(c.division.role)
  })
})

describe('refreshBotRoles', () => {
  it('reads each SOUL at most once a minute and keeps a role through a failed read', async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) =>
      params?.name === 'cutter' ? { soul: '## 分工\n\n- 主要帮用户：剪辑出片\n' } : { soul: 'You are APEX.' }
    )

    await refreshBotRoles(request as never, ['default', 'cutter'])
    await refreshBotRoles(request as never, ['default', 'cutter'])

    expect(request).toHaveBeenCalledTimes(2)
    expect($botRoles.get().cutter?.role).toBe('剪辑出片')
    expect($botRoles.get().default?.role).toBeNull()

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 61_000)
    await refreshBotRoles((async () => Promise.reject(new Error('down'))) as never, ['cutter'])
    vi.useRealTimers()

    expect($botRoles.get().cutter?.role).toBe('剪辑出片')
  })
})

describe('the @ list', () => {
  it('lists every other assistant whose name holds the query', () => {
    relayOn()

    const roster = $botRoster.get()

    expect(handoffCandidates(roster, 'default', '').map(bot => bot.profile)).toEqual(['writer', 'cutter', 'short'])
    expect(handoffCandidates(roster, 'writer', '小红').map(bot => bot.profile)).toEqual(['short'])
    expect(handoffCandidates(roster, 'writer', 'ap').map(bot => bot.profile)).toEqual(['default'])
  })

  it('says what each one handles, APEX everything, and that a busy one queues', () => {
    relayOn()

    const [apex, writer] = $botRoster.get()
    const copy = SINGLE_THREAD_HANDOFF_COPY.en

    expect(handoffRoleLine(apex!, null, false)).toBe(copy.apexRole)
    expect(handoffRoleLine(writer!, '写标题和文案', false)).toBe('写标题和文案')
    expect(handoffRoleLine(writer!, null, true)).toBe(`${copy.noRole} · ${copy.busyHint}`)
  })
})

describe('handoffMention: what an @ names', () => {
  beforeEach(() => relayOn())

  it.each([
    ['at the start', '@小红书文案 按这个选题写 3 个标题', 'writer', '按这个选题写 3 个标题'],
    ['the longest name wins', '@小红书文案，写标题', 'writer', '写标题'],
    ['the short name alone', '@小红 写标题', 'short', '写标题'],
    ['after a space, mid-sentence', '帮我 @剪辑助手 剪成 30 秒', 'cutter', '帮我 剪成 30 秒'],
    ['full-width at', '＠剪辑助手 剪成 30 秒', 'cutter', '剪成 30 秒'],
    ['any case', '@apex 再挑一个', 'default', '再挑一个'],
    ['a name with nothing after it', '@剪辑助手', 'cutter', '']
  ])('%s', (_label, text, profile, ask) => {
    const self = profile === 'default' ? 'writer' : 'default'

    expect(handoffMention(text, $botRoster.get(), self)).toMatchObject({ ask, bot: { profile } })
  })

  it.each([
    ['the assistant itself', '@APEX 再挑一个', 'default'],
    ['an email address', 'kael@小红书文案.com', 'default'],
    ['a name glued to more letters', '@小红书文案们 写标题', 'writer'],
    ['no at', '小红书文案 写标题', 'default']
  ])('names nobody: %s', (_label, text, self) => {
    expect(handoffMention(text, $botRoster.get(), self)).toBeNull()
  })
})

describe('what goes along (L4)', () => {
  it('the last finished reply, its files and links, and the files attached to the send', () => {
    const messages = [
      reply('a1', '旧的'),
      { id: 'u1', parts: [{ text: '再来', type: 'text' as const }], role: 'user' as const },
      reply('a2', '挑好了：不打孔。MEDIA:/Users/me/a.mp4 看 https://xhs.example/x\n\n<!-- apex:next\n写标题 | 写\n-->'),
      reply('a3', '', { pending: true })
    ]

    const last = lastReply(messages as never)

    expect(last?.id).toBe('a2')
    expect(last?.text).not.toContain('apex:next')

    expect(
      mentionPrevious(last, [
        { id: 'f', kind: 'file', label: '素材', path: '/Users/me/素材' },
        { detail: 'https://douyin.example/v', id: 'u', kind: 'url', label: 'v' }
      ])
    ).toEqual({
      files: ['/Users/me/素材', '/Users/me/a.mp4'],
      links: ['https://douyin.example/v', 'https://xhs.example/x'],
      text: last!.text
    })
  })

  it('nothing at all on an empty thread', () => {
    expect(lastReply([])).toBeNull()
    expect(mentionPrevious(null)).toBeNull()
  })
})

describe('handoffMentionSend: the composer middleware', () => {
  function inApexThread(): void {
    relayOn()
    noteMainThreadClaimed('default', 'chat-a')
    $selectedStoredSessionId.set('chat-a')
    $messages.set([reply('a1', '挑好了：租房党衣柜改造，不打孔')] as never)
  }

  it('turns a send naming another assistant into the confirm card, keeping the text until 「交给它」', () => {
    inApexThread()
    setComposerDraft('@小红书文案 写 3 个标题')

    expect(handoffMentionSend({ text: '@小红书文案 写 3 个标题' })).toBeNull()
    expect($handoffProposal.get()).toMatchObject({
      input: {
        ask: '写 3 个标题',
        from: { messageId: 'a1', profile: 'default', storedSessionId: 'chat-a' },
        previous: { files: [], links: [], text: '挑好了：租房党衣柜改造，不打孔' },
        to: 'writer'
      },
      origin: 'mention'
    })
    expect($composerDraft.get()).toBe('@小红书文案 写 3 个标题')

    confirmHandoffProposal()

    expect($composerDraft.get()).toBe('')
  })

  it.each([
    ['relay off', () => setMultiBotHandoffFlagForTest(false)],
    ['an earlier conversation on screen', () => $selectedStoredSessionId.set('old-chat')],
    ['an assistant switch still landing', () => $activeGatewayProfile.set('writer')]
  ])('passes the send through untouched: %s', (_label, change) => {
    inApexThread()
    change()

    const draft = { text: '@小红书文案 写 3 个标题' }

    expect(handoffMentionSend(draft)).toBe(draft)
    expect($handoffProposal.get()).toBeNull()
  })

  it('passes through a send that names nobody', () => {
    inApexThread()

    const draft = { text: '再挑一个' }

    expect(handoffMentionSend(draft)).toBe(draft)
  })

  it('works on the empty thread too (no thread yet)', () => {
    relayOn()
    $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'absent', tipId: null })

    expect(handoffMentionSend({ text: '@剪辑助手 剪一条 15 秒' })).toBeNull()
    expect($handoffProposal.get()?.input).toMatchObject({ ask: '剪一条 15 秒', previous: null, to: 'cutter' })
  })
})

describe('slots: where each card sits', () => {
  const at = (minutes: number) => new Date(2026, 9, 28, 14, minutes)

  const messages = [
    { content: [{ text: '挑个选题', type: 'text' }], createdAt: at(0), id: 'u1', role: 'user' },
    { content: [{ text: '挑好了', type: 'text' }], createdAt: at(1), id: 'a1', role: 'assistant' },
    {
      content: [{ text: '<!-- apex:handoff v=1 id=ho_in from=cutter -->\n【剪辑助手 交来的活】', type: 'text' }],
      createdAt: at(5),
      id: 'u2',
      role: 'user'
    },
    { content: [{ text: '写好了', type: 'text' }], createdAt: at(6), id: 'a2', role: 'assistant' }
  ]

  const item = (over: Partial<HandoffSlotItem>): HandoffSlotItem => ({
    at: at(2).getTime(),
    headerId: null,
    id: 'x',
    key: 'k',
    kind: 'sent',
    messageId: null,
    tail: false,
    ...over
  })

  it.each([
    ['after the reply it carried', item({ messageId: 'a1' }), 1],
    ['by time when that reply is not loaded', item({ messageId: 'gone', at: at(5).getTime() + 1 }), 2],
    ['not at all when older than the first loaded message', item({ at: at(0).getTime() - 1 }), -1],
    ['the confirm card and a queued relay: after the last message', item({ tail: true }), 3],
    ['「已交回」: after the hand-over that named it', item({ headerId: 'ho_in' }), 2],
    ['「已交回」 of a hand-over not in the transcript: nowhere', item({ headerId: 'other' }), -1]
  ])('%s', (_label, slot, index) => {
    expect(slotIndex(messages, slot)).toBe(index)
  })

  it('a turn row holds the cards placed on any of its messages, in order', () => {
    const items = [
      item({ key: 'a', messageId: 'a1' }),
      item({ key: 'b', tail: true }),
      item({ key: 'c', messageId: 'u1' })
    ]

    expect(rowSlotKeys(messages, items, [0, 1])).toBe('a\nc')
    expect(rowSlotKeys(messages, items, [2, 3])).toBe('b')
    expect(rowSlotKeys(messages, [], [0, 1])).toBe('')
  })

  it('holds items only in an assistant’s own thread while relay is on', () => {
    relayOn()
    noteMainThreadClaimed('default', 'chat-a')
    $selectedStoredSessionId.set('chat-a')
    resetHandoffsForTest([
      record('mine'),
      record('in', {
        from: { messageId: null, name: '剪辑助手', profile: 'cutter', storedSessionId: null },
        status: 'queued',
        to: 'default'
      }),
      record('back', {
        from: { messageId: null, name: '剪辑助手', profile: 'cutter', storedSessionId: null },
        status: 'returned',
        to: 'default'
      }),
      record('others', {
        from: { messageId: null, name: '剪辑助手', profile: 'cutter', storedSessionId: null },
        to: 'writer'
      })
    ])

    expect($handoffThreadProfile.get()).toBe('default')
    expect($handoffSlotItems.get().map(slot => [slot.kind, slot.id])).toEqual([
      ['sent', 'mine'],
      ['incoming', 'in'],
      ['handed_back', 'back']
    ])

    $selectedStoredSessionId.set('old-chat')
    expect($handoffSlotItems.get()).toEqual([])

    $selectedStoredSessionId.set('chat-a')
    setMultiBotHandoffFlagForTest(false)
    expect($handoffSlotItems.get()).toEqual([])

    setMultiBotHandoffFlagForTest(true)
    setToolViewMode('technical')
    expect($handoffSlotItems.get()).toEqual([])
    setToolViewMode('product')
  })
})

describe('parseHandoffRequest: a hand-over read back (cases `request`)', () => {
  it.each(CASES.request.cases.map(c => [c.about, c] as const))('%s', (_about, c) => {
    const view = parseHandoffRequest(c.text)

    expect(view?.fromName).toBe(c.input.from_name.replace(/\s+/g, ' ').trim())
    expect(view?.ask).toBe(
      c.input.ask
        .replace(/\r\n?/g, '\n')
        .replace(/^(?:[ \t]*\n)+/, '')
        .replace(/\s+$/, '')
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
    )
    expect(view?.items).toEqual(
      [...c.input.files, ...c.input.links]
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, 20)
    )
  })

  it('reads what composeHandoffRequest writes', () => {
    const text = composeHandoffRequest({
      ask: '剪成 30 秒',
      files: ['/Users/me/a.mp4'],
      from: 'default',
      fromName: 'APEX',
      id: 'h1',
      links: [],
      result: '选题：不打孔'
    })

    expect(parseHandoffRequest(text)).toEqual({
      ask: '剪成 30 秒',
      fromName: 'APEX',
      items: ['/Users/me/a.mp4'],
      previous: '选题：不打孔',
      truncated: false
    })
  })

  it('null for any other message', () => {
    expect(parseHandoffRequest('帮我挑个选题')).toBeNull()
  })
})

describe('handoffRowLine: the sidebar line', () => {
  const copy = SINGLE_THREAD_HANDOFF_COPY.zh

  it('the receiver helps, then waits on the user; the sender waits for it while quiet', () => {
    relayOn()

    const roster = $botRoster.get()
    const running = [record('r1')]

    const waiting = [
      record('r1', { status: 'waiting', waitingFor: { kind: 'clarify', question: '?', requestId: 'q' } })
    ]

    expect(handoffRowLine('writer', 'working', running, roster, copy)).toBe('在帮 APEX：按这个选题写 3 个标题')
    expect(handoffRowLine('writer', 'waiting', waiting, roster, copy)).toBe('在等你决定（APEX 交来的活）')
    expect(handoffRowLine('default', 'idle', running, roster, copy)).toBe('等小红书文案交回')
    expect(handoffRowLine('default', 'working', running, roster, copy)).toBeNull()
    expect(handoffRowLine('cutter', 'idle', running, roster, copy)).toBeNull()
    expect(handoffRowLine('default', 'idle', [record('r1', { status: 'returned' })], roster, copy)).toBeNull()
  })
})
