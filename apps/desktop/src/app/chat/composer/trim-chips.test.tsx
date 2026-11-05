/**
 * hc-1156 on the real chat composer: in single-thread product mode, one video
 * dropped on its own offers 剪干净 / 剪干净再加字幕 / 先找同类视频对照 in place
 * of the four link chips, and a click sends the sentence with the video riding
 * along. Off that mode the strip is pinned byte for byte in
 * src/paste-chips-identity.test.tsx.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { I18nProvider, type Locale, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { clearSessionDraft, type ComposerAttachment, mainComposerScope } from '@/store/composer'
import { $singleThreadFlag } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { DraftPasteActions } from './paste-action-chips'
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

const GROUP: Record<Locale, string> = {
  ar: 'What to do with this video',
  en: 'What to do with this video',
  ja: 'What to do with this video',
  zh: '用这条视频做什么',
  'zh-hant': '用這個影片做什麼'
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

async function renderChatBar(locale: Locale = 'zh') {
  const onSubmit = vi.fn<ChatBarProps['onSubmit']>(async () => true)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  setRuntimeI18nLocale(locale)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale={locale}>
          <ThreadRuntime messages={[]}>
            <ChatBar
              busy={false}
              disabled={false}
              onCancel={() => {}}
              onPickFiles={() => {}}
              onPickFolders={() => {}}
              onPickImages={() => {}}
              onSubmit={onSubmit}
              state={STATE}
            />
          </ThreadRuntime>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
  await settle()

  return onSubmit
}

const video = (path = '/Users/me/Movies/口播第一条.mp4'): ComposerAttachment => ({
  id: `file:${path}`,
  kind: 'file',
  label: path.split('/').pop()!,
  path
})

async function drop(...clips: ComposerAttachment[]) {
  act(() => {
    for (const clip of clips) {
      mainComposerScope.add(clip)
    }
  })
  await settle()
}

const chips = (locale: Locale = 'zh') =>
  within(screen.getByRole('group', { name: GROUP[locale] }))
    .getAllByRole('button')
    .map(button => button.textContent)

const FOUR = ['转逐字稿', '拆它为什么火', '仿写成我的脚本', '复刻成我的']

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

beforeEach(() => {
  stubThreadEnvironment()
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
})

afterEach(() => {
  cleanup()
  mainComposerScope.clear()
  clearSessionDraft(null)
  $singleThreadFlag.set(false)
  setToolViewMode('product')
  setRuntimeI18nLocale('en')
})

describe('a lone video in single-thread product mode', () => {
  it.each([
    ['zh', ['剪干净', '剪干净再加字幕', '先找同类视频对照']],
    ['zh-hant', ['剪乾淨', '剪乾淨再加字幕', '先找同類影片對照']],
    ['en', ['Clean it up', 'Clean up, then subtitle', 'Compare with similar videos first']]
  ] as const)('offers the three trim chips in %s', async (locale, labels) => {
    await renderChatBar(locale)
    await drop(video())

    expect(chips(locale)).toEqual(labels)
  })

  it('sends 把这段口播剪干净 with the video riding along, and clears the strip', async () => {
    const onSubmit = await renderChatBar()
    const clip = video()

    await drop(clip)
    fireEvent.click(screen.getByRole('button', { name: '剪干净' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const [text, options] = onSubmit.mock.calls[0]!

    expect(text).toBe('把这段口播剪干净')
    expect(options?.attachments?.map(item => item.path)).toEqual([clip.path])
    await waitFor(() => expect(screen.queryByRole('group', { name: GROUP.zh })).toBeNull())
  })

  it.each([
    ['剪干净再加字幕', '把这段口播剪干净，再加上字幕'],
    ['先找同类视频对照', '先找几条同类视频对照，再把这段口播剪干净']
  ])('sends %s as %j', async (label, request) => {
    const onSubmit = await renderChatBar()

    await drop(video())
    fireEvent.click(screen.getByRole('button', { name: label }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toBe(request)
  })

  it('keeps what the user typed before the click', async () => {
    const onSubmit = await renderChatBar()
    const editor = window.document.querySelector<HTMLElement>(`[data-slot="${RICH_INPUT_SLOT}"]`)!

    editor.append(window.document.createTextNode('价格那句后面留一下停顿'))
    fireEvent.input(editor)
    await drop(video())
    fireEvent.click(screen.getByRole('button', { name: '剪干净' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toBe('把这段口播剪干净\n价格那句后面留一下停顿')
  })
})

describe('everywhere else the four chips stay', () => {
  it('for two videos dropped together', async () => {
    await renderChatBar()
    await drop(video('/Users/me/Movies/a.mp4'), video('/Users/me/Movies/b.mov'))

    expect(chips()).toEqual(FOUR)
  })

  it('with the switch off', async () => {
    $singleThreadFlag.set(false)
    await renderChatBar()
    await drop(video())

    expect(chips()).toEqual(FOUR)
  })

  it('in developer mode', async () => {
    setToolViewMode('technical')
    await renderChatBar()
    await drop(video())

    expect(chips()).toEqual(FOUR)
  })
})

describe('the Start input’s strip follows the same rule', () => {
  it.each([
    [true, ['剪干净', '剪干净再加字幕', '先找同类视频对照'], '把这段口播剪干净'],
    [false, FOUR, '把这个视频转成逐字稿']
  ])('single-thread product mode %s', async (singleThread, labels, request) => {
    $singleThreadFlag.set(singleThread)
    setRuntimeI18nLocale('zh')

    const onSend = vi.fn()

    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <DraftPasteActions attachments={[video()]} disabled={false} draft="" onSend={onSend} pasteKey="start:test" />
      </I18nProvider>
    )
    await settle()

    expect(chips()).toEqual(labels)
    fireEvent.click(screen.getByRole('button', { name: labels[0] }))
    expect(onSend).toHaveBeenCalledWith(request)
  })
})
