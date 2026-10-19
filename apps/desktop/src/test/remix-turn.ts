import type { ThreadMessage } from '@assistant-ui/react'

/**
 * hc-973: one full 「拆爆款 + 仿写」 task — a creator pastes a Douyin link and
 * asks why it took off and for a rewrite in their own voice — the way Desktop
 * receives it, so the process area can be checked against a real shape rather
 * than a hand-picked handful of rows.
 *
 * Live, the turn arrives as three bubbles (each narration seals one); reloaded
 * from history it is one bubble whose platform calls go through the
 * `tool_call` bridge. Every value is Chinese or brand data, so any Latin word
 * on screen is the product's own copy.
 */

const T0 = Date.UTC(2026, 9, 18, 10, 0, 0) / 1000
const createdAt = new Date(T0 * 1000)

export const REMIX_LINK = 'https://v.douyin.com/iRemix01/'

const SHARE_TEXT = `8.92 复制打开抖音，看看【收纳小王的作品】懒人好物盘点 ${REMIX_LINK} 01/02 Dgo:/`
const VIDEO_PATH = '/工作区/媒体/懒人好物盘点.mp4'
const TRANSCRIPT = '大家好，今天给你们盘点几个懒人好物。'.repeat(20)

export const REMIX_TOOL_NAMES = [
  'tool_search',
  'tool_describe',
  'skill_view',
  'social_download',
  'media_transcribe',
  'social_keyword_insight',
  'social_search'
]

export const REMIX_SKILL_SLUGS = ['video-script-breakdown', 'honesty-verification']

type Part = Record<string, unknown>

interface ToolOptions {
  isError?: boolean
  result?: unknown
  span?: [number, number]
}

export function remixTool(id: string, toolName: string, args: Record<string, unknown>, options: ToolOptions = {}): Part {
  const { isError, result, span } = options

  return {
    type: 'tool-call',
    toolCallId: id,
    toolName,
    args,
    argsText: JSON.stringify(args),
    ...(result === undefined ? {} : { result }),
    ...(isError ? { isError } : {}),
    ...(span ? { completedAt: T0 + span[1], timestamp: T0 + span[0] } : {})
  }
}

const thought = (text: string, span: [number, number]): Part => ({
  type: 'reasoning',
  text,
  timestamp: T0 + span[0],
  completedAt: T0 + span[1]
})

const said = (text: string): Part => ({ type: 'text', text })

const searchHits = (topic: string) => ({
  ok: true,
  data: {
    items: Array.from({ length: 20 }, (_, index) => ({
      title: `${topic}爆款第 ${index + 1} 条`,
      url: `https://www.douyin.com/video/73010000000${String(index).padStart(2, '0')}`
    }))
  }
})

const DOWNLOADED = {
  ok: true,
  platform: 'douyin',
  title: '懒人好物盘点',
  author: '收纳小王',
  duration_seconds: 103,
  stats: { digg_count: 126000, comment_count: 3400 },
  share_url: 'https://www.douyin.com/video/7301234567890',
  video_path: VIDEO_PATH
}

const TRANSCRIBED = {
  ok: true,
  transcript: TRANSCRIPT,
  speech: true,
  audio_duration_seconds: 103,
  title: '懒人好物盘点'
}

// The real failure text names a tool, so the card must not quote it.
const TRANSCRIBE_FAILED = {
  ok: false,
  error:
    '视频转写失败: 平台未能给出该内容的可下载媒体（可能是图文/直播链接），请确认是视频分享链接，或先用 social_download 检查。'
}

export const REMIX_ANSWER = [
  '## 这条为什么火',
  '1. 开头 3 秒直接给结果：乱糟糟的橱柜和收拾好的橱柜放在一起。',
  '2. 每个好物只讲一个痛点，10 秒内讲完。',
  '3. 结尾用价格当钩子，评论区自然有人问链接。',
  '',
  '## 仿写成你的口播（35 秒）',
  '0–3 秒：你家橱柜是不是也这样？瓶瓶罐罐全堆在一起。'
].join('\n')

const prepare = (bridged: boolean): Part[] => [
  remixTool(
    'search',
    'tool_search',
    { queries: ['下载抖音视频', '视频转文字'] },
    { result: { results: [{ name: '下载' }, { name: '转写' }], duration_s: 0.009 }, span: [3, 3.009] }
  ),
  remixTool(
    'describe',
    'tool_describe',
    { names: ['下载', '转写'] },
    { result: { tools: { 下载: {}, 转写: {} }, duration_s: 0.004 }, span: [3.1, 3.104] }
  ),
  remixTool(
    'skill-a',
    'skill_view',
    { name: bridged ? 'apexnodes/video-script-breakdown' : 'video-script-breakdown' },
    { result: { success: true, content: '拆解方法' }, span: [3.2, 3.287] }
  ),
  remixTool(
    'skill-b',
    'skill_view',
    { name: 'honesty-verification' },
    { result: { success: true, content: '核验方法' }, span: [3.3, 3.35] }
  )
]

