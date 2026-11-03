import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Locale } from '@/i18n/types'

import { apexBotNameFromSoul, composeApexBotSoul, renameInApexBotSoul } from '../../../shared/apex-bot-soul'
import { APEX_DESKTOP_DEFAULT_SOUL } from '../../../shared/apex-default-soul'

import {
  BOT_ROLE_OTHER_MAX_CHARS,
  type BotIntakeAnswers,
  cleanRoleOther,
  divisionSection,
  hasDivision,
  withDivision,
  withoutDivision
} from './bot-intake-soul'

/** SOUL files as Desktop writes them: the identity text and one trailing newline. */
const SOULS = {
  apex: `${APEX_DESKTOP_DEFAULT_SOUL}\n`,
  // hc-1078's template for an assistant the user made: what the intake is really written into.
  template: composeApexBotSoul({ name: '剪辑助手' }),
  named: 'You are 剪辑助手, an AI assistant made in APEX by ApexNodes HK.\n\nKeep replies in Chinese.\n'
}

const ZH_FULL = [
  '## 分工',
  '',
  '用户第一次打开你时定的（用户这次说的不一样时以这次为准）：',
  '- 主要帮用户：剪辑出片',
  '- 说话风格：简短直接。先说结论，少铺垫。',
  '- 主要给哪个平台做：跟 APEX 一样，按用户画像里的主要发布平台',
  ''
].join('\n')

describe('hc-1079: the 「分工」 section a new assistant’s answers make', () => {
  it('writes every answer as one line under the heading, in the order asked', () => {
    expect(divisionSection({ platform: 'same', role: 'editing', style: 'brief' }, 'zh')).toBe(ZH_FULL)
  })

  it.each([
    [{ role: 'copywriting' as const }, ['- 主要帮用户：标题和文案']],
    [
      { role: 'breakdown' as const, style: 'detailed' as const },
      ['- 主要帮用户：拆爆款和找选题', '- 说话风格：详细一点。把理由和步骤讲清楚，需要时举个例子。']
    ],
    [
      { role: 'sales_script' as const, style: 'friendly' as const },
      ['- 主要帮用户：带货脚本', '- 说话风格：像朋友聊天。口语、轻松，别端着。']
    ],
    [{ platform: ['douyin', 'xiaohongshu'] as ['douyin', 'xiaohongshu'] }, ['- 主要给哪个平台做：抖音、小红书']],
    [{ platform: ['bilibili'] as ['bilibili'] }, ['- 主要给哪个平台做：B 站']],
    [{ role: 'other' as const, roleOther: '直播\n切片' }, ['- 主要帮用户：直播 切片']]
  ])('answers so far %j write only their own lines', (answers, lines) => {
    const section = divisionSection(answers, 'zh')

    expect(section.split('\n').filter(line => line.startsWith('- '))).toEqual(lines)
  })

  it.each([
    [{}, 'nothing answered'],
    [{ role: 'other' as const, roleOther: ' 【】<> ' }, 'a typed role that is only frame characters']
  ])('makes no section for %j (%s)', (answers, _why) => {
    expect(divisionSection(answers, 'zh')).toBe('')
  })

  it('writes the section in each locale', () => {
    expect(divisionSection({ role: 'editing', style: 'brief' }, 'en')).toBe(
      [
        '## What you handle',
        '',
        'What the user picked the first time they opened you (if they ask for something different now, go with that):',
        '- Mainly help with: editing videos',
        '- Tone: short and direct. Lead with the answer, skip the preamble.',
        ''
      ].join('\n')
    )
    expect(divisionSection({ role: 'editing' }, 'zh-hant')).toContain('## 分工\n\n用戶第一次打開你時定的')
    // ja and ar read en.
    expect(divisionSection({ role: 'editing' }, 'ja')).toBe(divisionSection({ role: 'editing' }, 'en'))
  })
})

