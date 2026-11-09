/**
 * hc-1186: one OS notification per scheduled result, only while the user is away; the click opens the chat.
 * The real native-notification store runs, down to the window.hermesDesktop.notify bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n'

import { cronResultBroadcast, notifyCronResult } from './cron-result-notify'
import { NATIVE_NOTIFICATION_KINDS, setNativeNotifyEnabled, setNativeNotifyKind } from './native-notifications'
import { __resetNativeNotifyBaselineForTests } from './notify-baseline'
import { setActiveSessionId } from './session'

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const initialHermesDesktop = desktopWindow.hermesDesktop
const notify = vi.fn().mockResolvedValue(true)
const CHAT = '20261108_093309_be257d'

function setWindowState({ focused, hidden }: { focused: boolean; hidden: boolean }) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused })
}

let counter = 0

function broadcast(status: 'failed' | 'ok' = 'ok') {
  counter += 1

  return cronResultBroadcast({
    apex_cron_result: {
      session_id: CHAT,
      job_id: 'job-1',
      job_name: '今日财经',
      status,
      delivery_id: `exec-${counter}`,
      profile: 'default'
    }
  })!
}

beforeEach(() => {
  notify.mockClear()
  desktopWindow.hermesDesktop = { notify } as unknown as Window['hermesDesktop']
  setNativeNotifyEnabled(true)

  for (const kind of NATIVE_NOTIFICATION_KINDS) {
    setNativeNotifyKind(kind, true)
  }

  __resetNativeNotifyBaselineForTests()
  setActiveSessionId('some-other-chat')
  setRuntimeI18nLocale('zh')
})

afterEach(() => {
  setRuntimeI18nLocale('en')

  if (initialHermesDesktop) {
    desktopWindow.hermesDesktop = initialHermesDesktop
  } else {
    delete desktopWindow.hermesDesktop
  }
})

describe('scheduled result notifications', () => {
  it('notify once while the user is away, and the click opens that chat', () => {
    setWindowState({ focused: false, hidden: true })
    const result = broadcast()

    expect(notifyCronResult(result)).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'backgroundDone',
        title: '定时任务有结果了',
        body: '今日财经',
        sessionId: CHAT,
        tag: `cron-result:${result.delivery_id}:ok`
      })
    )
  })

  it('a failed run notifies under its own title', () => {
    setWindowState({ focused: false, hidden: true })
    notifyCronResult(broadcast('failed'))

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'turnError', title: '定时任务没跑成' }))
  })

  it('stay quiet while the user is looking at APEX', () => {
    setWindowState({ focused: true, hidden: false })

    expect(notifyCronResult(broadcast())).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })

  it.each([
    ['no payload', undefined],
    ['a plain cron list change', {}],
    ['no chat', { apex_cron_result: { delivery_id: 'x' } }],
    ['no delivery id', { apex_cron_result: { session_id: CHAT } }]
  ])('ignore %s', (_label, payload) => {
    expect(cronResultBroadcast(payload)).toBeUndefined()
  })
})
