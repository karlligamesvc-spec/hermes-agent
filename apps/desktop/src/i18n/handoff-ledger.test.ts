/**
 * hc-1090 (多助手二期 R5): the 「最近发生的」 line a relay leaves in the memory
 * ledger — who helped whom with what, plus the 交回摘要's key point — within
 * the cloud's 100-character cap and cleaned the way the cloud cleans it.
 */
import { describe, expect, it } from 'vitest'

import {
  cleanLedgerText,
  handbackKeyPoint,
  handoffLedgerLines,
  LEDGER_ASK_MAX_CHARS,
  LEDGER_LINE_MAX_CHARS
} from './handoff-ledger'
import type { Locale } from './types'

const chars = (text: string) => [...text].length

const SOURCE = {
  ask: '把口播剪成 30 秒',
  fromName: 'APEX',
  summary: '剪好了 30 秒版本，开头换成了第 2 个镜头，字幕已烧进去。',
  toName: '剪辑'
}

describe('handoffLedgerLines', () => {
  it.each<[Locale, string, string]>([
    [
      'zh',
      '在电脑上，剪辑 帮 APEX 做完了「把口播剪成 30 秒」，交回：剪好了 30 秒版本，开头换成了第 2 个镜头，字幕已烧进去。',
      '在电脑上，剪辑 帮 APEX 做完了「把口播剪成 30 秒」'
    ],
    [
      'zh-hant',
      '在電腦上，剪辑 幫 APEX 做完了「把口播剪成 30 秒」，交回：剪好了 30 秒版本，开头换成了第 2 个镜头，字幕已烧进去。',
      '在電腦上，剪辑 幫 APEX 做完了「把口播剪成 30 秒」'
    ],
    [
      'en',
      'On the computer, 剪辑 finished "把口播剪成 30 秒" for APEX. Handed back: 剪好了 30 秒版本，开头换成了第 2 个镜头，字幕已烧进去。',
      'On the computer, 剪辑 finished "把口播剪成 30 秒" for APEX'
    ],
    [
      'ja',
      'On the computer, 剪辑 finished "把口播剪成 30 秒" for APEX. Handed back: 剪好了 30 秒版本，开头换成了第 2 个镜头，字幕已烧进去。',
      'On the computer, 剪辑 finished "把口播剪成 30 秒" for APEX'
    ]
  ])('%s: who helped whom with what, and the point', (locale, full, bare) => {
    expect(handoffLedgerLines(SOURCE, locale)).toEqual({ bare, full })
  })

  it('without a summary there is only the bare line', () => {
    const lines = handoffLedgerLines({ ...SOURCE, summary: '' }, 'zh')

    expect(lines.full).toBe(lines.bare)
    expect(lines.bare).toBe('在电脑上，剪辑 帮 APEX 做完了「把口播剪成 30 秒」')
  })

  it('a long ask is cut so the point still fits', () => {
    const ask = '把这条三分钟的口播剪成一条三十秒的短视频，开头三秒要抓人，结尾放关注引导，字幕要大'
    const lines = handoffLedgerLines({ ...SOURCE, ask }, 'zh')
    const quoted = /「(.*)」/u.exec(lines.bare)?.[1] ?? ''

    expect(chars(quoted)).toBe(LEDGER_ASK_MAX_CHARS)
    expect(quoted.endsWith('…')).toBe(true)
    expect(lines.full).toContain('，交回：剪好了 30 秒版本')
  })

  it('a long point is cut to the cap with an ellipsis', () => {
    const summary = `剪好了${'一段很长的说明'.repeat(30)}。`
    const lines = handoffLedgerLines({ ...SOURCE, summary }, 'zh')

    expect(chars(lines.full)).toBe(LEDGER_LINE_MAX_CHARS)
    expect(lines.full.endsWith('…')).toBe(true)
  })

  it.each<Locale>(['zh', 'zh-hant', 'en'])('%s: never over the cap, whatever comes in', locale => {
    const long = {
      ask: 'A'.repeat(300),
      fromName: '名'.repeat(40),
      summary: 'B'.repeat(900),
      toName: '名'.repeat(40)
    }

    const lines = handoffLedgerLines(long, locale)

    expect(chars(lines.full)).toBeLessThanOrEqual(LEDGER_LINE_MAX_CHARS)
    expect(chars(lines.bare)).toBeLessThanOrEqual(LEDGER_LINE_MAX_CHARS)
    // Names are cut to 12 like the roster's, so the line still says who.
    expect(lines.bare).toContain(`${'名'.repeat(11)}…`)
  })

  it('takes out what the cloud would take out, so the length here is the length stored', () => {
    const lines = handoffLedgerLines(
      { ask: '写【标题】\n<三个>', fromName: 'APEX', summary: '写好了　三个​标题。', toName: '标题' },
      'zh'
    )

    expect(lines.full).toBe('在电脑上，标题 帮 APEX 做完了「写标题 三个」，交回：写好了 三个 标题。')
    expect(cleanLedgerText(lines.full)).toBe(lines.full)
  })

  it('an assistant’s 分工 never goes in: only the names (hc-1082)', () => {
    const lines = handoffLedgerLines(SOURCE, 'zh')

    expect(lines.full).not.toMatch(/负责|分工|擅长/)
  })
})

describe('handbackKeyPoint', () => {
  it.each([
    ['one sentence', '剪好了 30 秒版本，字幕已烧进去。', '剪好了 30 秒版本，字幕已烧进去。'],
    ['the first of several sentences', '写好 3 个标题。第 1 个最稳！你挑一个。', '写好 3 个标题。'],
    ['a list marker and emphasis off', '- **写好 3 个标题**，第 1 个最稳。\n- 第二点', '写好 3 个标题，第 1 个最稳。'],
    ['a numbered list', '1. 封面换成了第二版\n2. 标题加了数字', '封面换成了第二版'],
    ['blank lines skipped', '\n\n  \n成片在下面', '成片在下面'],
    ['links out', '发布好了 https://www.douyin.com/video/7300000000000000000 ，去看看。', '发布好了 ，去看看。'],
    ['a MEDIA tag out', 'MEDIA:/Users/me/a.mp4 成片好了', '成片好了'],
    ['English', 'Cut the 30 s version. Subtitles are burned in.', 'Cut the 30 s version.'],
    ['a dot inside a number is not an end', 'v1.2 版本好了', 'v1.2 版本好了'],
    ['a snake_case name kept, code marks off', '改好了 `cover_v2` 和 __标题__', '改好了 cover_v2 和 标题'],
    ['empty', '', ''],
    ['only a link', 'https://example.com/a', '']
  ])('%s', (_label, summary, point) => {
    expect(handbackKeyPoint(summary)).toBe(point)
  })
})
