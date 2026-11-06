/**
 * hc-1159: ⌘V of a file copied in Finder on the business Start page attaches
 * it the way a drop on that page does.
 *
 * The clipboard stand-ins have the shape Chromium gives such a paste (measured
 * for hc-1158 on Electron 40 / Chrome 144, Finder-style pasteboard):
 * `types: ['Files']`, one `kind: 'file'` item whose File resolves through
 * `getPathForFile`, a folder's item reporting `isDirectory`, and empty text.
 *
 * The page here is the real Start page (launcher, attachment list, paste-to-act
 * chips) over the real `useChatFileDrops` hook, fed by the real
 * `attachDroppedItems`. Paste-to-focus is registered on window the way
 * use-keybinds registers it, and one case mounts the real ChatBar hidden behind
 * Start, as ChatView keeps it once a chat has been opened.
 */
import { useStore } from '@nanostores/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import { BusinessStartHome } from '@/app/business-workspace/start-home'
import { ChatBar } from '@/app/chat/composer'
import { handleWindowPaste } from '@/app/chat/composer/paste-to-focus'
import type { ChatBarState } from '@/app/chat/composer/types'
import { stubThreadEnvironment, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { clearSessionDraft, mainComposerScope } from '@/store/composer'
import { $singleThreadFlag } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { useChatFileDrops } from './use-chat-file-drops'
import { type DroppedFile, useComposerActions } from './use-composer-actions'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getSkills: vi.fn(async () => []),
  getMoaModels: vi.fn(async () => null)
}))

const STATE: ChatBarState = {
  model: { canSwitch: true, model: 'apex-flash', provider: 'custom' },
  tools: { enabled: true, label: 'Add context' },
  voice: { enabled: true, active: false }
}

const TAKE = '/Users/me/Movies/口播第一条.mp4'
const FOUR = ['转逐字稿', '拆它为什么火', '仿写成我的脚本', '复刻成我的']

/** Real paths behind the Files, as `webUtils.getPathForFile` reports them. */
const paths = new Map<File, string>()
const previousBridge = window.hermesDesktop

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

interface Copied {
  file: File
  path?: string
  folder?: boolean
}

function copied(path: string, type = 'video/mp4'): Copied {
  return { file: new File(['take'], path.split('/').pop()!, { type }), path }
}

/** A clipboard (or a drop's dataTransfer) as Chromium hands over a Finder copy. */
function finderCopy(entries: Copied[], text = ''): DataTransfer {
  for (const { file, path } of entries) {
    if (path) {
      paths.set(file, path)
    }
  }

  const files = entries.map(entry => entry.file)

  return {
    files: { item: (i: number) => files[i] ?? null, length: files.length },
    getData: (type: string) => (type === 'text' || type === 'text/plain' ? text : ''),
    items: entries.map(({ file, folder }) => ({
      getAsFile: () => file,
      kind: 'file',
      type: file.type,
      webkitGetAsEntry: () => ({ isDirectory: folder === true })
    })),
    types: ['Files']
  } as unknown as DataTransfer
}

interface StartSurface {
  busy?: boolean
  /** A Workflow Run or Project drawer over Start shows the chat composer. */
  chatBarVisible?: boolean
  /** ChatView keeps ChatBar mounted (hidden) behind Start once a chat was opened. */
  chatBarMounted?: boolean
  gatewayOpen?: boolean
}

type AttachSpy = Mock<(candidates: DroppedFile[]) => void>

function StartPage({ attachDropped, surface }: { attachDropped: AttachSpy; surface: StartSurface }) {
  const { busy = false, chatBarMounted = false, chatBarVisible = false, gatewayOpen = true } = surface
  const attachments = useStore(mainComposerScope.$attachments)

  const actions = useComposerActions({
    activeSessionId: null,
    currentCwd: '/work',
    requestGateway: vi.fn() as never
  })

  const onAttachDroppedItems = (candidates: DroppedFile[]) => {
    attachDropped(candidates)

    return actions.attachDroppedItems(candidates)
  }

  const { dropHandlers } = useChatFileDrops({
    busy,
    businessStartVisible: true,
    chatBarVisible,
    composerTarget: 'main',
    currentCwd: '/work',
    gatewayOpen,
    onAttachDroppedItems
  })

  return (
    <div data-composer-surface-id="start" data-composer-target="main" data-testid="chat-surface" {...dropHandlers}>
      <BusinessStartHome
        attachments={attachments}
        goalDisabled={!gatewayOpen || busy}
        onRemoveAttachment={id => mainComposerScope.remove(id)}
        onSubmitGoal={async () => true}
      />
      {(chatBarMounted || chatBarVisible) && (
        <div hidden={!chatBarVisible}>
          <ChatBar
            busy={busy}
            cwd="/work"
            disabled={!gatewayOpen}
            onAttachDroppedItems={onAttachDroppedItems}
            onCancel={() => {}}
            onPickFiles={() => {}}
            onPickFolders={() => {}}
            onPickImages={() => {}}
            onSubmit={async () => true}
            state={STATE}
          />
        </div>
      )}
    </div>
  )
}

