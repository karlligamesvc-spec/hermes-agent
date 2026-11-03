import type { ThreadMessage } from '@assistant-ui/react'

import { remixTool } from './remix-turn'

/**
 * hc-1066: one editing task done on the creator's own computer — four phone
 * clips cut into a 40-second vlog, with a voice-over and an AI-made talking
 * shot — the shape of a real 37-minute trace (2026-10-26): the assistant probes
 * the clips, grabs frames and looks at them, makes the voice and the shot,
 * writes and runs its own editing script, checks the cut frame by frame and
 * saves it. Most of that runs through `terminal`, `vision_analyze`,
 * `write_file` / `patch` and `execute_code`, whose arguments are commands,
 * questions, paths and code — the mechanism a creator should not have to read.
 *
 * Live, the turn arrives as three bubbles. Times are seconds after T0.
 */

const T0 = Date.UTC(2026, 9, 26, 13, 0, 0) / 1000
const createdAt = new Date(T0 * 1000)

const WORK = '/Users/me/.apexnodes/cache/scratch/vlog'
const MEDIA = '/Users/me/.apexnodes/cache/media'
export const EDITING_CLIP = `${MEDIA}/竖屏口播_cf68f9ae.mp4`
export const EDITING_SCRIPT = `${WORK}/build.py`

type Part = Record<string, unknown>

/** What `terminal` returns: the command's output and its exit code. */
const ran = (output = '', exitCode = 0) => ({ output, exit_code: exitCode, error: null })

const span = (from: number, to: number): [number, number] => [from, to]

function term(id: string, command: string, at: [number, number] | null, output = '') {
  return remixTool(id, 'terminal', { command, timeout: 120 }, at ? { result: ran(output), span: at } : {})
}

function look(id: string, question: string, image: string, at: [number, number] | null, answer = '看过了。') {
  return remixTool(
    id,
    'vision_analyze',
    { image_url: image, question },
    at ? { result: { success: true, analysis: answer }, span: at } : {}
  )
}

const said = (text: string): Part => ({ type: 'text', text })

const LOOK_AT_CLIPS: Part[] = [
  remixTool(
    'skill',
    'skill_view',
    { name: 'short-video-studio' },
    { result: { success: true, content: '短视频制作' }, span: span(9, 9.2) }
  ),
  term('probe-1', `ffprobe -v error -show_entries format=duration -of json "/Users/me/Downloads/a.MP4"`, span(10, 11)),
  term(
    'probe-2',
    `ffprobe -v error -show_entries format=duration -of json "/Users/me/Downloads/b.MP4"`,
    span(10, 11.4)
  ),
  term('mkdir', `mkdir -p ${WORK}/frames`, span(12, 12.1)),
  term(
    'frames-1',
    `ffmpeg -y -v error -i "/Users/me/Downloads/a.MP4" -vf "fps=1/1.4,scale=360:-1" -frames:v 3 ${WORK}/frames/a_%02d.png`,
    span(13, 15)
  ),
  term(
    'frames-2',
    `ffmpeg -y -v error -pattern_type glob -i "${WORK}/frames/*.png" -filter_complex "tile=4x3" -frames:v 1 ${WORK}/contact.png`,
    span(15, 16)
  ),
  look(
    'look-1',
    '这是一张 4x3 的联系表。请逐行描述每个视频里的人物、场景环境、镜头景别和构图。',
    `${WORK}/contact.png`,
    span(17, 40)
  )
]

const MAKE: Part[] = [
  remixTool(
    'voice',
    'text_to_speech',
    { text: '我是做人工智能的。' },
    { result: { success: true, file_path: `${WORK}/vo.mp3` }, span: span(60, 75) }
  ),
  remixTool(
    'shot',
    'generate_video',
    { prompt: '竖屏口播画面', aspect_ratio: 'portrait' },
    { result: { ok: true, video_path: EDITING_CLIP }, span: span(76, 281) }
  )
]