/** A platform call: as the live feed names it, or through the bridge. */
function platformCall(bridged: boolean, id: string, name: string, args: Record<string, unknown>, options: ToolOptions) {
  return bridged
    ? remixTool(id, 'tool_call', { calls: [{ name, arguments: args }] }, options)
    : remixTool(id, name, args, options)
}

function download(bridged: boolean) {
  return platformCall(bridged, 'download', 'social_download', { url: SHARE_TEXT }, { result: DOWNLOADED, span: [4, 17] })
}

function transcribe(bridged: boolean, outcome: 'done' | 'failed' | 'running') {
  const options: ToolOptions =
    outcome === 'done'
      ? { result: TRANSCRIBED, span: [17, 143] }
      : outcome === 'failed'
        ? { isError: true, result: TRANSCRIBE_FAILED, span: [17, 437] }
        : {}

  return platformCall(bridged, 'transcribe', 'media_transcribe', { video_path: VIDEO_PATH }, options)
}

function research(bridged: boolean): Part[] {
  return [
    platformCall(
      bridged,
      'trend',
      'social_keyword_insight',
      { platform: 'douyin', keyword: '家居好物', focus: 'trend' },
      { result: { ok: true, data: { keyword: '家居好物', trend: [{ date: '20261017', index: 8800 }] } }, span: [149, 151] }
    ),
    platformCall(
      bridged,
      'similar-1',
      'social_search',
      { platform: 'douyin', query: '懒人好物', count: 20 },
      { result: searchHits('懒人好物'), span: [151, 153] }
    ),
    platformCall(
      bridged,
      'similar-2',
      'social_search',
      { platform: 'douyin', query: '厨房收纳', count: 20 },
      { result: searchHits('厨房收纳'), span: [151, 154] }
    )
  ]
}

const OPENING: Part[] = [
  thought('用户要拆爆款再仿写。先把视频拿下来转成文字。', [1, 3]),
  said('好的，我先把视频下载下来转成文字，再拆它为什么火。')
]

const MIDDLE: Part[] = [
  thought('逐字稿拿到了。再看看这类题材现在热不热、同类爆款怎么拍。', [143, 148]),
  said('逐字稿拿到了，接着看看这个题材的热度和同类爆款。')
]

const CLOSING: Part[] = [thought('结构是开头三秒反差、每个好物一个痛点、结尾价格钩子。', [154, 162]), said(REMIX_ANSWER)]

function message(id: string, role: 'assistant' | 'user', content: Part[], running = false, custom = {}): ThreadMessage {
  return {
    id,
    role,
    content,
    ...(role === 'user' ? { attachments: [] } : { status: running ? { type: 'running' } : { type: 'complete', reason: 'stop' } }),
    createdAt,
    metadata:
      role === 'user'
        ? { custom: {} }
        : { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom }
  } as unknown as ThreadMessage
}

const ask = () => message('remix-ask', 'user', [said(`${REMIX_LINK} 帮我拆一下这条为什么火，再仿写成我的口播`)])

/** The finished task as the live view built it: three bubbles. */
export function remixLiveTurn(): ThreadMessage[] {
  return [
    ask(),
    message('remix-a', 'assistant', OPENING),
    message('remix-b', 'assistant', [...prepare(false), download(false), transcribe(false, 'done'), ...MIDDLE]),
    message('remix-c', 'assistant', [...research(false), ...CLOSING], false, { durationS: 130 })
  ]
}

/** The same task reloaded from history: one bubble, platform calls bridged. */
export function remixReloadedTurn(): ThreadMessage[] {
  return [
    ask(),
    message('remix-history', 'assistant', [
      ...OPENING,
      ...prepare(true),
      download(true),
      transcribe(true, 'done'),
      ...MIDDLE,
      ...research(true),
      ...CLOSING
    ])
  ]
}

/** Mid-task: the video is down, the speech is being transcribed. */
export function remixRunningTurn(): ThreadMessage[] {
  return [
    ask(),
    message('remix-a', 'assistant', OPENING),
    message('remix-b', 'assistant', [...prepare(false), download(false), transcribe(false, 'running')], true)
  ]
}

/** Stuck: transcription failed, and the agent stopped there. */
export function remixFailedTurn(): ThreadMessage[] {
  return [
    ask(),
    message('remix-a', 'assistant', OPENING),
    message('remix-b', 'assistant', [
      ...prepare(false),
      download(false),
      transcribe(false, 'failed'),
      said('抱歉，这条视频的语音没识别出来。')
    ])
  ]
}
