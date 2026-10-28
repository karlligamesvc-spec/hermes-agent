/**
 * hc-1087: the relay markers (apex:handback, apex:handoff) leave every plain-text exit the way the
 * 「下一步」 block does (hard rule 12). The cases come from hc-1088's shared file, so a format change on
 * the engine's side turns these red too; the census at the end pins which files are the exits.
 * hc-1091: a relay plan (apex:plan, its own shared file) goes the same way.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { stripNextStepBlocks } from './next-steps'
import {
  createReplyMarkersSpeechFilter,
  visiblePreviewText,
  visibleReplyText,
  withoutHandoffHeader,
  withVisiblePreviews,
  withVisibleSnippets
} from './reply-markers'

interface Cases {
  handback: { cases: { about: string; reply: string; visible: string }[] }
  request: { cases: { about: string; text: string }[] }
  request_header: { cases: { request: { from: string; id: string } | null; text: string }[] }
}

const CASES = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'shared', 'apex-handoff-cases.json'), 'utf8')
) as Cases

const PLAN_CASES = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'shared', 'apex-handoff-plan-cases.json'), 'utf8')
) as { cases: { name: string; text: string; visible: string }[] }

const PLAN_REPLY =
  '选题定了：租房党衣柜改造。\n\n<!-- apex:plan\n已有 | 定选题\n@小红书文案 | 写标题 | 写 3 个标题\n-->\n\n' +
  '<!-- apex:next\n再挑一个 | 换一个选题\n-->'

describe('visibleReplyText: the 交回摘要 goes like the 「下一步」 block', () => {
  // The handback reader leaves a 「下一步」 block alone; a reader's exit drops that too.
  it.each(CASES.handback.cases.map(c => [c.about, c] as const))('%s', (_about, c) => {
    expect(visibleReplyText(c.reply)).toBe(stripNextStepBlocks(c.visible))
  })

  it('takes out both blocks of one reply', () => {
    const reply = '写好了 3 个标题。\n\n<!-- apex:next\n再写 3 个 | 再写 3 个\n-->\n\n<!-- apex:handback\n3 个标题\n-->'

    expect(visibleReplyText(reply)).toBe('写好了 3 个标题。')
  })

  it.each([
    ['plain text', '先拍衣柜塞满的样子 3 秒。'],
    ['a 「下一步」 block only', '好。\n\n<!-- apex:next\n写标题 | 写 3 个标题\n-->'],
    ['another HTML comment', '好 <!-- note --> 了'],
    ['the word in prose', '交回摘要用 apex:handback 写']
  ])('is the 「下一步」 reading when there is no relay marker: %s', (_label, text) => {
    expect(visibleReplyText(text)).toBe(stripNextStepBlocks(text))
  })
})

describe('visibleReplyText: a relay plan goes like the 「下一步」 block (hc-1091)', () => {
  it.each(PLAN_CASES.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(visibleReplyText(c.text)).toBe(stripNextStepBlocks(c.visible))
  })

  it('takes out the plan and the 「下一步」 block of one reply', () => {
    expect(visibleReplyText(PLAN_REPLY)).toBe('选题定了：租房党衣柜改造。')
  })
})

describe('withoutHandoffHeader: the hand-over header never reads as text', () => {
  const valid = CASES.request_header.cases.filter(c => c.request && !c.text.startsWith('>'))

  it.each(valid.map(c => [JSON.stringify(c.text), c.text] as const))('%s', (_label, text) => {
    const out = withoutHandoffHeader(text)

    expect(out).not.toContain('apex:handoff')
    expect(out.trim()).toBe(text.replace(/<!--\s*apex:handoff[^\n]*-->[ \t]*\r?\n?/, '').trim())
  })

  it.each(CASES.request.cases.map(c => [c.about, c.text] as const))('a whole hand-over message: %s', (_about, text) => {
    const out = withoutHandoffHeader(text)

    expect(out.startsWith('【')).toBe(true)
    expect(out).toBe(text.slice(text.indexOf('\n') + 1))
  })

  it('a header after the gateway’s own note and a blank line (R3 request_header) goes too; the note stays', () => {
    expect(
      withoutHandoffHeader('（用户点了 ❤️）\n\n<!-- apex:handoff v=1 id=h1 from=default -->\n【APEX 交来的活】')
    ).toBe('（用户点了 ❤️）\n\n【APEX 交来的活】')
  })

  it.each([
    ['in a quote', '> <!-- apex:handoff v=1 id=h1 from=default -->'],
    ['mid-paragraph', '你好\n<!-- apex:handoff v=1 id=h1 from=default -->'],
    ['another marker', '<!-- apex:handoffs v=1 id=h1 from=default -->'],
    ['no marker', '这周想做收纳']
  ])('leaves a message alone: %s', (_label, text) => {
    expect(withoutHandoffHeader(text)).toBe(text)
  })
})

describe('createReplyMarkersSpeechFilter: streamed speech never hears a block', () => {
  const reply =
    '写好了 3 个标题，第 2 个最短。\n\n<!-- apex:next\n再写 3 个 | 再写 3 个\n-->\n\n<!-- apex:handback\n3 个标题\n文件：/Users/me/a.mp4\n-->'

  it.each([1, 2, 3, 7, 50])('in deltas of %s characters', size => {
    const filter = createReplyMarkersSpeechFilter()
    let spoken = ''

    for (let index = 0; index < reply.length; index += size) {
      spoken += filter.push(reply.slice(index, index + size))
    }

    spoken += filter.flush()

    expect(spoken).not.toMatch(/apex:|<!-|-->/)
    expect(spoken.trim()).toBe('写好了 3 个标题，第 2 个最短。')
  })

  it.each([1, 2, 3, 7, 50])('a relay plan, in deltas of %s characters (hc-1091)', size => {
    const filter = createReplyMarkersSpeechFilter()
    let spoken = ''

    for (let index = 0; index < PLAN_REPLY.length; index += size) {
      spoken += filter.push(PLAN_REPLY.slice(index, index + size))
    }

    spoken += filter.flush()

    expect(spoken).not.toMatch(/apex:|<!-|-->/)
    expect(spoken.trim()).toBe('选题定了：租房党衣柜改造。')
  })

  it('drops an unfinished plan when the reply ends (hc-1091)', () => {
    const cut = createReplyMarkersSpeechFilter()

    expect(cut.push('排好了。<!-- apex:plan\n@剪辑助手 | 剪') + cut.flush()).toBe('排好了。')
  })

  it('drops an unfinished block when the reply ends, and keeps text that only looked like one', () => {
    const cut = createReplyMarkersSpeechFilter()

    expect(cut.push('好了。<!-- apex:handba') + cut.flush()).toBe('好了。')

    const plain = createReplyMarkersSpeechFilter()

    expect(plain.push('a < b，') + plain.push('<!-- 备注 -->') + plain.flush()).toBe('a < b，<!-- 备注 -->')
  })
})

describe('visiblePreviewText: one-line previews and search snippets', () => {
  it.each([
    [
      'a session opening with a hand-over',
      '<!-- apex:handoff v=1 id=ho_1 from=default --> 【APEX 交来的活】 要你做： > 写 3 个标题',
      '【APEX 交来的活】 要你做： > 写 3 个标题'
    ],
    [
      'a snippet cut inside the header',
      'apex:handoff v=1 id=ho_1 from=default --> 【APEX 交来的活】',
      '【APEX 交来的活】'
    ],
    ['a preview cut inside a block', '写好了 <!-- apex:handback 3 个标题，第 2 个...', '写好了'],
    ['a 「下一步」 block', '好。 <!-- apex:next 写标题 | 写 3 个标题 -->', '好。'],
    ['a relay plan (hc-1091)', '排好了。 <!-- apex:plan 已有 | 选题 @剪辑助手 | 剪片 | 剪成竖屏 -->', '排好了。'],
    ['a snippet cut inside a plan (hc-1091)', 'apex:plan @剪辑助手 | 剪片 | 剪成竖屏 --> 排好了', '排好了']
  ])('%s', (_label, text, expected) => {
    expect(visiblePreviewText(text)).toBe(expected)
  })

  it('hands back the very rows and response when nothing carries a marker', () => {
    const rows = [
      { id: 'a', preview: '帮我挑个选题' },
      { id: 'b', preview: null }
    ]

    const response = { results: [{ snippet: '>>>收纳<<< 选题' }] }

    expect(withVisiblePreviews(rows)).toBe(rows)
    expect(withVisibleSnippets(response)).toBe(response)
  })

  it('reads only the rows that carry one', () => {
    const plain = { id: 'a', preview: '帮我挑个选题' }

    const out = withVisiblePreviews([
      plain,
      { id: 'b', preview: '<!-- apex:handoff v=1 id=h from=default --> 【APEX 交来的活】' }
    ])

    expect(out[0]).toBe(plain)
    expect(out[1]!.preview).toBe('【APEX 交来的活】')
  })
})

// ── the exits census (hard rule 12) ──────────────────────────────────────────

const SRC = join(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      return name === 'node_modules' || name.startsWith('__') ? [] : sources(path)
    }

    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

/** Every exit that shows, copies, speaks or announces message text, and how it drops the markers. */
const EXITS: Record<string, string> = {
  'api/sessions.ts': 'withVisiblePreviews(', // session previews (sidebar, history, palette, slash list)
  'app/chat/composer/hooks/use-composer-voice.ts': 'visibleReplyText(', // the live voice model's history
  'app/session/hooks/use-message-stream/index.ts': 'visibleReplyText(', // the turn-done notification
  'app/tasks/task-model.ts': 'visibleReplyText(', // a task's last answer
  'components/assistant-ui/thread/assistant-message.tsx': 'visibleReplyText(', // copy and read-aloud
  'components/assistant-ui/thread/user-message.tsx': 'withoutHandoffHeader(', // the user bubble, edit and restore
  'lib/markdown-preprocess.ts': 'visibleReplyText(', // every rendered reply
  'lib/speech-text.ts': 'visibleReplyText(', // read-aloud, auto-speak, the voice conversation
  'lib/voice-playback.ts': 'createReplyMarkersSpeechFilter(', // streamed speech
  'store/single-thread-presence.ts': 'visibleReplyText(' // the sidebar row's last line
}

describe('the exits census', () => {
  it.each(Object.entries(EXITS))('%s drops the markers with %s', (file, call) => {
    expect(readFileSync(join(SRC, file), 'utf8')).toContain(call)
  })

  it('no other file strips only the 「下一步」 block (a new exit goes through reply-markers.ts and joins the list)', () => {
    const allowed = new Set(['lib/next-steps.ts', 'lib/reply-markers.ts', 'lib/handoff-text.ts'])

    const direct = sources(SRC)
      .map(path => relative(SRC, path))
      .filter(file => !allowed.has(file))
      .filter(file =>
        /\b(?:stripNextStepBlocks|createNextStepsSpeechFilter)\(/.test(readFileSync(join(SRC, file), 'utf8'))
      )

    expect(direct).toEqual([])
  })
})
