/**
 * hc-1158: ⌘V of a file copied in Finder attaches it the way a drop does.
 *
 * The clipboard stand-ins below have the shape Chromium gives such a paste
 * (measured on Electron 40 / Chrome 144 with a Finder-style pasteboard):
 * `types: ['Files']`, one `kind: 'file'` item per copied entry whose File
 * resolves through `getPathForFile`, a folder's item reporting `isDirectory`,
 * and empty text. A variant carrying the file name as text stands in for a
 * platform that adds it.
 *
 * The composer here is the real ChatBar fed by the real `attachDroppedItems`,
 * so a paste runs the whole path to the attachment store and the chip strip.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import { stubThreadEnvironment, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { clearSessionDraft, mainComposerScope } from '@/store/composer'
import { $singleThreadFlag } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { type DroppedFile, useComposerActions } from '../hooks/use-composer-actions'

import { onComposerAttachImagesRequest, onComposerFocusRequest } from './focus'
import { copiedFilesInClipboard } from './paste-files'
import { handleWindowPaste, routeClipboardToComposer } from './paste-to-focus'
import { RICH_INPUT_SLOT } from './rich-editor'
import type { ChatBarProps, ChatBarState } from './types'

import { ChatBar } from '.'

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
const TRIM = ['剪干净', '剪干净再加字幕', '先找同类视频对照']
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

/** A clipboard as Chromium hands over a Finder copy. */
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

function textOnly(text: string): DataTransfer {
  return {
    files: { item: () => null, length: 0 },
    getData: (type: string) => (type === 'text' || type === 'text/plain' ? text : ''),
    items: [],
    types: ['text/plain']
  } as unknown as DataTransfer
}

interface Spies {
  attachDropped: Mock<(candidates: DroppedFile[]) => void>
  attachImage: Mock<NonNullable<ChatBarProps['onAttachImageBlob']>>
  pasteClipboardImage: Mock<NonNullable<ChatBarProps['onPasteClipboardImage']>>
}

function ChatBarWithActions({ spies }: { spies: Spies }) {
  const actions = useComposerActions({
    activeSessionId: null,
    currentCwd: '/work',
    requestGateway: vi.fn() as never
  })

  const onAttachDroppedItems: ChatBarProps['onAttachDroppedItems'] = candidates => {
    spies.attachDropped(candidates)

    return actions.attachDroppedItems(candidates)
  }

  return (
    <ChatBar
      busy={false}
      cwd="/work"
      disabled={false}
      onAttachDroppedItems={onAttachDroppedItems}
      onAttachImageBlob={spies.attachImage}
      onCancel={() => {}}
      onPasteClipboardImage={spies.pasteClipboardImage}
      onPickFiles={() => {}}
      onPickFolders={() => {}}
      onPickImages={() => {}}
      onSubmit={async () => true}
      state={STATE}
    />
  )
}

async function renderComposer(): Promise<Spies> {
  const spies: Spies = {
    attachDropped: vi.fn<(candidates: DroppedFile[]) => void>(),
    attachImage: vi.fn<NonNullable<ChatBarProps['onAttachImageBlob']>>(),
    pasteClipboardImage: vi.fn<NonNullable<ChatBarProps['onPasteClipboardImage']>>()
  }

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <ThreadRuntime messages={[]}>
            <ChatBarWithActions spies={spies} />
          </ThreadRuntime>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  await settle()

  return spies
}

const editor = () => window.document.querySelector<HTMLElement>(`[data-slot="${RICH_INPUT_SLOT}"]`)!

async function paste(clipboard: DataTransfer) {
  fireEvent.paste(editor(), { clipboardData: clipboard })
  await settle()
}

/** ⌘V landing on the transcript or the window body, not on the composer. */
async function pasteOutside(clipboard: DataTransfer) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent

  Object.defineProperty(event, 'clipboardData', { value: clipboard })
  Object.defineProperty(event, 'target', { value: window.document.body })
  handleWindowPaste(event)
  await settle()

  return event
}

const attached = () => mainComposerScope.$attachments.get().map(({ kind, path }) => ({ kind, path }))

const chips = () => {
  const group = screen.queryByRole('group', { name: '用这条视频做什么' })

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
  $singleThreadFlag.set(true)
  setRuntimeI18nLocale('zh')
})

afterEach(() => {
  cleanup()
  paths.clear()
  mainComposerScope.clear()
  clearSessionDraft(null)
  $singleThreadFlag.set(false)
  setToolViewMode('product')
  setRuntimeI18nLocale('en')
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: previousBridge })
})

