/**
 * hc-1101: what a message offers in single-thread product mode, in plain words
 * (Kael's pass over the Muse comparison):
 * - your bubble is just your words: a click does not open the editor, 「改一下」
 *   in the rail does, and the web addresses in it open;
 * - 「从这条重来」 and its confirm 「从这条重新开始？」 replace upstream's checkpoint words;
 *   the reply's 「刷新」 reads 「重新回答」;
 * - a message's right-click menu starts with when it was sent;
 * - 「仍在发送中」 shows under a send the gateway has left untaken for 5 seconds,
 *   and a failed send says so once (its error card), not again in a toast.
 *
 * Switch off and developer mode are pinned byte for byte in
 * src/user-message-identity.test.tsx; here they show that none of this reaches them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  acquireSubmitInFlight,
  clearSubmitInFlight,
  notifyPromptFailed,
  releaseSubmitInFlight
} from '@/app/session/hooks/use-prompt-actions/utils'
import { I18nProvider, type Locale, setRuntimeI18nLocale, TRANSLATIONS } from '@/i18n'
import { messageTimeLabel } from '@/i18n/single-thread-messages'
import { menuCaptionFor } from '@/lib/message-menu-time'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'
import {
  bubble,
  EditableRuntime,
  type Mode,
  mode,
  renderThread,
  settle,
  transcript,
  userRoots
} from '@/test/user-message-kit'

import { stubThreadEnvironment, stubThreadViewportSize } from '../test-utils'

import { useThreadCopy } from './thread-copy'
import { STILL_SENDING_AFTER_MS } from './user-message-sending'
import { splitLinks } from './user-message-text'

stubThreadEnvironment()
stubThreadViewportSize()

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }

let openExternal: ReturnType<typeof vi.fn>

beforeEach(() => {
  openExternal = vi.fn().mockResolvedValue(undefined)
  desktopWindow.hermesDesktop = {
    openExternal,
    readFileDataUrl: vi.fn().mockResolvedValue(''),
    writeClipboard: vi.fn().mockResolvedValue(undefined)
  } as unknown as Window['hermesDesktop']
  setRuntimeI18nLocale('zh')
  $activeSessionId.set('runtime-1')
  $selectedStoredSessionId.set('stored-1')
  $gatewayState.set('open')
})

afterEach(() => {
  cleanup()
  delete desktopWindow.hermesDesktop
  setRuntimeI18nLocale('en')
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  clearSubmitInFlight()
  clearNotifications()
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
})

const editor = () => screen.queryByRole('textbox', { name: /编辑消息|改一下/ })

describe('your bubble is your words; 「改一下」 opens the editor', () => {
  it('single-thread mode: a plain block, a click leaves it alone, 改一下 opens the editor', async () => {
    mode('single-thread')
    await renderThread(transcript(), EditableRuntime)

    const words = bubble(userRoots()[1])

    expect(words.tagName).toBe('DIV')
    expect(words.hasAttribute('data-user-bubble')).toBe(true)
    fireEvent.click(words)
    await settle()
    expect(editor()).toBeNull()

    const edit = within(userRoots()[1]).getByRole('button', { name: '改一下' })

    fireEvent.pointerDown(edit)
    fireEvent.click(edit)

    await waitFor(() => expect(editor()).not.toBeNull())
  })

  it.each(['developer', 'off'] as const)('%s mode: the bubble is still the click-to-edit button', async name => {
    mode(name)
    await renderThread(transcript(), EditableRuntime)

    const words = bubble(userRoots()[1])

    expect(words.tagName).toBe('BUTTON')
    expect(within(userRoots()[1]).queryByRole('button', { name: '改一下' })).toBeNull()
    fireEvent.click(words)

    await waitFor(() => expect(editor()).not.toBeNull())
  })
})

describe('the web addresses you typed open', () => {
  const TYPED = '看看 https://example.com/a?b=1。还有 @url:`https://v.douyin.com/iRemix01/`'

  it('single-thread mode: an address is a link; a middle-click opens it outside', async () => {
    mode('single-thread')
    await renderThread(transcript({ text: TYPED }), EditableRuntime)

    const links = userRoots()[1].querySelectorAll<HTMLAnchorElement>('a[data-slot="aui_user-link"]')

    expect([...links].map(link => [link.textContent, link.getAttribute('href')])).toEqual([
      ['https://example.com/a?b=1', 'https://example.com/a?b=1']
    ])
    // The reference the composer wrote still chips; it is not a second link.
    expect(within(userRoots()[1]).queryByTitle('https://v.douyin.com/iRemix01/')).not.toBeNull()

    fireEvent(links[0], new MouseEvent('auxclick', { bubbles: true, button: 1 }))

    expect(openExternal).toHaveBeenCalledWith('https://example.com/a?b=1')
    expect(editor()).toBeNull()
  })

  it.each(['developer', 'off'] as const)('%s mode: the address stays text', async name => {
    mode(name)
    await renderThread(transcript({ text: TYPED }))

    expect(userRoots()[1].querySelector('a[data-slot="aui_user-link"]')).toBeNull()
  })

  it.each([
    ['prose only', '标题用第 1 个', [{ kind: 'text', text: '标题用第 1 个' }]],
    [
      'Chinese punctuation ends the address',
      '看 https://a.com/x，再看',
      [
        { kind: 'text', text: '看 ' },
        { kind: 'link', url: 'https://a.com/x' },
        { kind: 'text', text: '，再看' }
      ]
    ],
    [
      'a trailing full stop stays prose',
      'see https://a.com/x.',
      [
        { kind: 'text', text: 'see ' },
        { kind: 'link', url: 'https://a.com/x' },
        { kind: 'text', text: '.' }
      ]
    ],
    [
      'a composer reference stays one piece',
      '@url:`https://a.com/x`',
      [{ kind: 'text', text: '@url:`https://a.com/x`' }]
    ],
    [
      'two addresses',
      'http://a.com https://b.com/p?q=1#h',
      [
        { kind: 'link', url: 'http://a.com' },
        { kind: 'text', text: ' ' },
        { kind: 'link', url: 'https://b.com/p?q=1#h' }
      ]
    ]
  ])('splitLinks: %s', (_name, text, pieces) => {
    expect(splitLinks(text)).toEqual(pieces)
  })
})

describe('starting over from a message, in plain words', () => {
  it.each([
    ['single-thread', '从这条重来', '从这条重新开始？', '这条之后的对话会清掉，再重新回答这条。', '重新开始'],
    [
      'developer',
      '恢复检查点',
      '恢复到此检查点？',
      '此提示之后的所有消息将从对话中移除，并从此处重新运行该提示。',
      '恢复并重新运行'
    ],
    [
      'off',
      '恢复检查点',
      '恢复到此检查点？',
      '此提示之后的所有消息将从对话中移除，并从此处重新运行该提示。',
      '恢复并重新运行'
    ]
  ] as const)('%s mode: the rail says %s and the confirm %s', async (name, button, title, body, confirm) => {
    mode(name as Mode)
    const onRestore = vi.fn()
    await renderThread(transcript(), undefined, onRestore)

    fireEvent.click(within(userRoots()[1]).getByRole('button', { name: button }))

    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText(title)).toBeTruthy()
    expect(within(dialog).getByText(body)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: confirm }))

    await waitFor(() => expect(onRestore).toHaveBeenCalledWith('u-last', { text: expect.any(String), userOrdinal: 1 }))
  })

  function threadCopyIn(name: Mode) {
    mode(name)

    return renderHook(() => useThreadCopy(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <I18nProvider configClient={null} initialLocale="zh">
          {children}
        </I18nProvider>
      )
    }).result.current
  }

  it('single-thread mode: every checkpoint word reads plainly (rail, versions, confirm, reply)', () => {
    expect(threadCopyIn('single-thread')).toMatchObject({
      editMessage: '改一下',
      goForward: '下一版',
      refresh: '重新回答',
      restoreBody: '这条之后的对话会清掉，再重新回答这条。',
      restoreCheckpoint: '上一版',
      restoreConfirm: '重新开始',
      restoreFromHere: '从这条重来',
      restoreNext: '看下一版',
      restorePrevious: '看上一版',
      restoreTitle: '从这条重新开始？'
    })
  })

  it.each(['developer', 'off'] as const)('%s mode: the words are upstream’s own object', name => {
    expect(threadCopyIn(name)).toBe(TRANSLATIONS.zh.assistant.thread)
  })
})

describe('the reply’s regenerate button', () => {
  it.each([
    ['single-thread', '重新回答'],
    ['developer', '刷新'],
    ['off', '刷新']
  ] as const)('%s mode: %s', async (name, label) => {
    mode(name)
    await renderThread()

    const actions = [...window.document.querySelectorAll('[data-slot="aui_msg-actions"]')].at(-1) as HTMLElement

    expect(within(actions).getByRole('button', { name: label })).toBeTruthy()
  })
})

describe('when a message was sent, on top of its menu', () => {
  const NOW = new Date(2026, 9, 28, 9, 30)

  it.each([
    ['zh', new Date(2026, 9, 28, 9, 5), '今天 09:05'],
    ['zh', new Date(2026, 9, 27, 21, 40), '昨天 21:40'],
    ['zh', new Date(2026, 9, 21, 14, 20), '10 月 21 日 周三 14:20'],
    ['zh', new Date(2025, 11, 31, 8, 0), '2025 年 12 月 31 日 周三 08:00'],
    ['zh-hant', new Date(2026, 9, 21, 14, 20), '10 月 21 日 週三 14:20'],
    ['en', new Date(2026, 9, 28, 9, 5), 'Today 09:05'],
    ['en', new Date(2026, 9, 21, 14, 20), 'Wed, Oct 21 14:20']
  ] as const)('%s %s → %s', (locale, at, label) => {
    expect(messageTimeLabel(locale as Locale, at, NOW)).toBe(label)
  })

  it('reads data-message-at off the nearest message, and nothing anywhere else', () => {
    const host = window.document.createElement('div')

    host.innerHTML = `<div data-message-at="${new Date(2026, 9, 28, 9, 5).getTime()}"><p>words</p></div><p>elsewhere</p>`
    window.document.body.appendChild(host)

    expect(menuCaptionFor(host.querySelector('div p'), NOW)).toBe('今天 09:05')
    expect(menuCaptionFor(host.querySelector(':scope > p'), NOW)).toBeUndefined()
    host.remove()
  })
})

describe('「仍在发送中」 under a send the gateway has not taken', () => {
  function sentNow(heldFor: number) {
    const now = Date.now()

    // The hold is taken first, the bubble right after it (submit.ts).
    acquireSubmitInFlight('stored-1', now - heldFor)

    return transcript({ running: true, sentAt: new Date(now - heldFor + 20) })
  }

  it.each(['developer', 'off'] as const)('%s mode: never', async name => {
    mode(name)
    await renderThread(sentNow(STILL_SENDING_AFTER_MS + 1_000))

    expect(window.document.querySelector('[data-still-sending]')).toBeNull()
  })

  it('single-thread mode: shows after 5 seconds, under the latest message, and goes when the gateway takes it', async () => {
    mode('single-thread')
    await renderThread(sentNow(STILL_SENDING_AFTER_MS - 120))

    expect(window.document.querySelector('[data-still-sending]')).toBeNull()

    await waitFor(() => expect(window.document.querySelector('[data-still-sending]')?.textContent).toBe('仍在发送中'))
    expect(userRoots()[1].querySelector('[data-still-sending]')).not.toBeNull()
    expect(userRoots()[0].querySelector('[data-still-sending]')).toBeNull()

    releaseSubmitInFlight('stored-1')

    await waitFor(() => expect(window.document.querySelector('[data-still-sending]')).toBeNull())
  })

  it('single-thread mode: a hold taken after the latest message was sent is not about it', async () => {
    mode('single-thread')
    const now = Date.now()

    acquireSubmitInFlight('stored-1', now - STILL_SENDING_AFTER_MS - 1_000)
    await renderThread(transcript({ sentAt: new Date(now - STILL_SENDING_AFTER_MS - 60_000) }))

    expect(window.document.querySelector('[data-still-sending]')).toBeNull()
  })

  it('single-thread mode: a brand-new conversation’s send counts too', async () => {
    mode('single-thread')
    $selectedStoredSessionId.set(null)
    $activeSessionId.set(null)
    const now = Date.now()

    acquireSubmitInFlight('__pending_new__', now - STILL_SENDING_AFTER_MS - 500)
    await renderThread(transcript({ running: true, sentAt: new Date(now - STILL_SENDING_AFTER_MS - 480) }))

    expect(window.document.querySelector('[data-still-sending]')?.textContent).toBe('仍在发送中')
  })
})

describe('a failed send says so once', () => {
  it.each([
    ['single-thread', 0],
    ['developer', 1],
    ['off', 1]
  ] as const)('%s mode: %i toast beside the error card', (name, toasts) => {
    mode(name)
    notifyPromptFailed(new Error('gateway closed'), '发送失败')

    expect($notifications.get()).toHaveLength(toasts)
  })

  // The census: the one place a failed prompt toasts is submit.ts's catch, right
  // after it adds the error card, and it goes through the single-thread gate.
  it('submit.ts toasts a failed prompt only through notifyPromptFailed', () => {
    const submit = readFileSync(join(__dirname, '../../../app/session/hooks/use-prompt-actions/submit.ts'), 'utf8')

    expect(submit.match(/notifyPromptFailed\(err, copy\.promptFailed\)/g)).toHaveLength(1)
    expect(submit).not.toMatch(/notifyError\(\w+, copy\.promptFailed\)/)
  })
})
