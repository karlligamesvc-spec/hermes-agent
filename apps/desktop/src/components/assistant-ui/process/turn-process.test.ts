import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n'

import { buildTurnProcess, stepChain, type TurnPart, wholeSeconds } from './turn-process'
import { turnAnchor, turnBounds } from './turn-state'

// hc-973: how a turn's calls fold into the steps the process area shows.

const call = (id: string, toolName: string, args: Record<string, unknown> = {}, extra: Partial<TurnPart> = {}) =>
  ({ args, toolCallId: id, toolName, type: 'tool-call', ...extra }) as TurnPart

const done = (id: string, toolName: string, args: Record<string, unknown> = {}, result: unknown = { ok: true }) =>
  call(id, toolName, args, { result })

const text = (value: string): TurnPart => ({ text: value, type: 'text' })

beforeEach(() => setRuntimeI18nLocale('zh'))
afterEach(() => setRuntimeI18nLocale('en'))

describe('steps', () => {
  it('folds consecutive calls of one tool into one step, in order', () => {
    const process = buildTurnProcess(
      [
        done('a', 'social_search', { query: '懒人好物' }, { data: { items: [1, 2, 3] } }),
        done('b', 'social_search', { query: '厨房收纳' }, { data: { items: [1, 2] } }),
        done('c', 'web_search', { query: '收纳' }, { results: [{ title: '一', url: 'https://example.cn/1' }] })
      ],
      false
    )

    expect(process.steps.map(step => step.toolName)).toEqual(['social_search', 'web_search'])
    expect(process.steps[0].facts).toMatchObject({ calls: 2, count: 5, query: '懒人好物' })
    expect(process.steps[0].sources.queries).toEqual(['懒人好物', '厨房收纳'])
  })

  it('treats finding tools and loading skills as preparation, not steps', () => {
    const process = buildTurnProcess(
      [
        done('s', 'tool_search', { queries: ['下载'] }),
        done('d', 'tool_describe', { names: ['下载'] }),
        done('k', 'skill_view', { name: 'apexnodes/video-script-breakdown' }),
        done('v', 'social_download', { url: 'https://v.douyin.com/x/' })
      ],
      false
    )

    expect(process.steps.map(step => step.toolName)).toEqual(['social_download'])
    expect(process.steps[0].prep.map(prep => prep.toolName)).toEqual(['tool_search', 'tool_describe', 'skill_view'])
    expect(process.skills).toEqual(['视频脚本拆解'])
  })

  it('leaves an unnamed skill out of the methods rather than showing its slug', () => {
    const process = buildTurnProcess([done('k', 'skill_view', { name: 'a-skill-nobody-named-yet' })], false)

    expect(process.skills).toEqual([])
    expect(process.prepOnly).toHaveLength(1)
  })

  it('resolves a reloaded tool_call bridge to the tool that ran', () => {
    const process = buildTurnProcess(
      [
        done('b', 'tool_call', {
          calls: [{ arguments: { platform: 'douyin', query: '猫粮' }, name: 'social_search' }]
        }),
        done('m', 'tool_call', {
          calls: [
            { arguments: {}, name: 'social_search' },
            { arguments: {}, name: 'web_search' }
          ]
        })
      ],
      false
    )

    expect(process.steps[0]).toMatchObject({ facts: { platform: '抖音', query: '猫粮' }, toolName: 'social_search' })
    // A batch of different tools has no one name: it reads as plain work.
    expect(process.steps[1].toolName).toBe('tool_call')
    expect(process.steps[1].facts.calls).toBe(2)
  })

  it('keeps conversation cards, notes to other assistants and bookkeeping out of the steps', () => {
    const delivery = 'hermes -p helper chat --in ~ -c "Bot Chat" -Q -q "Message from 🤖 小助手 (@apex): 你好"'

    const process = buildTurnProcess(
      [
        done('q', 'clarify', { question: '要哪种？' }),
        done('t', 'todo', { todos: [] }),
        done('m', 'terminal', { command: delivery }),
        done('i', 'image_generate', { prompt: '收纳架' })
      ],
      false
    )

    // An image is work the user asked for: a step, though its card stays put.
    expect(process.steps.map(step => step.toolName)).toEqual(['image_generate'])
  })
})

describe('facts', () => {
  it('reads a download the way a creator would describe it', () => {
    const [step] = buildTurnProcess(
      [
        done(
          'v',
          'social_download',
          { url: '复制打开抖音 https://v.douyin.com/abc/ 看看' },
          {
            duration_seconds: 103,
            platform: 'douyin',
            share_url: 'https://www.douyin.com/video/1',
            stats: { digg_count: 126000 },
            title: '懒人好物'
          }
        )
      ],
      false
    ).steps

    expect(step.copy.done(step.facts)).toBe('下载了 1 个视频，1 分 43 秒，12.6 万赞')
    // The titled page the result names wins over the raw link it was handed.
    expect(step.sources.links).toEqual([{ label: '懒人好物', url: 'https://www.douyin.com/video/1' }])
  })

  it('says when a video had no speech', () => {
    const [step] = buildTurnProcess(
      [done('t', 'media_transcribe', {}, { ok: true, speech: false, transcript: '' })],
      false
    ).steps

    expect(step.copy.done(step.facts)).toBe('视频里没有人声')
  })

  it('falls back to the raw link when the result names no page', () => {
    const [step] = buildTurnProcess(
      [done('w', 'web_extract', { urls: ['https://example.cn/a'] }, { content: '正文' })],
      false
    ).steps

    expect(step.sources.links).toEqual([{ label: '', url: 'https://example.cn/a' }])
  })
})