async function renderStart(surface: StartSurface = {}) {
  const attachDropped: AttachSpy = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <ThreadRuntime messages={[]}>
            <StartPage attachDropped={attachDropped} surface={surface} />
          </ThreadRuntime>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  await settle()

  return attachDropped
}

const launcher = () => screen.getByRole('textbox', { name: '业务目标' }) as HTMLTextAreaElement

/** ⌘V with the launcher input focused. */
async function pasteInLauncher(clipboard: DataTransfer) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent

  Object.defineProperty(event, 'clipboardData', { value: clipboard })
  launcher().dispatchEvent(event)
  await settle()

  return event
}

/** ⌘V landing on the page around the launcher (nothing focused). */
async function pasteOnPage(clipboard: DataTransfer) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent

  Object.defineProperty(event, 'clipboardData', { value: clipboard })
  window.document.body.dispatchEvent(event)
  await settle()

  return event
}

const attached = () => mainComposerScope.$attachments.get().map(({ kind, path }) => ({ kind, path }))

/** The paste-to-act chips on the Start launcher (`DraftPasteActions`). */
const chips = () => {
  const form = launcher().closest('form')!
  const group = within(form).queryByRole('group', { name: '用这条视频做什么' })

  return group
    ? within(group)
        .getAllByRole('button')
        .map(button => button.textContent)
    : []
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

beforeEach(() => {
  stubThreadEnvironment()
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { ...previousBridge, getPathForFile: (file: File) => paths.get(file) ?? '' }
  })
  $authState.set({
    ...$authState.get(),
    enabled: true,
    gateReason: null,
    modelTierMax: false,
    modelTiers: true,
    status: 'signed-in'
  })
  setToolViewMode('product')
  // The Start launcher shows with single-thread mode off.
  $singleThreadFlag.set(false)
  setRuntimeI18nLocale('zh')
  window.addEventListener('paste', handleWindowPaste)
})

afterEach(() => {
  window.removeEventListener('paste', handleWindowPaste)
  cleanup()
  paths.clear()
  mainComposerScope.clear()
  clearSessionDraft(null)
  setToolViewMode('product')
  setRuntimeI18nLocale('en')
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: previousBridge })
})

