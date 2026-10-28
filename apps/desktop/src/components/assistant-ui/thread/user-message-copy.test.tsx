/**
 * hc-1101: in single-thread product mode, what you sent can be copied, the way
 * APEX's replies can. 「复制」 sits in the hover rail beside the bubble. A plain
 * right-click on the bubble opens the app menu with 「复制」. The bubble's text
 * can be selected, and a drag that selects keeps the editor shut.
 *
 * Switch off and developer mode are pinned byte for byte in
 * src/user-message-identity.test.tsx; here they only show that none of this
 * reaches them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppContextMenu } from '@/app/context-menu/app-context-menu'
import { $contextMenu } from '@/app/context-menu/store'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $reactionsEnabled } from '@/store/reactions-enabled'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { createdAt, stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '../test-utils'

import { copyableMessageText } from './user-message-rail'

import { Thread } from '.'

stubThreadEnvironment()
stubThreadViewportSize()

const SENT = '先跑 `npm test`\n再看 @file:`/Users/xiaoman/脚本 v2.md` 和 @url:`https://v.douyin.com/iRemix01/`'
const SENT_AS_SHOWN = '先跑 `npm test`\n再看 /Users/xiaoman/脚本 v2.md 和 https://v.douyin.com/iRemix01/'

const desktopWindow = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }

function user(id: string, text: string, custom: Record<string, unknown> = {}): ThreadMessage {
  return {
    attachments: [],
    content: [{ text, type: 'text' }],
    createdAt,
    id,
    metadata: { custom },
    role: 'user'
  } as ThreadMessage
}

function assistant(id: string, running = false): ThreadMessage {
  return {
    content: [{ text: running ? '' : '好。', type: 'text' }],
    createdAt,
    id,
    metadata: { custom: {}, steps: [], unstable_annotations: [], unstable_data: [], unstable_state: null },
    role: 'assistant',
    status: running ? { type: 'running' } : { reason: 'stop', type: 'complete' }
  } as unknown as ThreadMessage
}

function transcript({ running = false, text = SENT } = {}): ThreadMessage[] {
  return [
    user('u-picture', '', { attachmentRefs: ['@image:`/tmp/数据截图.png`'] }),
    assistant('a-picture'),
    user('u-last', text),
    assistant('a-last', running)
  ]
}

function mode(name: 'developer' | 'off' | 'single-thread') {
  setSingleThreadFlagForTest(name !== 'off')
  setToolViewMode(name === 'developer' ? 'technical' : 'product')
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

async function renderThread(messages = transcript()) {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter>
        <ThreadRuntime messages={messages}>
          <Thread onCancel={() => {}} onRestoreToMessage={() => {}} />
        </ThreadRuntime>
        <AppContextMenu />
      </MemoryRouter>
    </I18nProvider>
  )

  await waitFor(() => expect(view.container.querySelectorAll('[data-slot="aui_user-message-root"]')).toHaveLength(2))
  await settle()

  return view
}

/** The bubble roots, in order: the picture-only message, then the latest ask. */
function userRoots(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="aui_user-message-root"]')]
}

/** The labels of the hover rail beside a bubble (the anchor's absolute child), left to right. */
function railLabels(root: HTMLElement): string[] {
  const rail = root.querySelector('[data-slot="popover-anchor"] > div')

  return rail ? [...rail.querySelectorAll('button')].map(button => button.getAttribute('aria-label') ?? '') : []
}

function bubble(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>('button.composer-human-message')!
}

let writeClipboard: ReturnType<typeof vi.fn>

beforeEach(() => {
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
  $contextMenu.set(null)
  delete desktopWindow.hermesDesktop
  setRuntimeI18nLocale('en')
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  $reactionsEnabled.set(false)
  window.getSelection()?.removeAllRanges()
  document.head.querySelectorAll('style[data-test-css]').forEach(node => node.remove())
})

