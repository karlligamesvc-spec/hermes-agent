import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $mainThread, noteMainThreadClaimed, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { QUICK_TARGET_CURRENT, QUICK_TARGET_NEW } from '@/store/quick-entry'
import { $selectedStoredSessionId, $sessions } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'
import { makeSessionInfo } from '@/test/session-info'

import { openAnotherConversation } from './another-conversation'
import { ChatBar, isEarlierConversation } from './composer-gate'
import { $pendingThreadClaim } from './composer-middleware'
import { singleThreadQuickEntryTarget } from './quick-entry'

vi.mock('../chat/composer', () => ({
  ChatBar: () => <div data-testid="composer" />,
  ChatBarFallback: () => null
}))

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

function renderGate(queueSessionKey: null | string) {
  return render(
    <MemoryRouter initialEntries={['/older-chat']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <ChatBar {...({ queueSessionKey } as unknown as ComponentProps<typeof ChatBar>)} />
        <Where />
      </I18nProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  $sessions.set([
    makeSessionInfo({ _lineage_root_id: 'thread-root', id: 'thread-tip' }),
    makeSessionInfo({ id: 'older-chat' })
  ])
})

afterEach(() => {
  cleanup()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  resetMainThreadForTest()
  $pendingThreadClaim.set(null)
  $selectedStoredSessionId.set(null)
  $sessions.set([])
})

describe('hc-1014 the composer gate', () => {
  it('is the composer with the switch off, for any conversation', () => {
    noteMainThreadClaimed('default', 'thread-root')
    renderGate('older-chat')

    expect(screen.getByTestId('composer')).toBeTruthy()
  })

  it('puts a read-only bar with the way back under an earlier conversation', () => {
    setSingleThreadFlagForTest(true)
    noteMainThreadClaimed('default', 'thread-root')
    $mainThread.set({ ...$mainThread.get(), ids: ['thread-root', 'thread-tip'], tipId: 'thread-tip' })
    renderGate('older-chat')

    expect(screen.queryByTestId('composer')).toBeNull()
    expect(screen.getByText('这是更早的对话，只能看。')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '回到对话' }))
    expect(screen.getByTestId('where').textContent).toBe('/thread-tip')
  })

  it.each([
    ['the switch off', false, 'product', 'found', 'older-chat', false, false],
    ['developer mode', true, 'technical', 'found', 'older-chat', false, false],
    ['the thread itself, by its root', true, 'product', 'found', 'thread-root', false, false],
    ['the thread, by a later segment', true, 'product', 'found', 'thread-tip', false, false],
    ['the empty thread (a draft)', true, 'product', 'found', null, false, false],
    ['an earlier conversation', true, 'product', 'found', 'older-chat', false, true],
    ['any conversation before the thread exists', true, 'product', 'absent', 'older-chat', false, true],
    ['the session a first message just created', true, 'product', 'absent', 'brand-new', true, false],
    ['a lookup still running', true, 'product', 'loading', 'older-chat', false, false]
  ] as const)('%s → read-only: %s', (_label, flag, toolView, status, key, claimPending, expected) => {
    setSingleThreadFlagForTest(flag)
    setToolViewMode(toolView)

    const thread = {
      ids: ['thread-root'],
      profile: 'default',
      rootId: 'thread-root',
      status,
      tipId: 'thread-root'
    } as const
    const singleThread = flag && toolView === 'product'

    expect(isEarlierConversation(singleThread, key, thread, $sessions.get(), claimPending)).toBe(expected)
  })
})

describe('hc-1014 quick entry goes to the one conversation', () => {
  it('keeps the picked target with the switch off', () => {
    expect(singleThreadQuickEntryTarget('older-chat')).toBe('older-chat')
    expect(singleThreadQuickEntryTarget(QUICK_TARGET_NEW)).toBe(QUICK_TARGET_NEW)
  })

  it('sends to the thread on screen as the current chat, and to the thread in the background otherwise', () => {
    setSingleThreadFlagForTest(true)
    noteMainThreadClaimed('default', 'thread-root')

    $selectedStoredSessionId.set('thread-root')
    expect(singleThreadQuickEntryTarget(QUICK_TARGET_NEW)).toBe(QUICK_TARGET_CURRENT)

    $selectedStoredSessionId.set('older-chat')
    expect(singleThreadQuickEntryTarget(QUICK_TARGET_CURRENT)).toBe('thread-root')
    expect(singleThreadQuickEntryTarget('older-chat')).toBe('thread-root')
  })

  it('makes the thread with the first capture when there is none yet', () => {
    setSingleThreadFlagForTest(true)
    $activeGatewayProfile.set('default')
    $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'absent', tipId: null })

    expect(singleThreadQuickEntryTarget('older-chat')).toBe(QUICK_TARGET_NEW)
    expect($pendingThreadClaim.get()).toMatchObject({ profile: 'default' })
  })
})

describe('hc-1014 ⌘T and the new-window shortcut', () => {
  it.each([
    ['the switch off', false, 'product', 'open'],
    ['developer mode', true, 'technical', 'open'],
    ['single-thread product mode', true, 'product', 'thread']
  ] as const)('with %s they %s', (_label, flag, toolView, expected) => {
    setSingleThreadFlagForTest(flag)
    setToolViewMode(toolView)
    const calls: string[] = []

    openAnotherConversation(
      () => calls.push('open'),
      () => calls.push('thread')
    )

    expect(calls).toEqual([expected])
  })
})
