/**
 * hc-1091 identity harness for the relay plan (一条龙接力): APEX's transcript
 * rows with a reply that ends in an `apex:plan` block, as an engine with the
 * plan rule would write it. Uses only APIs fork main already has before
 * hc-1091, so the same file records the goldens there and checks them on the
 * branch.
 *
 * The caller sets the switches (single_thread, multi_bot, relay, tool view);
 * this file only returns the normalized HTML.
 */
// First: the recording time zone, before any app module or fixture (time-zone.ts).
import '../single-thread-shell/time-zone'

import { type ThreadMessage } from '@assistant-ui/react'

import { RELAY_TRANSCRIPT } from '../handoff-ui/render'
import { renderTranscript, transcriptHtml } from '../single-thread-shell/render'

const at = (hour: number, minute = 0) => new Date(2026, 9, 21, hour, minute)

/** The plan reply's text: the material the first baton carries, then the block. */
export const PLAN_REPLY =
  '选题还是**租房党衣柜改造，不打孔**：前后对比，不打孔、押金保住。\n\n' +
  '可以，我排了一个接力。你点开始，中途要你拍板我会停下来问你。\n\n' +
  '<!-- apex:plan\n' +
  '已有 | 定选题：租房党衣柜改造，不打孔\n' +
  '@小红书文案 | 写标题和文案 | 按这个选题写 3 个标题和一段 200 字文案\n' +
  '@剪辑助手 | 剪成 30 秒竖屏 | 用小红书文案交回的标题和文案，把素材剪成 30 秒竖屏\n' +
  '-->'

/** APEX's thread: hc-1087's relay transcript, then a turn that proposes a plan. */
export const PLAN_TRANSCRIPT: ThreadMessage[] = [
  ...RELAY_TRANSCRIPT,
  {
    attachments: [],
    content: [{ text: '这周的收纳选题，标题和成片一条龙做完', type: 'text' }],
    createdAt: at(15, 5),
    id: 't3-ask',
    metadata: { custom: {} },
    role: 'user'
  } as ThreadMessage,
  {
    content: [{ text: PLAN_REPLY, type: 'text' }],
    createdAt: at(15, 6),
    id: 't3-answer',
    metadata: { custom: {}, steps: [], unstable_annotations: [], unstable_data: [], unstable_state: null },
    role: 'assistant',
    status: { reason: 'stop', type: 'complete' }
  } as unknown as ThreadMessage
]

/** Every row of the plan transcript (dividers, bubbles, buttons, cards), normalized. */
export async function planThreadRowsHtml(messages: ThreadMessage[] = PLAN_TRANSCRIPT): Promise<string> {
  return transcriptHtml(await renderTranscript(messages)) + '\n'
}