describe('⌘V of a video copied in Finder, composer focused', () => {
  it.each([
    ['no text', ''],
    ['its file name as text', '口播第一条.mp4']
  ])('attaches it like a drop and offers the trim chips (clipboard with %s)', async (_label, text) => {
    const spies = await renderComposer()

    await paste(finderCopy([copied(TAKE)], text))

    expect(attached()).toEqual([{ kind: 'file', path: TAKE }])
    expect(editor().textContent).toBe('')
    expect(chips()).toEqual(TRIM)
    // Nothing reaches the empty-paste clipboard-image read (it would pick up a Finder icon).
    expect(spies.pasteClipboardImage).not.toHaveBeenCalled()
  })

  it('offers the four chips with the single-thread switch off, the same as a dropped video', async () => {
    $singleThreadFlag.set(false)
    await renderComposer()

    await paste(finderCopy([copied(TAKE)]))

    expect(attached()).toEqual([{ kind: 'file', path: TAKE }])
    expect(chips()).toEqual(FOUR)
  })

  it('hands the attach pipeline exactly what a drop of the same copy hands it', async () => {
    const spies = await renderComposer()
    const take = copied(TAKE)

    await paste(finderCopy([take]))
    mainComposerScope.clear()
    fireEvent.drop(editor(), { dataTransfer: finderCopy([take]) })
    await settle()

    expect(spies.attachDropped).toHaveBeenCalledTimes(2)
    expect(spies.attachDropped.mock.calls[0]).toEqual(spies.attachDropped.mock.calls[1])
    expect(spies.attachDropped.mock.calls[0]![0]).toEqual([{ file: take.file, path: TAKE }])
  })

  it('puts a copied folder in as the @folder: chip a dropped folder becomes', async () => {
    const spies = await renderComposer()
    const folder: Copied = { file: new File([], '客户 素材'), folder: true, path: '/work/客户 素材' }

    await paste(finderCopy([folder]))

    expect(spies.attachDropped).not.toHaveBeenCalled()
    expect(editor().querySelector('[data-ref-text]')?.getAttribute('data-ref-text')).toBe('@folder:`客户 素材`')
  })
})

describe('pastes that are not copied files keep their old path', () => {
  it('a copied image file stays with the image-blob attach', async () => {
    const spies = await renderComposer()
    const shot = copied('/Users/me/Desktop/截图.png', 'image/png')

    await paste(finderCopy([shot]))

    expect(spies.attachImage).toHaveBeenCalledExactlyOnceWith(shot.file)
    expect(spies.attachDropped).not.toHaveBeenCalled()
  })

  it('a File with no path on disk is not a copied file', async () => {
    const spies = await renderComposer()

    await paste(finderCopy([{ file: new File(['x'], 'clip.mp4', { type: 'video/mp4' }) }]))

    expect(spies.attachDropped).not.toHaveBeenCalled()
    expect(attached()).toEqual([])
    expect(spies.pasteClipboardImage).toHaveBeenCalledExactlyOnceWith({ silent: true })
  })

  it('plain text still goes into the input', async () => {
    const spies = await renderComposer()

    await paste(textOnly('价格那句后面留一下停顿'))

    expect(editor().textContent).toBe('价格那句后面留一下停顿')
    expect(spies.attachDropped).not.toHaveBeenCalled()
  })
})

describe('⌘V of a copied video with the composer unfocused (paste-to-focus)', () => {
  it('reaches the active composer and attaches it there', async () => {
    const spies = await renderComposer()
    const event = await pasteOutside(finderCopy([copied(TAKE)]))

    expect(event.defaultPrevented).toBe(true)
    expect(spies.attachDropped).toHaveBeenCalledTimes(1)
    expect(attached()).toEqual([{ kind: 'file', path: TAKE }])
    expect(chips()).toEqual(TRIM)
  })

  it('routes the copy and pulls focus, without sending it as an image or as text', async () => {
    const focused: boolean[] = []
    const images: Blob[][] = []
    const offFocus = onComposerFocusRequest(() => focused.push(true))
    const offImages = onComposerAttachImagesRequest(({ blobs }) => images.push(blobs))

    expect(routeClipboardToComposer(finderCopy([copied(TAKE)], '口播第一条.mp4'))).toBe(true)
    await settle()
    offFocus()
    offImages()

    expect(focused).toEqual([true])
    expect(images).toEqual([])
  })
})

describe('copiedFilesInClipboard', () => {
  it('keeps path-backed files and folders, leaves images and pathless Files out', () => {
    const take = copied(TAKE)
    const folder: Copied = { file: new File([], 'b-roll'), folder: true, path: '/work/b-roll' }
    const shot = copied('/Users/me/Desktop/截图.png', 'image/png')
    const pathless: Copied = { file: new File(['x'], 'clip.mov', { type: 'video/quicktime' }) }

    expect(copiedFilesInClipboard(finderCopy([take, folder, shot, pathless]))).toEqual([
      { file: take.file, path: TAKE },
      { isDirectory: true, path: '/work/b-roll' }
    ])
  })
})