const CUT: Part[] = [
  remixTool(
    'write-build',
    'write_file',
    { path: EDITING_SCRIPT, content: 'import subprocess\nsubprocess.run(["ffmpeg", "-i", "a.MP4"])\n' },
    { result: { bytes_written: 6400 }, span: span(300, 301) }
  ),
  term('render-1', `python3 ${EDITING_SCRIPT}`, span(302, 350)),
  term(
    'check-sheet',
    `ffmpeg -y -v error -i "${WORK}/build/final.mp4" -vf "select='eq(n\\,60)+eq(n\\,150)',scale=540:-1,tile=3x2" -fps_mode passthrough -frames:v 1 ${WORK}/check.png`,
    span(351, 353)
  ),
  look(
    'look-2',
    '这是成片 6 个时间点的抽帧。只看字幕：每格底部的中文字幕是否完整在画面内，有没有被左右边缘裁掉。',
    `${WORK}/check.png`,
    span(354, 380)
  ),
  remixTool(
    'patch-subs',
    'patch',
    { path: `${WORK}/subs.py`, old_string: 'MAX = 16', new_string: 'MAX = 12' },
    { result: { success: true }, span: span(381, 382) }
  ),
  remixTool(
    'srt',
    'execute_code',
    { code: 'ass = open("build/subs.ass").read()\n# 从 subs.ass 导出一份 SRT\nprint(len(ass))' },
    { result: { status: 'success', output: '42' }, span: span(383, 390) }
  ),
  term('save', `cp "${WORK}/build/final.mp4" "/Users/me/Downloads/宣传片_43s.mp4"`, span(391, 392))
]

export const EDITING_ANSWER = [
  '做好了，43 秒竖屏成片已经存到「下载」里：宣传片_43s.mp4。',
  '',
  '- 开头 3 秒是你的自拍，中间接 AI 口播，结尾是「使用方法来找我」。',
  '- 字幕按句断行，另存了一份 SRT，方便你在剪映里改。'
].join('\n')

function message(id: string, role: 'assistant' | 'user', content: Part[], running = false, custom = {}): ThreadMessage {
  return {
    id,
    role,
    content,
    ...(role === 'user'
      ? { attachments: [] }
      : { status: running ? { type: 'running' } : { type: 'complete', reason: 'stop' } }),
    createdAt,
    metadata:
      role === 'user'
        ? { custom: {} }
        : { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom }
  } as unknown as ThreadMessage
}

const ask = () => message('edit-ask', 'user', [said('把这几段素材剪成一条 1 分钟内的竖屏 vlog，不够的画面用 AI 生成')])

const OPENING: Part[] = [said('收到，这个我按 vlog 拼贴的方式做，先把你给的素材看一遍，再定脚本和节奏。')]

/** The finished task as the live view built it: three bubbles. */
export function editingLiveTurn(): ThreadMessage[] {
  return [
    ask(),
    message('edit-a', 'assistant', OPENING),
    message('edit-b', 'assistant', [...LOOK_AT_CLIPS, ...MAKE, said('配音和口播画面都好了，开始剪。')]),
    message('edit-c', 'assistant', [...CUT, said(EDITING_ANSWER)], false, { durationS: 2200 })
  ]
}

/** Mid-task: the clips are looked at, the voice and the shot made, the cut renders. */
export function editingRunningTurn(): ThreadMessage[] {
  return [
    ask(),
    message('edit-a', 'assistant', OPENING),
    message('edit-b', 'assistant', [...LOOK_AT_CLIPS, ...MAKE, said('配音和口播画面都好了，开始剪。')]),
    message('edit-c', 'assistant', [CUT[0], term('render-1', `python3 ${EDITING_SCRIPT}`, null)], true)
  ]
}

/** The code that exports the subtitles, waiting on the user's approval. */
export const EDITING_APPROVAL_CODE = 'ass = open("build/subs.ass").read()\n# 从 subs.ass 导出一份 SRT\nprint(len(ass))'

/** Mid-task: the subtitle export waits for the user to allow running code. */
export function editingApprovalTurn(): ThreadMessage[] {
  return [
    ask(),
    message('edit-a', 'assistant', OPENING),
    message('edit-c', 'assistant', [CUT[0], remixTool('srt', 'execute_code', { code: EDITING_APPROVAL_CODE })], true)
  ]
}
