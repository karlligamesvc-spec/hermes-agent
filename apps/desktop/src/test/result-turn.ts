import type { ThreadMessage } from '@assistant-ui/react'

import { renderMediaTags } from '@/lib/chat-messages/parts'

import { remixTool } from './remix-turn'

/**
 * hc-1130: the part of a task where the user gets the result, the shape of the
 * hc-1126 real run on 0.17.69. The assistant writes its own subtitle script,
 * runs it, patches it, writes a copy file, then hands over a video, an audio
 * clip, a cover and a document. File edits arrive as cards with a diff; the
 * results arrive as MEDIA: paragraphs in the reply, with cache paths named
 * after the prompt.
 */

const T0 = Date.UTC(2026, 9, 31, 12, 0, 0) / 1000
const createdAt = new Date(T0 * 1000)

const CACHE = '/Users/me/.apexnodes/cache/media'

export const RESULT_VIDEO = `${CACHE}/一条_15_秒的竖屏短视频_分三个镜头_镜头之间硬切_三个镜头里是同一个人_同一_4a2ea035.mp4`
export const RESULT_AUDIO = `${CACHE}/配音_口播_7b1c2d3e.mp3`
export const RESULT_IMAGE = `${CACHE}/收纳架封面_带字_9a8b7c6d.png`
export const RESULT_DOC = '/Users/me/APEX/成片/拆解报告.docx'
export const RESULT_SCRIPT = '/Users/me/.apexnodes/cache/scratch/burn.py'
export const RESULT_COPY = '/Users/me/APEX/成片/文案.txt'

const SCRIPT_BODY = `import os\nV = "${RESULT_VIDEO}"\nos.system("ffmpeg -i " + V)\n`
const SCRIPT_DIFF = `--- /dev/null\n+++ b/burn.py\n@@ -0,0 +1,3 @@\n+import os\n+V = "${RESULT_VIDEO}"\n+os.system("ffmpeg -i " + V)\n`
const PATCH_DIFF = `--- a/burn.py\n+++ b/burn.py\n@@ -1,3 +1,3 @@\n import os\n-caps = 39\n+caps = 12\n`
const COPY_DIFF = '--- /dev/null\n+++ b/文案.txt\n@@ -0,0 +1,2 @@\n+先别买柜子\n+乱的根，是东西只能往里堆\n'

export const RESULT_ANSWER = [
  '做好了，这条成片你先看：',
  `MEDIA:${RESULT_VIDEO}`,
  '配音和封面也一起给你：',
  `MEDIA:${RESULT_AUDIO}`,
  `MEDIA:${RESULT_IMAGE}`,
  '拆解写成了文档：',
  `MEDIA:${RESULT_DOC}`
].join('\n\n')

type Part = Record<string, unknown>

const span = (from: number, to: number): [number, number] => [from, to]

const said = (text: string): Part => ({ type: 'text', text })

function bubble(id: string, content: Part[], status: Record<string, unknown>): ThreadMessage {
  return {
    id,
    role: 'assistant',
    content,
    status,
    createdAt,
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
  } as unknown as ThreadMessage
}

function ask(id: string, text: string): ThreadMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    attachments: [],
    createdAt,
    metadata: { custom: {} }
  } as ThreadMessage
}

export const writeScript = (options: { result?: unknown } = {}): Part =>
  remixTool(
    'write-burn',
    'write_file',
    { path: RESULT_SCRIPT, content: SCRIPT_BODY },
    'result' in options ? { result: options.result, span: span(10, 11) } : {}
  )

const WRITE_AND_RUN: Part[] = [
  said('字幕我顺手加上。'),
  writeScript({ result: { bytes_written: 120, inline_diff: SCRIPT_DIFF } }),
  remixTool(
    'run-burn',
    'terminal',
    { command: `cd /Users/me && python3 ${RESULT_SCRIPT}`, timeout: 300 },
    { result: { output: 'done', exit_code: 0, error: null }, span: span(12, 40) }
  )
]

const PATCH_AND_WRITE: Part[] = [
  remixTool(
    'patch-burn',
    'patch',
    { path: RESULT_SCRIPT, old_string: 'caps = 39', new_string: 'caps = 12' },
    { result: { success: true, inline_diff: PATCH_DIFF }, span: span(41, 42) }
  ),
  remixTool(
    'write-copy',
    'write_file',
    { path: RESULT_COPY, content: '先别买柜子\n乱的根，是东西只能往里堆\n' },
    { result: { bytes_written: 60, inline_diff: COPY_DIFF }, span: span(43, 44) }
  )
]

/**
 * The finished task: a file write and a command in one bubble, a patch, another
 * write and the results in the last. The 「N 个文件有改动」 card reads the last
 * bubble, which is how the real run showed it.
 */
export function resultTurn(answer = RESULT_ANSWER): ThreadMessage[] {
  return [
    ask('result-ask', '帮我生成一条竖屏短视频，再配上字幕'),
    bubble('result-work', WRITE_AND_RUN, { type: 'complete', reason: 'tool-calls' }),
    bubble('result-answer', [...PATCH_AND_WRITE, said(renderMediaTags(answer))], { type: 'complete', reason: 'stop' })
  ]
}

/** A file write still running: what an approval hangs off when one is asked. */
export function resultWritingTurn(): ThreadMessage[] {
  return [
    ask('writing-ask', '帮我把助手的说明改一下'),
    bubble('writing-work', [said('我来改。'), writeScript()], { type: 'running' })
  ]
}

/** `delegate_task` draws its own card; a child's summary rides in its ticker. */
export function resultDelegateTurn(): ThreadMessage[] {
  return [
    ask('delegate-ask', '帮我找两个对标账号'),
    bubble(
      'delegate-work',
      [
        remixTool(
          'delegate-card',
          'delegate_task',
          { tasks: [{ goal: '找对标账号' }] },
          {
            result: {
              results: [{ status: 'completed', summary: `python3 ${RESULT_SCRIPT} --out /Users/me/APEX/对标.csv` }]
            },
            span: span(1, 9)
          }
        )
      ],
      { type: 'complete', reason: 'tool-calls' }
    ),
    bubble('delegate-answer', [said('找好了。')], { type: 'complete', reason: 'stop' })
  ]
}

/** `image_generate` draws its own card, not a MEDIA: paragraph. */
export function resultImageCardTurn(): ThreadMessage[] {
  return [
    ask('image-ask', '帮我画张封面'),
    bubble(
      'image-work',
      [
        remixTool(
          'image-card',
          'image_generate',
          { prompt: '收纳架封面' },
          { result: { image: RESULT_IMAGE }, span: span(1, 5) }
        )
      ],
      { type: 'complete', reason: 'tool-calls' }
    ),
    bubble('image-answer', [said('封面好了。')], { type: 'complete', reason: 'stop' })
  ]
}
