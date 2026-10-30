/**
 * hc-1101: in single-thread product mode, what you sent can be copied, the way
 * APEX's replies can:
 * - 「复制」 sits in the hover rail beside the bubble;
 * - a plain right-click on the bubble opens the app menu, with the message's
 *   time on top and 「复制」 under it;
 * - the bubble's text can be selected.
 *
 * Switch off and developer mode are pinned byte for byte in
 * src/user-message-identity.test.tsx; here they show what reaches them. Since
 * hc-1105 that is the selectable words and the right-click 「复制」, without the
 * time; the rail stays as it was (user-message-select.test.tsx has the rest).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $contextMenu } from '@/app/context-menu/store'
import { setRuntimeI18nLocale } from '@/i18n'
import { $reactionsEnabled } from '@/store/reactions-enabled'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'
import {
  assistant,
  bubble,
  bubbleText,
  mode,
  ownMessageSelectRule,
  railLabels,
  renderThread,
  SENT_AS_SHOWN,
  settle,
  transcript,
  user,
  userRoots
} from '@/test/user-message-kit'

import { stubThreadEnvironment, stubThreadViewportSize } from '../test-utils'

import { copyableMessageText } from './user-message-rail'

stubThreadEnvironment()
stubThreadViewportSize()

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }

let writeClipboard: ReturnType<typeof vi.fn>

beforeEach(() => {
  // The menu's time line reads the clock: half an hour after the message was sent.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 28, 9, 30))
  writeClipboard = vi.fn().mockResolvedValue(undefined)
  desktopWindow.hermesDesktop = {
    // The picture-only message's thumbnail reads its file through the bridge.
    readFileDataUrl: vi.fn().mockResolvedValue(''),
    writeClipboard
  } as unknown as Window['hermesDesktop']
  setRuntimeI18nLocale('zh')
  $activeSessionId.set('session-copy')
  $gatewayState.set('open')
  $reactionsEnabled.set(false)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  $contextMenu.set(null)
  delete desktopWindow.hermesDesktop
  setRuntimeI18nLocale('en')
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  $reactionsEnabled.set(false)
  window.getSelection()?.removeAllRanges()
  window.document.head.querySelectorAll('style[data-test-css]').forEach(node => node.remove())
})

describe('the hover rail beside your bubble', () => {
  it.each([
    ['single-thread', false, ['复制', '改一下', '从这条重来']],
    ['single-thread', true, ['复制', '改一下', '停止']],
    ['developer', false, ['恢复检查点']],
    ['developer', true, ['停止']],
    ['off', false, ['恢复检查点']],
    ['off', true, ['停止']]
  ] as const)('%s mode (running %s): %j', async (name, running, labels) => {
    mode(name)
    await renderThread(transcript({ running }))

    expect(railLabels(userRoots()[1])).toEqual(labels)
  })

  it.each(['single-thread', 'developer', 'off'] as const)(
    '%s mode: a message that is only pictures has no rail at all (nothing to copy, edit or restore)',
    async name => {
      mode(name)
      await renderThread()

      expect(userRoots()[0].querySelector('[data-slot="popover-anchor"] > div:not([data-user-bubble])')).toBeNull()
    }
  )

  it('copies the message as the bubble shows it, and says it did', async () => {
    mode('single-thread')
    await renderThread()

    const copy = within(userRoots()[1]).getByRole('button', { name: '复制' })

    fireEvent.click(copy)

    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(SENT_AS_SHOWN))
    await waitFor(() => expect(copy.getAttribute('aria-label')).toBe('已复制'))
  })
})

describe('a plain right-click on your bubble', () => {
  it('opens the app menu in single-thread mode: the time on top, then 复制 for the whole message', async () => {
    mode('single-thread')
    await renderThread()

    fireEvent.contextMenu(bubbleText(userRoots()[1]))

    const menu = await screen.findByRole('menu')

    expect(within(menu).getByText('今天 09:00')).toBeTruthy()
    expect(menu.textContent).toBe('今天 09:00复制')
    fireEvent.click(within(menu).getByRole('menuitem', { name: '复制' }))

    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(SENT_AS_SHOWN))
  })

  it.each(['developer', 'off'] as const)(
    'opens 复制 for the whole message in %s mode, with no time on top (hc-1105)',
    async name => {
      mode(name)
      await renderThread()

      fireEvent.contextMenu(bubbleText(userRoots()[1]))

      const menu = await screen.findByRole('menu')

      expect(menu.textContent).toBe('复制')
      fireEvent.click(within(menu).getByRole('menuitem', { name: '复制' }))

      await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(SENT_AS_SHOWN))
    }
  )

  it.each(['single-thread', 'developer', 'off'] as const)(
    'keeps the reaction picker when reactions are on (%s mode)',
    async name => {
      mode(name)
      $reactionsEnabled.set(true)
      await renderThread()

      fireEvent.contextMenu(bubbleText(userRoots()[1]))
      await settle()

      expect($contextMenu.get()).toBeNull()
    }
  )

  it.each([
    ['single-thread', '今天 09:00'],
    ['developer', null],
    ['off', null]
  ] as const)(
    '%s mode: with part of it selected, 复制 copies the selection (time on top: %s)',
    async (name, caption) => {
      mode(name)
      await renderThread()

      const text = bubbleText(userRoots()[1])
      const words = window.document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode()!
      const range = window.document.createRange()

      range.setStart(words, 0)
      range.setEnd(words, 2)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)

      fireEvent.contextMenu(text)

      const menu = await screen.findByRole('menu')

      expect(menu.textContent).toBe(`${caption ?? ''}复制`)
      fireEvent.click(within(menu).getByRole('menuitem', { name: '复制' }))

      await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('先跑'))
    }
  )
})

describe('selecting what you sent', () => {
  // styles.css makes every button unselectable app-wide; jsdom loads no app
  // stylesheet, so that rule stands in, with hc-1105's rule from styles.css and
  // the real single-thread sheet over it.
  function injectStyles() {
    const sheet = readFileSync(join(__dirname, '../../../app/single-thread/single-thread-chat.css'), 'utf8')

    for (const css of ['button, [role="button"] { user-select: none; }', ownMessageSelectRule(), sheet]) {
      const style = window.document.createElement('style')

      style.dataset.testCss = ''
      style.textContent = css
      window.document.head.appendChild(style)
    }
  }

  it.each(['single-thread', 'developer', 'off'] as const)(
    '%s mode: the bubble and its words are user-select text',
    async name => {
      mode(name)
      injectStyles()
      await renderThread()

      expect(getComputedStyle(bubble(userRoots()[1])).userSelect).toBe('text')
      // jsdom does not resolve a child's "auto" against its button the way Chrome does,
      // so the words carry text themselves (hc-1101's sheet, hc-1105's rule).
      expect(getComputedStyle(bubbleText(userRoots()[1])).userSelect).toBe('text')
    }
  )

  it('single-thread mode: the rail moves beside the bubble; the bubble itself stays put', async () => {
    mode('single-thread')
    injectStyles()
    await renderThread()

    const rail = userRoots()[1].querySelector<HTMLElement>(
      '[data-slot="popover-anchor"] > div:not([data-user-bubble])'
    )!

    expect(getComputedStyle(rail).right).toBe('calc(100% + 4px)')
    expect(getComputedStyle(bubble(userRoots()[1])).right).toBe('auto')
  })
})

describe('a hand-over never brings its header to the clipboard', () => {
  // A relay's hand-over opens with this one-line header (R3's request header); R2
  // takes it out of the bubble's own text, which is what both copies read.
  const HANDED_OVER = '<!-- apex:handoff v=1 id=h-1 from=default -->\n【剪辑师 交来的活】\n要你做：粗剪'

  it('copies the hand-over without its header, from the rail and from the menu', async () => {
    mode('single-thread')
    await renderThread(transcript({ text: HANDED_OVER }))

    fireEvent.click(within(userRoots()[1]).getByRole('button', { name: '复制' }))
    await waitFor(() => expect(writeClipboard).toHaveBeenLastCalledWith('【剪辑师 交来的活】\n要你做：粗剪'))

    fireEvent.contextMenu(bubbleText(userRoots()[1]))
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: '复制' }))
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledTimes(2))

    expect(writeClipboard).toHaveBeenLastCalledWith('【剪辑师 交来的活】\n要你做：粗剪')
    expect(writeClipboard.mock.calls.flat().join('')).not.toContain('apex:')
  })
})

describe('a plain right-click on APEX’s reply', () => {
  const REPLY = '1.2 万比你前几条都高。\n\n<!-- apex:next\n按这个改下一条 | 按这个改下一条\n-->'
  const replies = () => [user('u-ask', '发了，1.2 万播放'), assistant('a-reply', false, REPLY)]
  const words = () =>
    [...window.document.querySelectorAll<HTMLElement>('[data-slot="aui_assistant-message-root"] .aui-md')].at(-1)!

  it('single-thread mode: its time on top, then 复制 for the reply as you read it (no 下一步 block)', async () => {
    mode('single-thread')
    await renderThread(replies())

    fireEvent.contextMenu(words())

    const menu = await screen.findByRole('menu')

    expect(menu.textContent).toBe('今天 09:00复制')
    fireEvent.click(within(menu).getByRole('menuitem', { name: '复制' }))

    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('1.2 万比你前几条都高。'))
  })

  it.each(['developer', 'off'] as const)('%s mode: the shell menu, as before', async name => {
    mode(name)
    await renderThread(replies())

    fireEvent.contextMenu(words())

    expect((await screen.findByRole('menu')).textContent).toContain('新建会话')
  })

  it('single-thread mode: the transcript’s blank space keeps the shell menu', async () => {
    mode('single-thread')
    await renderThread(replies())

    fireEvent.contextMenu(window.document.querySelector('[data-slot="aui_thread-viewport"]')!)

    const menu = await screen.findByRole('menu')

    expect(menu.textContent).toContain('新建会话')
    expect(menu.textContent).not.toContain('今天')
  })

  it('single-thread mode: with part of it selected, 复制 copies the selection, time on top', async () => {
    mode('single-thread')
    await renderThread(replies())

    const text = window.document.createTreeWalker(words(), NodeFilter.SHOW_TEXT).nextNode()!
    const range = window.document.createRange()

    range.setStart(text, 0)
    range.setEnd(text, 5)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)

    fireEvent.contextMenu(words())

    const menu = await screen.findByRole('menu')

    expect(menu.textContent).toBe('今天 09:00复制')
    fireEvent.click(within(menu).getByRole('menuitem', { name: '复制' }))

    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('1.2 万'))
  })
})

describe('copyableMessageText: your message as the bubble shows it', () => {
  it.each([
    ['plain words, trimmed', '  标题用第 1 个 \n', '标题用第 1 个'],
    ['a quoted file reference', '看 @file:`/Users/x/a b.md` 这个', '看 /Users/x/a b.md 这个'],
    ['a bare file reference keeps the prose after it', '看 @file:src/a.ts，再改', '看 src/a.ts，再改'],
    ['a link reference', '@url:`https://example.com/a?b=1` 拆一下', 'https://example.com/a?b=1 拆一下'],
    ['a double-quoted folder', '@folder:"My Docs" 里', 'My Docs 里'],
    ['inline code stays as typed', '先跑 `npm test`', '先跑 `npm test`'],
    [
      'a fenced block stays as typed, references and all',
      '看：\n```\n@file:`a.md`\n```',
      '看：\n```\n@file:`a.md`\n```'
    ],
    ['text and fence together', '@file:`a b.md`\n```ts\nconst x = 1\n```', 'a b.md\n```ts\nconst x = 1\n```']
  ])('%s', (_name, input, expected) => {
    expect(copyableMessageText(input)).toBe(expected)
  })
})
