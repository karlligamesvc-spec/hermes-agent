import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { COMPOSER_AREAS, type ComposerDraft } from '@/app/chat/composer/contrib'
import { registry } from '@/contrib/registry'
import { setRuntimeI18nLocale } from '@/i18n'
import { mainComposerScope } from '@/store/composer'
import { $heldSends, holdSend, resetHeldSendsForTest } from '@/store/held-sends'
import { $mainThread, noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $activeSessionId, $busy, $gatewayState, $selectedStoredSessionId, $sessions } from '@/store/session'
import { $sessionStates } from '@/store/session-states'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import {
  $botIntent,
  $botRoster,
  apexBot,
  namedBot,
  resetBotRosterForTest,
  setMultiBotFlagForTest
} from '@/store/single-thread-bots'

import { type HeldSendSubmit, releaseNextHeldSend, useHeldSendRelease, withdrawHeldSend } from './held-send-release'

const { notices, requestComposerInsert } = vi.hoisted(() => ({
  notices: [] as string[],
  requestComposerInsert: vi.fn()
}))

vi.mock('@/store/notifications', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  notify: vi.fn((input: { message?: string }) => {
    notices.push(String(input.message ?? ''))

    return `notice-${notices.length}`
  })
}))

vi.mock('@/app/chat/composer/focus', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  requestComposerInsert
}))

const SHOT = { id: 'a1', kind: 'image', label: 'shot.png' } as never

/** A submit that records what reached the app and answers `answer`. */
function appSubmit(answer: boolean | (() => boolean) = true) {
  const sent: { attachments: unknown[]; text: string }[] = []

  const submit = vi.fn(async (text: string, options: { attachments: unknown[] }) => {
    sent.push({ attachments: options.attachments, text })

    return typeof answer === 'function' ? answer() : answer
  })

  return { sent, submit: submit as unknown as HeldSendSubmit & typeof submit }
}

/** `profile`'s thread is on screen and bound: a send can go. */
function threadOpen(profile = 'default'): void {
  $activeGatewayProfile.set(profile)
  $botIntent.set(null)
  noteMainThreadClaimed(profile, `${profile}-root`)
  $selectedStoredSessionId.set(`${profile}-root`)
  $activeSessionId.set(`rt-${profile}`)
}

/** `profile`'s thread is selected, its conversation still loading. */
function threadLoading(profile = 'default'): void {
  threadOpen(profile)
  $activeSessionId.set(null)
}

beforeEach(() => {
  setSingleThreadFlagForTest(true)
  setMultiBotFlagForTest(true)
  $gatewayState.set('open')
  resetBotRosterForTest([apexBot(), namedBot({ name: 'writer' })])
  requestComposerInsert.mockReset()
  notices.length = 0
  setRuntimeI18nLocale('zh')
})

afterEach(() => {
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  resetHeldSendsForTest()
  resetMainThreadForTest()
  resetBotRosterForTest()
  mainComposerScope.clear()
  $botIntent.set(null)
  $activeGatewayProfile.set('default')
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  $sessions.set([])
  $sessionStates.set({})
  $busy.set(false)
  $gatewayState.set('idle')
})