describe('⌘V of a video copied in Finder on the Start page', () => {
  it.each([
    ['no text', ''],
    ['its file name as text', '口播第一条.mp4']
  ])('in the launcher input: attaches it and offers the four chips (clipboard with %s)', async (_label, text) => {
    const attachDropped = await renderStart()

    const event = await pasteInLauncher(finderCopy([copied(TAKE)], text))

    expect(event.defaultPrevented).toBe(true)
    expect(attachDropped).toHaveBeenCalledTimes(1)
    expect(attached()).toEqual([{ kind: 'file', path: TAKE }])
    expect(launcher().value).toBe('')
    expect(chips()).toEqual(FOUR)
  })

  it('on the page around the launcher: attaches it, offers the chips and focuses the launcher', async () => {
    const attachDropped = await renderStart()

    const event = await pasteOnPage(finderCopy([copied(TAKE)]))

    expect(event.defaultPrevented).toBe(true)
    expect(attachDropped).toHaveBeenCalledTimes(1)
    expect(attached()).toEqual([{ kind: 'file', path: TAKE }])
    expect(chips()).toEqual(FOUR)
    expect(window.document.activeElement).toBe(launcher())
  })

  it('hands the attach pipeline exactly what a drop of the same copy on Start hands it', async () => {
    const attachDropped = await renderStart()
    const folder: Copied = { file: new File([], '客户 素材'), folder: true, path: '/work/客户 素材' }
    const take = copied(TAKE)

    await pasteInLauncher(finderCopy([folder, take]))
    mainComposerScope.clear()
    fireEvent.drop(screen.getByTestId('chat-surface'), { dataTransfer: finderCopy([folder, take]) })
    await settle()

    expect(attachDropped).toHaveBeenCalledTimes(2)
    expect(attachDropped.mock.calls[0]).toEqual(attachDropped.mock.calls[1])
    expect(attachDropped.mock.calls[0]![0]).toEqual([
      { isDirectory: true, path: '/work/客户 素材' },
      { file: take.file, path: TAKE }
    ])
  })

  it('puts a copied folder on the visible attachment list, as a dropped folder lands there', async () => {
    await renderStart()

    await pasteInLauncher(finderCopy([{ file: new File([], '客户 素材'), folder: true, path: '/work/客户 素材' }]))

    expect(attached()).toEqual([{ kind: 'folder', path: '/work/客户 素材' }])
  })

  it('takes a copied picture too: Start has no image paste of its own, and a dropped picture attaches there', async () => {
    const attachDropped = await renderStart()
    const shot = copied('/Users/me/Desktop/截图.png', 'image/png')

    await pasteInLauncher(finderCopy([shot]))

    expect(attachDropped).toHaveBeenCalledExactlyOnceWith([{ file: shot.file, path: '/Users/me/Desktop/截图.png' }])
  })
})

describe('one paste attaches once', () => {
  it.each([
    ['in the launcher input', pasteInLauncher],
    ['on the page around it', pasteOnPage]
  ])('with ChatBar mounted hidden behind Start: %s', async (_label, paste) => {
    const attachDropped = await renderStart({ chatBarMounted: true })

    await paste(finderCopy([copied(TAKE)]))

    expect(attachDropped).toHaveBeenCalledTimes(1)
    expect(attached()).toEqual([{ kind: 'file', path: TAKE }])
  })
})

describe('where the Start page leaves the paste alone', () => {
  it('a drawer over Start shows the chat composer: a paste on the page goes to it, as before', async () => {
    const attachDropped = await renderStart({ chatBarVisible: true })
    const folder: Copied = { file: new File([], 'b-roll'), folder: true, path: '/work/b-roll' }

    await pasteOnPage(finderCopy([folder]))

    // The composer's own route: a folder becomes an inline @folder: ref, not an attachment.
    expect(attachDropped).not.toHaveBeenCalled()
    expect(attached()).toEqual([])
  })

  it('a running turn: Start takes no paste, as it takes no drop', async () => {
    const attachDropped = await renderStart({ busy: true })

    await pasteOnPage(finderCopy([copied(TAKE)]))

    expect(attachDropped).not.toHaveBeenCalled()
    expect(attached()).toEqual([])
  })

  it('a paste into another input on the page stays there', async () => {
    const attachDropped = await renderStart()
    const other = window.document.createElement('input')

    window.document.body.append(other)

    try {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent

      Object.defineProperty(event, 'clipboardData', { value: finderCopy([copied(TAKE)]) })
      other.dispatchEvent(event)
      await settle()

      expect(event.defaultPrevented).toBe(false)
      expect(attachDropped).not.toHaveBeenCalled()
    } finally {
      other.remove()
    }
  })

  it('a File with no path on disk (a screenshot) is not a copied file', async () => {
    const attachDropped = await renderStart()

    const event = await pasteInLauncher(finderCopy([{ file: new File(['x'], 'clip.mp4', { type: 'video/mp4' }) }]))

    expect(event.defaultPrevented).toBe(false)
    expect(attachDropped).not.toHaveBeenCalled()
  })

  it('plain text is left to the input', async () => {
    const attachDropped = await renderStart()

    const text = {
      files: { item: () => null, length: 0 },
      getData: (type: string) => (type === 'text' || type === 'text/plain' ? '先拆这条的开头' : ''),
      items: [],
      types: ['text/plain']
    } as unknown as DataTransfer

    const event = await pasteInLauncher(text)

    expect(event.defaultPrevented).toBe(false)
    expect(attachDropped).not.toHaveBeenCalled()
  })
})
