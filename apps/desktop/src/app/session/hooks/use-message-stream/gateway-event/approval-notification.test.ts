import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setRuntimeI18nLocale } from '@/i18n'
import { clearAllPrompts } from '@/store/prompts'
import { $singleThreadFlag } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { handleServerRequest, type ServerRequestContext } from './server-requests'

// hc-1066: a command or code waiting on approval also reaches the system's
// notification centre. Its body was the command itself — the Python the agent
// wrote — so in single-thread product mode it says the approval bar's sentence.

const notifications = vi.hoisted(() => [] as { body?: string; kind: string }[])

vi.mock('@/store/native-notifications', () => ({
  dispatchNativeNotification: (notification: { body?: string; kind: string }) => {
    notifications.push(notification)
  }
}))

const CODE = 'ass = open("build/subs.ass").read()\nprint(len(ass))'
const DESCRIPTION = 'execute_code script execution. The script can spawn subprocesses or mutate files.'

function approve() {
  handleServerRequest(
    {
      fail: vi.fn(),
      id: 'srq-approval',
      method: 'approval',
      params: { command: CODE, description: DESCRIPTION, session_id: 'session-a' },
      profile: 'default',
      respond: vi.fn()
    },
    // markNeedsInput touches the session store through these; nothing here reads them back.
    new Proxy({}, { get: () => vi.fn() }) as ServerRequestContext['deps'],
    'session-a'
  )

  return notifications.at(-1)?.body
}

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setToolViewMode('product')
  notifications.length = 0
})

afterEach(() => {
  setRuntimeI18nLocale('en')
  setToolViewMode('product')
  $singleThreadFlag.set(false)
  clearAllPrompts()
})

describe('the approval notification', () => {
  it('says what the code is for in single-thread product mode', () => {
    $singleThreadFlag.set(true)

    expect(approve()).toBe('APEX 想在你的电脑上运行一段程序，用来做字幕。你同意了才会执行，点「命令」可以看具体内容。')
  })

  it.each([
    ['switch off', false, 'product'],
    ['developer mode', true, 'technical']
  ] as const)('shows the command itself with the %s', (_name, on, view) => {
    $singleThreadFlag.set(on)
    setToolViewMode(view)

    expect(approve()).toBe(CODE)
  })
})