describe('hc-1146 a held message goes out once its thread can take it', () => {
  it('waits while the conversation loads, then goes out through the app’s submit, once', async () => {
    threadLoading()
    holdSend('default', { attachments: [SHOT], text: '帮我写 3 个标题' })
    const { sent, submit } = appSubmit()

    expect(await releaseNextHeldSend(submit)).toBe(false)
    expect(sent).toEqual([])

    threadOpen()

    const [first, second] = await Promise.all([releaseNextHeldSend(submit), releaseNextHeldSend(submit)])

    expect([first, second]).toEqual([true, false])
    expect(sent).toEqual([{ attachments: [SHOT], text: '帮我写 3 个标题' }])
    expect($heldSends.get()).toEqual([])
    expect(await releaseNextHeldSend(submit)).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it('a message with no attachments says so: the composer’s current ones never ride along', async () => {
    threadOpen()
    holdSend('default', { text: '在吗' })
    const { sent, submit } = appSubmit()

    await releaseNextHeldSend(submit)

    expect(sent).toEqual([{ attachments: [], text: '在吗' }])
  })

  it('goes through the composer’s middleware chain as a send made now', async () => {
    const unregister = registry.register({
      area: COMPOSER_AREAS.middleware,
      data: { handler: (draft: ComposerDraft) => ({ ...draft, text: `${draft.text}!` }) },
      id: 'test-rewrite'
    })

    threadOpen()
    holdSend('default', { text: '在吗' })
    const { sent, submit } = appSubmit()

    try {
      await releaseNextHeldSend(submit)
    } finally {
      unregister()
    }

    expect(sent.map(item => item.text)).toEqual(['在吗!'])
  })

  it('only the assistant on screen sends: another one’s messages wait for it', async () => {
    threadOpen('default')
    holdSend('writer', { text: '标题写 3 个' })
    const { sent, submit } = appSubmit()

    expect(await releaseNextHeldSend(submit)).toBe(false)
    expect(sent).toEqual([])

    threadOpen('writer')

    expect(await releaseNextHeldSend(submit)).toBe(true)
    expect(sent.map(item => item.text)).toEqual(['标题写 3 个'])
  })

  it.each([
    ['the gateway is not open', () => $gatewayState.set('connecting')],
    ['a turn is running', () => $busy.set(true)],
    ['a turn is still settling', () => $sessionStates.set({ 'rt-default': { turnLive: true } } as never)],
    ['another assistant was just asked for', () => $botIntent.set('writer')],
    ['an earlier conversation is on screen', () => $selectedStoredSessionId.set('older')]
  ])('waits while %s', async (_label, block) => {
    threadOpen()
    holdSend('default', { text: '在吗' })
    block()
    const { sent, submit } = appSubmit()

    expect(await releaseNextHeldSend(submit)).toBe(false)
    expect(sent).toEqual([])
    expect($heldSends.get()).toHaveLength(1)
  })

  it('one at a time, oldest first: the next waits for the reply to the one before', async () => {
    threadOpen()
    holdSend('default', { text: '第一句' })
    holdSend('default', { text: '第二句' })

    const { sent, submit } = appSubmit(() => {
      $busy.set(true)

      return true
    })

    expect(await releaseNextHeldSend(submit)).toBe(true)
    expect(await releaseNextHeldSend(submit)).toBe(false)
    expect(sent.map(item => item.text)).toEqual(['第一句'])

    $busy.set(false)

    expect(await releaseNextHeldSend(submit)).toBe(true)
    expect(sent.map(item => item.text)).toEqual(['第一句', '第二句'])
  })

  it('a send the app refuses comes back into the composer, words and attachments', async () => {
    threadOpen()
    holdSend('default', { attachments: [SHOT], text: '在吗' })

    expect(await releaseNextHeldSend(appSubmit(false).submit)).toBe(false)
    expect(requestComposerInsert).toHaveBeenCalledWith('在吗', { mode: 'block', target: 'main' })
    expect(mainComposerScope.$attachments.get()).toEqual([SHOT])
    expect($heldSends.get()).toEqual([])
  })

  it('a send that lost a race with another turn waits for it, first in line', async () => {
    threadOpen()
    holdSend('default', { text: '第一句' })
    holdSend('default', { text: '第二句' })

    const { submit } = appSubmit(() => {
      $busy.set(true)

      return false
    })

    expect(await releaseNextHeldSend(submit)).toBe(false)
    expect(requestComposerInsert).not.toHaveBeenCalled()
    expect($heldSends.get().map(item => item.text)).toEqual(['第一句', '第二句'])
  })

  it('a middleware that refuses it on the way hands it back to the composer', async () => {
    const unregister = registry.register({
      area: COMPOSER_AREAS.middleware,
      data: { handler: () => null },
      id: 'test-refuse'
    })

    threadOpen()
    holdSend('default', { text: '/branch' })
    const { sent, submit } = appSubmit()

    try {
      expect(await releaseNextHeldSend(submit)).toBe(false)
    } finally {
      unregister()
    }

    expect(sent).toEqual([])
    expect(requestComposerInsert).toHaveBeenCalledWith('/branch', { mode: 'block', target: 'main' })
  })

  it('withdrawn, it is not sent and its words go back into the composer', async () => {
    threadLoading()
    const held = holdSend('default', { text: '算了' })
    holdSend('default', { text: '留着这条' })

    withdrawHeldSend(held.id)
    threadOpen()
    const { sent, submit } = appSubmit()

    await releaseNextHeldSend(submit)

    expect(requestComposerInsert).toHaveBeenCalledWith('算了', { mode: 'block', target: 'main' })
    expect(sent.map(item => item.text)).toEqual(['留着这条'])
  })

  it('a thread lookup that failed hands every held message back, with the notice a send got then', async () => {
    $activeGatewayProfile.set('default')
    $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'error', tipId: null })
    holdSend('default', { text: '第一句' })
    holdSend('writer', { text: '给文案的' })
    holdSend('default', { text: '第二句' })
    const { sent, submit } = appSubmit()

    expect(await releaseNextHeldSend(submit)).toBe(false)
    expect(sent).toEqual([])
    expect(requestComposerInsert.mock.calls.map(call => call[0])).toEqual(['第一句', '第二句'])
    expect(notices).toEqual(['暂时连不上对话，消息还在输入框里，稍后再发。'])
    expect($heldSends.get().map(item => item.text)).toEqual(['给文案的'])
  })

  it('with one assistant nothing is released', async () => {
    setMultiBotFlagForTest(false)
    threadOpen()
    holdSend('default', { text: '在吗' })
    const { sent, submit } = appSubmit()

    expect(await releaseNextHeldSend(submit)).toBe(false)
    expect(sent).toEqual([])
  })
})

