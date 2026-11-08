/**
 * hc-1186: a `cron_result` row (a scheduled job's result posted back into its chat) hydrates as a system card,
 * never as a user bubble, in every mode.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n'
import { toRuntimeMessage } from '@/lib/chat-runtime'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import type { SessionMessage } from '@/types/hermes'

import { toChatMessages } from '.'

const RESULT = '国家统计局公布 10 月 CPI（来源：国家统计局，官方）'

function row(meta: Record<string, unknown> | string | null, extra: Partial<SessionMessage> = {}): SessionMessage {
  return {
    role: 'user',
    content: `[定时任务「今日财经」到点跑完的结果（后台按时自动送来，不是用户发的消息）]\n\n${RESULT}`,
    display_kind: 'cron_result',
    display_metadata: meta,
    timestamp: 1_762_600_000,
    ...extra
  } as SessionMessage
}

const META = {
  job_id: '8559328521a8',
  job_name: '今日财经',
  status: 'ok',
  delivery_id: 'exec-1',
  run_session_id: 'cron_8559328521a8_20261108_093518',
  display_text: RESULT
}

afterEach(() => {
  setRuntimeI18nLocale('en')
  setSingleThreadFlagForTest(false)
})

describe('cron_result rows', () => {
  it.each([
    ['metadata object', META],
    ['metadata as JSON text (older backends)', JSON.stringify(META)]
  ])('hydrate as a system card with the result (%s)', (_label, meta) => {
    setRuntimeI18nLocale('zh')
    const [message] = toChatMessages([row(meta)])

    expect(message.role).toBe('system')
    expect(message.parts).toEqual([expect.objectContaining({ type: 'text', text: '定时任务「今日财经」的结果' })])
    expect(message.cronResult).toEqual({
      jobName: '今日财经',
      failed: false,
      text: RESULT,
      runSessionId: 'cron_8559328521a8_20261108_093518'
    })
    expect(message.asyncResult).toBeUndefined()
  })

  it('names a failed run as one', () => {
    setRuntimeI18nLocale('zh')
    const [message] = toChatMessages([row({ ...META, status: 'failed', display_text: '模型没连上' })])

    expect(message.parts[0]).toEqual(expect.objectContaining({ text: '定时任务「今日财经」没跑成' }))
    expect(message.cronResult).toEqual(expect.objectContaining({ failed: true, text: '模型没连上' }))
  })

  it.each([true, false])('read the same in product mode and out of it (single thread %s)', singleThread => {
    setSingleThreadFlagForTest(singleThread)
    const [message] = toChatMessages([row(META)])

    expect(message.role).toBe('system')
    expect(message.parts[0]).toEqual(expect.objectContaining({ text: 'Scheduled job "今日财经" result' }))
  })

  it('stays a system row when the metadata is unreadable', () => {
    const [message] = toChatMessages([row('{not json')])

    expect(message.role).toBe('system')
    expect(message.cronResult).toEqual({ jobName: '', failed: false, text: '' })
  })

  it('leaves the rows around it as they were', () => {
    const messages = toChatMessages([
      { role: 'user', content: '帮我建一个定时任务', timestamp: 1 } as SessionMessage,
      { role: 'assistant', content: '建好了。', timestamp: 2 } as SessionMessage,
      row(META, { timestamp: 3 }),
      { role: 'user', content: '刚才那条新闻是什么？', timestamp: 4 } as SessionMessage
    ])

    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'system', 'user'])
    expect(messages.filter(message => message.cronResult)).toHaveLength(1)
  })

  it('carries the card data to the thread runtime', () => {
    const [message] = toChatMessages([row(META)])
    const runtime = toRuntimeMessage(message)

    expect(runtime.role).toBe('system')
    expect(runtime.metadata.custom?.cronResult).toEqual(message.cronResult)
  })
})