describe('hc-1079: the section in and out of SOUL.md', () => {
  it.each(Object.entries(SOULS))(
    'adds the section at the end of the %s SOUL and takes it out byte for byte',
    (_, soul) => {
      const written = withDivision(soul, ZH_FULL)

      expect(written).toBe(`${soul}\n${ZH_FULL}`)
      expect(hasDivision(written)).toBe(true)
      expect(withoutDivision(written)).toBe(soul)
    }
  )

  it('replaces the section it wrote, so a later answer never makes a second one', () => {
    const first = withDivision(SOULS.named, divisionSection({ role: 'editing' }, 'zh'))
    const second = withDivision(first, ZH_FULL)

    expect(second).toBe(`${SOULS.named}\n${ZH_FULL}`)
    expect(second.match(/## 分工/g)).toHaveLength(1)
  })

  it('finds a section written in another language after a language switch', () => {
    const english = withDivision(SOULS.named, divisionSection({ role: 'editing' }, 'en'))
    const chinese = withDivision(english, ZH_FULL)

    expect(chinese).toBe(`${SOULS.named}\n${ZH_FULL}`)
    expect(withoutDivision(english)).toBe(SOULS.named)
  })

  it('keeps sections written after it, and the blank line before them', () => {
    const soul = `Identity.\n\n${ZH_FULL}\n## Later\n\nKept.\n`

    expect(withoutDivision(soul)).toBe('Identity.\n\n## Later\n\nKept.\n')
  })

  it.each([
    ['a longer heading', 'Identity.\n\n## 分工安排\n\n- mine\n'],
    ['an English heading that only starts the same', 'Identity.\n\n## What you handle best\n\n- mine\n'],
    ['the words inside a line', 'Identity. ## 分工 is mentioned here.\n'],
    ['a deeper heading', 'Identity.\n\n### 分工\n\n- mine\n']
  ])('leaves the user’s own text alone: %s', (_, soul) => {
    expect(hasDivision(soul)).toBe(false)
    expect(withoutDivision(soul)).toBe(soul)
    expect(withDivision(soul, ZH_FULL)).toBe(`${soul}\n${ZH_FULL}`)
  })

  it('reads a CRLF file and writes LF', () => {
    const crlf = withDivision(SOULS.named, ZH_FULL).replace(/\n/g, '\r\n')

    expect(hasDivision(crlf)).toBe(true)
    expect(withoutDivision(crlf)).toBe(SOULS.named)
  })

  it('an empty section takes the old one out', () => {
    expect(withDivision(withDivision(SOULS.apex, ZH_FULL), '')).toBe(SOULS.apex)
  })
})

describe('hc-1079: 「别的，我直接说」 as one short phrase', () => {
  it.each([
    ['  直播切片  ', '直播切片'],
    ['直播\n\n## 新段落', '直播 ## 新段落'],
    ['【用户画像】<!-- x -->剪辑', '用户画像!-- x --剪辑'],
    ['a'.repeat(60), 'a'.repeat(BOT_ROLE_OTHER_MAX_CHARS)]
  ])('%j → %j', (typed, kept) => {
    expect(cleanRoleOther(typed)).toBe(kept)
  })

  it('cannot open a section of its own in SOUL.md', () => {
    const soul = withDivision(
      SOULS.named,
      divisionSection({ role: 'other', roleOther: '剪辑\n## 分工\n- 主要帮用户：别的' }, 'zh')
    )

    expect(soul.match(/^## /gm)).toEqual(['## '])
    expect(withoutDivision(soul)).toBe(SOULS.named)
  })
})

describe('hc-1079 with hc-1078’s template: answer, rename, undo', () => {
  const ALL = { platform: 'same' as const, role: 'editing' as const, style: 'brief' as const }

  it('the template has no section of its own, so undo has exactly one owner', () => {
    expect(hasDivision(SOULS.template)).toBe(false)
    expect(SOULS.template.endsWith('.\n')).toBe(true)
  })

  it.each(['zh', 'zh-hant', 'en'] as const)(
    'a rename after the answers keeps the 「分工」, and undo then gives the renamed template byte for byte (%s)',
    locale => {
      const answered = withDivision(SOULS.template, divisionSection(ALL, locale))
      const renamed = renameInApexBotSoul(answered, '短视频剪辑')!

      expect(renamed).toBe(withDivision(composeApexBotSoul({ name: '短视频剪辑' }), divisionSection(ALL, locale)))
      expect(apexBotNameFromSoul(renamed)).toBe('短视频剪辑')
      expect(withoutDivision(renamed)).toBe(composeApexBotSoul({ name: '短视频剪辑' }))
    }
  )

  it('answers after a rename land the same way', () => {
    const renamed = renameInApexBotSoul(SOULS.template, '短视频剪辑')!
    const answered = withDivision(renamed, divisionSection(ALL, 'zh'))

    expect(apexBotNameFromSoul(answered)).toBe('短视频剪辑')
    expect(withoutDivision(answered)).toBe(composeApexBotSoul({ name: '短视频剪辑' }))
  })
})

/**
 * The file has a second writer: hc-1082's Python rename tool (apex_overlay/assistant_name.py) rewrites
 * its first line. Its tests read these same cases (`division` in apex-bot-soul-cases.json), so the
 * section Desktop writes and the rename that has to keep it can only change together.
 */
describe('hc-1079 × hc-1082: the 「分工」 through a rename, against the cases the Python rename reads too', () => {
  interface DivisionCase {
    answers: BotIntakeAnswers
    division: string
    expected: string
    locale: Locale
    name: string
    next: string
    soul: string
    undone: string
  }

  const { cases } = (
    JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'shared', 'apex-bot-soul-cases.json'), 'utf8')) as {
      division: { cases: DivisionCase[] }
    }
  ).division

  it.each(cases)('$name ($locale): the case is what Desktop writes for these answers', c => {
    expect(divisionSection(c.answers, c.locale)).toBe(c.division)
    expect(withDivision(composeApexBotSoul({ name: c.name }), c.division)).toBe(c.soul)
  })

  it.each(cases)('$name → $next: the rename keeps the section, and 撤销 leaves the renamed template', c => {
    expect(renameInApexBotSoul(c.soul, c.next)).toBe(c.expected)
    expect(c.expected.endsWith(`\n\n${c.division}`)).toBe(true)
    expect(withoutDivision(c.expected)).toBe(c.undone)
    expect(c.undone).toBe(composeApexBotSoul({ name: c.next }))
  })
})