describe('hc-1146 useHeldSendRelease', () => {
  it('sends a held message as soon as its thread opens, once', async () => {
    threadLoading()
    const { sent, submit } = appSubmit()
    const ref = { current: submit }

    renderHook(() => useHeldSendRelease(true, ref))
    holdSend('default', { text: '在吗' })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(sent).toEqual([])

    threadOpen()

    await waitFor(() => expect(sent.map(item => item.text)).toEqual(['在吗']))
    $sessions.set([])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sent).toHaveLength(1)
  })

  it('then the next one, when the reply has finished', async () => {
    threadOpen()

    const { sent, submit } = appSubmit(() => {
      $busy.set(true)

      return true
    })

    renderHook(() => useHeldSendRelease(true, { current: submit }))
    holdSend('default', { text: '第一句' })
    holdSend('default', { text: '第二句' })

    await waitFor(() => expect(sent.map(item => item.text)).toEqual(['第一句']))
    $busy.set(false)
    await waitFor(() => expect(sent.map(item => item.text)).toEqual(['第一句', '第二句']))
  })

  it('off, it sends nothing', async () => {
    threadOpen()
    const { sent, submit } = appSubmit()

    renderHook(() => useHeldSendRelease(false, { current: submit }))
    holdSend('default', { text: '在吗' })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(sent).toEqual([])
  })

  it('an assistant that is deleted takes its held messages with it', () => {
    threadOpen()
    renderHook(() => useHeldSendRelease(true, { current: null }))
    holdSend('writer', { text: '标题写 3 个' })
    holdSend('default', { text: '在吗' })

    $botRoster.set([apexBot()])

    expect($heldSends.get().map(item => item.text)).toEqual(['在吗'])
  })
})
