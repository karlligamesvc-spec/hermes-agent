/**
 * hc-1087 identity harness for the relay (接力) screens: the transcript rows a
 * relay card or 「X 交来的活」 would sit in, and the composer's `@` list. Uses
 * only APIs fork main 56bb78eb (with hc-1086's branch) already has, so the
 * same file records the goldens there and checks them on the branch.
 *
 * The caller sets the switches (single_thread, multi_bot, relay, tool view);
 * this file only seeds the state each surface reads and returns its
 * normalized HTML.
 */
// First: the recording time zone, before any app module or fixture (time-zone.ts).
import '../single-thread-shell/time-zone'

import type { Unstable_TriggerItem } from '@assistant-ui/core'
import { type ThreadMessage } from '@assistant-ui/react'
import { render } from '@testing-library/react'
import type { ComponentType } from 'react'

import { ComposerTriggerPopover } from '@/app/chat/composer/trigger-popover'
import { I18nProvider } from '@/i18n'

import { normalized, renderTranscript, transcriptHtml } from '../single-thread-shell/render'

const at = (hour: number, minute = 0) => new Date(2026, 9, 21, hour, minute)

function user(id: string, createdAt: Date, text: string): ThreadMessage {
  return {
    attachments: [],
    content: [{ text, type: 'text' }],
    createdAt,
    id,
    metadata: { custom: {} },
    role: 'user'
  } as ThreadMessage
}

function assistant(id: string, createdAt: Date, text: string): ThreadMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt,
    id,
    metadata: { custom: {}, steps: [], unstable_annotations: [], unstable_data: [], unstable_state: null },
    role: 'assistant',
    status: { reason: 'stop', type: 'complete' }
  } as unknown as ThreadMessage
}

/** APEX's thread before any relay: a topic picked, then a follow-up turn ending in 「下一步」 buttons. */
export const RELAY_TRANSCRIPT: ThreadMessage[] = [
  user('t1-ask', at(9, 20), '这周想做收纳，帮我挑个选题'),
  assistant(
    't1-answer',
    at(9, 21),
    '挑好了：**租房党衣柜改造，不打孔**。这周「免打孔」搜索涨得快，前后对比好拍，手机就够。'
  ),
  user('t2-ask', at(9, 40), '就用这个，开头怎么拍？'),
  assistant(
    't2-answer',
    at(9, 41),
    '先拍衣柜塞满的样子 3 秒，再一句「不打孔，押金保住了」。\n\n<!-- apex:next\n写 3 个标题 | 按这个选题写 3 个标题\n再挑一个 | 换一个选题\n-->'
  )
]

/** Every row of the transcript (dividers, bubbles, buttons), normalized. */
export async function threadRowsHtml(messages: ThreadMessage[] = RELAY_TRANSCRIPT): Promise<string> {
  return transcriptHtml(await renderTranscript(messages)) + '\n'
}

function atItem(type: string, rawText: string, display: string, meta: string, insertId: string): Unstable_TriggerItem {
  return {
    id: `${rawText}|0`,
    label: display,
    metadata: { display, icon: type, insertId, meta, rawText },
    type,
    ...(meta ? { description: meta } : {})
  }
}

/** What the `@` list shows for a bare `@`: the reference starters and one file. */
export const AT_ITEMS: readonly Unstable_TriggerItem[] = [
  atItem('file', '@file:', '@file:', 'Attach a file reference', ''),
  atItem('folder', '@folder:', '@folder:', 'Attach a folder reference', ''),
  atItem('file', '@file:src/main.tsx', 'main.tsx', 'src/main.tsx', 'src/main.tsx')
]

type PopoverComponent = ComponentType<Parameters<typeof ComposerTriggerPopover>[0]>

/** The composer's `@` list, drawn by `Popover` (the composer's own by default). */
export function atPopoverHtml(Popover: PopoverComponent = ComposerTriggerPopover): string {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <Popover activeIndex={0} items={AT_ITEMS} kind="@" loading={false} onHover={() => {}} onPick={() => {}} />
    </I18nProvider>
  )

  const html = normalized(view.container.innerHTML) + '\n'

  view.unmount()

  return html
}
