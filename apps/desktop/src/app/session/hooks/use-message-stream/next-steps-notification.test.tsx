import { act, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'

// 「下一步」 (apex-next/1): the block at the end of a creator skill's reply is buttons in the
// window, never text. The turn-done notification quotes the reply's opening, and a short
// reply would otherwise carry the block's HTML comment into the system notification.

const notifications = vi.hoisted(() => [] as { body: string; kind: string }[])

vi.mock('@/store/native-notifications', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  dispatchNativeNotification: (input: { body: string; kind: string }) => {
    notifications.push(input)

    return true
  }
}))

const SID = 'session-next-steps'

let stream: MessageStreamHarness

afterEach(() => {
  cleanup()
  notifications.length = 0
})

describe('the turn-done notification', () => {
  it('quotes the reply without its 「下一步」 block', () => {
    stream = renderMessageStream(SID)
    const reply = '选题写好了。\n\n<!-- apex:next\n写成脚本 | 把第 1 个选题写成脚本\n-->'

    act(() => stream.handleEvent({ payload: {}, session_id: SID, type: 'message.start' }))
    act(() => stream.handleEvent({ payload: { text: reply }, session_id: SID, type: 'message.complete' }))

    const done = notifications.filter(item => item.kind === 'turnDone')

    expect(done).toHaveLength(1)
    expect(done[0].body).toBe('选题写好了。')
  })
})