describe('where a turn stands', () => {
  it('names the newest running step while the turn is live', () => {
    const process = buildTurnProcess(
      [done('v', 'social_download'), call('t', 'media_transcribe', { video_path: '/a.mp4' })],
      true
    )

    expect(process).toMatchObject({ activity: 'step', current: 1, phase: 'running' })
  })

  it('is getting ready while it only looks tools up', () => {
    expect(buildTurnProcess([call('s', 'tool_search')], true).activity).toBe('preparing')
  })

  it('is writing once the last step is done and the reply streams', () => {
    expect(buildTurnProcess([done('v', 'social_download'), text('这条视频')], true).activity).toBe('writing')
  })

  it('is stuck on a last step that failed', () => {
    const process = buildTurnProcess(
      [done('v', 'social_download'), call('t', 'media_transcribe', {}, { isError: true, result: { error: '失败' } })],
      false
    )

    expect(process).toMatchObject({ failed: 1, phase: 'failed' })
    expect(process.steps[1].state).toBe('failed')
  })

  it('is done when a failed try was followed by one that worked', () => {
    const process = buildTurnProcess(
      [call('a', 'media_transcribe', {}, { isError: true, result: { error: '超时' } }), done('b', 'media_transcribe')],
      false
    )

    expect(process.phase).toBe('done')
    expect(process.steps[0]).toMatchObject({ failedCalls: 1, state: 'done' })
  })

  it('reads a call left without a result as stopped, not running, once the turn ended', () => {
    const process = buildTurnProcess([done('a', 'read_file'), call('b', 'search_files')], false)

    expect(process).toMatchObject({ failed: 1, phase: 'stopped' })
  })

  it('settles a call the agent moved past, even while the turn is still live', () => {
    const process = buildTurnProcess([call('a', 'read_file'), text('接着看下一个'), call('b', 'terminal')], true)

    expect(process.steps.map(step => step.state)).toEqual(['stopped', 'running'])
    expect(process.current).toBe(1)
  })
})

describe('time', () => {
  it('sums the thoughts that recorded both ends, and admits when none did', () => {
    const measured = buildTurnProcess(
      [
        { completedAt: 103, text: '先想想', timestamp: 100, type: 'reasoning' },
        { completedAt: 210, text: '再想想', timestamp: 205, type: 'reasoning' }
      ],
      false
    )

    expect(measured.reasoning.seconds).toBe(8)
    expect(buildTurnProcess([{ text: '想过', timestamp: 100, type: 'reasoning' }], false).reasoning.seconds).toBeNull()
  })

  it('says durations in whole seconds and never in milliseconds', () => {
    expect(wholeSeconds(0.4)).toBe('')
    expect(wholeSeconds(2)).toBe('2 秒')
    expect(wholeSeconds(130)).toBe('2 分 10 秒')
  })
})

describe('the finished chain', () => {
  it('spells out a short chain and cuts a long one', () => {
    const steps = (names: string[]) =>
      buildTurnProcess(
        names.map((name, index) => done(String(index), name)),
        false
      ).steps

    expect(stepChain(steps(['social_download', 'media_transcribe']), ' → ', n => `共 ${n} 步`)).toBe(
      '下载视频 → 识别语音'
    )
    expect(
      stepChain(
        steps(['social_download', 'media_transcribe', 'social_search', 'web_search', 'doc_file_write']),
        ' → ',
        n => `共 ${n} 步`
      )
    ).toBe('下载视频 → 识别语音 → 搜同类作品 → … → 生成文档 共 5 步')
  })
})

describe('where the process block goes', () => {
  const message = (id: string, role: string, parts: TurnPart[]) => ({ id, parts, role })

  it('is the last run of activity in the turn, across bubbles', () => {
    const messages = [
      message('u', 'user', [text('拆这条')]),
      message('a', 'assistant', [text('好的'), done('1', 'social_download'), done('2', 'media_transcribe')]),
      message('b', 'assistant', [
        text('接着'),
        done('3', 'social_search'),
        done('4', 'patch'),
        done('5', 'web_search')
      ]),
      message('u2', 'user', [text('再来')])
    ]

    const bounds = turnBounds(messages, 'a')

    expect(bounds).toEqual({ end: 2, start: 1 })
    // The edit is a card: it splits the bubble's runs, and the run after it is the last.
    expect(turnAnchor(messages, bounds!)).toBe('b:3')
  })

  it('skips a run that only holds silent bookkeeping, and is empty with no activity', () => {
    const silentLast = [message('a', 'assistant', [done('1', 'web_search'), text('列个计划'), done('2', 'todo')])]
    const cardsOnly = [message('a', 'assistant', [done('1', 'clarify'), done('2', 'patch')])]

    expect(turnAnchor(silentLast, turnBounds(silentLast, 'a')!)).toBe('a:0')
    expect(turnAnchor(cardsOnly, turnBounds(cardsOnly, 'a')!)).toBe('')
  })
})
