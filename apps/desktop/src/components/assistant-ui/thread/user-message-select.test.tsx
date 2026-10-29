/**
 * hc-1105: with the switch off and in developer mode, your own message selects
 * and copies, and a plain click still opens the editor, as upstream has it:
 * - the bubble's words select (styles.css); the rail's buttons do not;
 * - a press that ends as a selection opens no editor and lets the thread's
 *   scroll hold go; ⌘C and the app menu's 「复制」 then copy what you selected;
 * - a press that only clears an earlier selection opens the editor, held;
 * - a right-click is the copy menu (user-message-copy.test.tsx) and never holds.
 *
 * Single-thread product mode's bubble is hc-1101's plain block
 * (user-message-actions.test.tsx), which has no press to settle.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $contextMenu } from '@/app/context-menu/store'
import { setRuntimeI18nLocale } from '@/i18n'
import { $reactionsEnabled } from '@/store/reactions-enabled'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'
import {
  bubble,
  bubbleText,
  EditableRuntime,
  mode,
  ownMessageSelectRule,
  renderThread,
  settle,
  transcript,
  userRoots
} from '@/test/user-message-kit'

import { stubThreadEnvironment, stubThreadViewportSize } from '../test-utils'

stubThreadEnvironment()
stubThreadViewportSize()

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const CLICK_TO_EDIT = ['developer', 'off'] as const

let writeClipboard: ReturnType<typeof vi.fn>

beforeEach(() => {
  writeClipboard = vi.fn().mockResolvedValue(undefined)
  desktopWindow.hermesDesktop = {
    readFileDataUrl: vi.fn().mockResolvedValue(''),
    writeClipboard
  } as unknown as Window['hermesDesktop']
  setRuntimeI18nLocale('zh')
  $activeSessionId.set('session-select')
  $gatewayState.set('open')
  $reactionsEnabled.set(false)
})

afterEach(() => {
  cleanup()
  $contextMenu.set(null)
  delete desktopWindow.hermesDesktop
  setRuntimeI18nLocale('en')
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  window.getSelection()?.removeAllRanges()
  window.document.head.querySelectorAll('style[data-test-css]').forEach(node => node.remove())
})

const editor = () => screen.queryByRole('textbox', { name: /编辑消息|改一下/ })
const held = () => window.document.querySelector('[data-slot="aui_thread-viewport"]')?.getAttribute('data-editing')

/** Select the first `length` characters of an element's words, the way a drag leaves them. */
function selectWords(element: HTMLElement, length: number) {
  const words = window.document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!
  const range = window.document.createRange()

  range.setStart(words, 0)
  range.setEnd(words, length)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
}

async function ownMessage(name: (typeof CLICK_TO_EDIT)[number]) {
  mode(name)
  await renderThread(transcript(), EditableRuntime)

  return userRoots()[1]
}

describe('what selects', () => {
  // jsdom loads no app stylesheet: the app-wide "buttons do not select" rule stands in, with hc-1105's over it.
  function injectStyles() {
    for (const css of ['button, [role="button"] { user-select: none; }', ownMessageSelectRule()]) {
      const style = window.document.createElement('style')

      style.dataset.testCss = ''
      style.textContent = css
      window.document.head.appendChild(style)
    }
  }

  it.each(CLICK_TO_EDIT)(
    '%s mode: the bubble and its words; the rail’s restore button stays unselectable',
    async name => {
      injectStyles()

      const root = await ownMessage(name)

      expect(bubble(root).tagName).toBe('BUTTON')
      expect(getComputedStyle(bubble(root)).userSelect).toBe('text')
      expect(getComputedStyle(bubbleText(root)).userSelect).toBe('text')
      expect(getComputedStyle(within(root).getByRole('button', { name: '恢复检查点' })).userSelect).toBe('none')
    }
  )
})

describe('a press on your bubble', () => {
  it.each(CLICK_TO_EDIT)('%s mode: a plain click holds from the press and opens the editor', async name => {
    const root = await ownMessage(name)

    fireEvent.pointerDown(bubble(root), { button: 0 })
    expect(held()).toBe('true')
    fireEvent.pointerUp(window, { button: 0 })
    fireEvent.click(bubble(root))

    await waitFor(() => expect(editor()).not.toBeNull())
    expect(held()).toBe('true')
  })

  it.each(CLICK_TO_EDIT)(
    '%s mode: one that ends as a selection opens no editor, lets the hold go, and 复制 copies the selection',
    async name => {
      const root = await ownMessage(name)

      fireEvent.pointerDown(bubble(root), { button: 0 })
      expect(held()).toBe('true')
      selectWords(bubbleText(root), 2)
      fireEvent.pointerUp(window, { button: 0 })
      expect(held()).toBeNull()

      fireEvent.click(bubble(root))
      await settle()
      expect(editor()).toBeNull()
      expect(window.getSelection()!.toString()).toBe('先跑')

      fireEvent.contextMenu(bubbleText(root))
      fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: '复制' }))

      await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('先跑'))
    }
  )

  it.each(CLICK_TO_EDIT)('%s mode: a drag that ends past the bubble lets the hold go too', async name => {
    const root = await ownMessage(name)
    const reply = window.document.querySelectorAll('[data-slot="aui_assistant-message-root"]')[1]!

    fireEvent.pointerDown(bubble(root), { button: 0 })
    selectWords(bubbleText(root), 2)
    fireEvent.pointerUp(reply, { button: 0 })
    await settle()

    expect(held()).toBeNull()
    expect(editor()).toBeNull()
  })

  it.each(CLICK_TO_EDIT)('%s mode: one that only clears an earlier selection opens the editor, held', async name => {
    const root = await ownMessage(name)

    selectWords(bubbleText(root), 2)
    fireEvent.pointerDown(bubble(root), { button: 0 })
    expect(held()).toBeNull()
    // The press collapses the old selection before the button goes up, as Chrome does.
    window.getSelection()!.removeAllRanges()
    fireEvent.pointerUp(window, { button: 0 })
    expect(held()).toBe('true')
    fireEvent.click(bubble(root))

    await waitFor(() => expect(editor()).not.toBeNull())
    expect(held()).toBe('true')
  })

  it.each(CLICK_TO_EDIT)('%s mode: a right-click never holds; it opens 复制', async name => {
    const root = await ownMessage(name)

    fireEvent.pointerDown(bubble(root), { button: 2 })
    fireEvent.pointerUp(window, { button: 2 })
    fireEvent.contextMenu(bubbleText(root))

    expect((await screen.findByRole('menu')).textContent).toBe('复制')
    expect(held()).toBeNull()
    expect(editor()).toBeNull()
  })

  it.each(CLICK_TO_EDIT)('%s mode: a cancelled press leaves nothing listening for a later one', async name => {
    const root = await ownMessage(name)

    fireEvent.pointerDown(bubble(root), { button: 0 })
    fireEvent.pointerCancel(window)
    expect(held()).toBe('true')

    // A later drag elsewhere ends as a selection; the cancelled press is no longer waiting for it.
    selectWords(bubbleText(root), 2)
    fireEvent.pointerUp(window, { button: 0 })

    expect(held()).toBe('true')
  })
})
