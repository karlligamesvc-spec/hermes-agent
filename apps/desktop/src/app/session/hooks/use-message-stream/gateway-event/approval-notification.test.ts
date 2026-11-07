import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { setRuntimeI18nLocale } from '@/i18n'
import { $mainThreadsByProfile, type MainThreadState } from '@/store/main-thread'
import { clearAllPrompts } from '@/store/prompts'
import { clearAllSessionStates, publishSessionState } from '@/store/session-states'
import { setSingleEngineFlagForTest } from '@/store/single-engine'
import { $singleThreadFlag } from '@/store/single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
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

function approve(profile = 'default') {
  handleServerRequest(
    {
      fail: vi.fn(),
      id: 'srq-approval',
      method: 'approval',
      params: { command: CODE, description: DESCRIPTION, session_id: 'session-a' },
      profile,
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
  setMultiBotFlagForTest(false)
  resetBotRosterForTest()
  clearAllPrompts()
  setSingleEngineFlagForTest(false)
  $mainThreadsByProfile.set({})
  clearAllSessionStates()
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

describe('hc-1077 with several assistants on', () => {
  it('names the assistant whose engine asked, even one working in the background', () => {
    $singleThreadFlag.set(true)
    setMultiBotFlagForTest(true)
    resetBotRosterForTest(
      botRosterFrom([{ name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } }], () => true)
    )

    expect(approve('writer')).toMatch(/^小红书文案 想在你的电脑上运行一段程序，用来做字幕。/)
    expect(approve('default')).toMatch(/^APEX 想在你的电脑上运行一段程序/)
  })

  // hc-1166: one engine tags every request APEX's; the session's thread says whose it is.
  it('with one engine names the assistant whose thread the session is on', () => {
    $singleThreadFlag.set(true)
    setMultiBotFlagForTest(true)
    resetBotRosterForTest(
      botRosterFrom([{ name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } }], () => true)
    )
    $mainThreadsByProfile.set({
      writer: { ids: ['stored-a'], profile: 'writer', rootId: 'stored-a', status: 'found', tipId: 'stored-a' }
    } as unknown as Record<string, MainThreadState>)
    publishSessionState('session-a', {
      busy: true,
      needsInput: false,
      storedSessionId: 'stored-a'
    } as ClientSessionState)

    expect(approve('default')).toMatch(/^APEX 想在你的电脑上运行一段程序/)

    setSingleEngineFlagForTest(true)

    expect(approve('default')).toMatch(/^小红书文案 想在你的电脑上运行一段程序，用来做字幕。/)
  })
})