describe('the hover rail beside your bubble', () => {
  it.each([
    ['single-thread', false, ['复制', '恢复检查点']],
    ['single-thread', true, ['复制', '停止']],
    ['developer', false, ['恢复检查点']],
    ['developer', true, ['停止']],
    ['off', false, ['恢复检查点']],
    ['off', true, ['停止']]
  ] as const)('%s mode (running %s): %j', async (name, running, labels) => {
    mode(name)
    await renderThread(transcript({ running }))

    expect(railLabels(userRoots()[1])).toEqual(labels)
  })

  it('offers no 复制 on a message that is only pictures (nothing to copy)', async () => {
    mode('single-thread')
    await renderThread()

    expect(railLabels(userRoots()[0])).toEqual([])
  })

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
  it('opens the app menu in single-thread mode, and its 复制 copies the whole message', async () => {
    mode('single-thread')
    await renderThread()

    fireEvent.contextMenu(bubble(userRoots()[1]).querySelector('[data-slot="aui_user-message-text"]')!)
    fireEvent.click(await screen.findByRole('menuitem', { name: '复制' }))

    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(SENT_AS_SHOWN))
  })

  it.each(['developer', 'off'] as const)('opens nothing in %s mode, as before', async name => {
    mode(name)
    await renderThread()

    fireEvent.contextMenu(bubble(userRoots()[1]).querySelector('[data-slot="aui_user-message-text"]')!)
    await settle()

    expect($contextMenu.get()).toBeNull()
  })

  it('keeps the reaction picker when reactions are on', async () => {
    mode('single-thread')
    $reactionsEnabled.set(true)
    await renderThread()

    fireEvent.contextMenu(bubble(userRoots()[1]).querySelector('[data-slot="aui_user-message-text"]')!)
    await settle()

    expect($contextMenu.get()).toBeNull()
  })

  it('copies the selection, not the whole message, when part of it is selected', async () => {
    mode('single-thread')
    await renderThread()

    const text = bubble(userRoots()[1]).querySelector('[data-slot="aui_user-inline-text"]')!
    const words = document.createTreeWalker(text, NodeFilter.SHOW_TEXT).nextNode()!
    const range = document.createRange()

    range.setStart(words, 0)
    range.setEnd(words, 2)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)

    fireEvent.contextMenu(text)
    fireEvent.click(await screen.findByRole('menuitem', { name: '复制' }))

    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('先跑'))
  })
})

describe('selecting what you sent', () => {
  // styles.css makes every button unselectable app-wide; jsdom loads no app
  // stylesheet, so that rule stands in, with the real single-thread sheet over it.
  function injectStyles() {
    const sheet = readFileSync(join(__dirname, '../../../app/single-thread/single-thread-chat.css'), 'utf8')

    for (const css of ['button, [role="button"] { user-select: none; }', sheet]) {
      const style = document.createElement('style')

      style.dataset.testCss = ''
      style.textContent = css
      document.head.appendChild(style)
    }
  }

  it.each([
    ['single-thread', 'text'],
    ['developer', 'none'],
    ['off', 'none']
  ] as const)('%s mode: the bubble text is user-select %s', async (name, expected) => {
    mode(name)
    injectStyles()
    await renderThread()

    const text = bubble(userRoots()[1]).querySelector('[data-slot="aui_user-inline-text"]')!

    expect(getComputedStyle(bubble(userRoots()[1])).userSelect).toBe(expected)
    // jsdom does not resolve a child's "auto" against its button the way Chrome does
    // (none); what matters is that only single-thread mode declares text on it.
    expect(getComputedStyle(text).userSelect).toBe(name === 'single-thread' ? 'text' : 'auto')
  })

  it('a drag that ends in a selection keeps the editor shut', async () => {
    mode('single-thread')
    await renderThread()

    const target = bubble(userRoots()[1])
    const range = document.createRange()

    range.selectNodeContents(target.querySelector('[data-slot="aui_user-inline-text"]')!)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.pointerDown(target)
    fireEvent.click(target)
    await settle()

    expect(document.querySelector('[data-slot="aui_edit-composer-root"]')).toBeNull()
    expect(document.querySelectorAll('button.composer-human-message')).toHaveLength(2)
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
