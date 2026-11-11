/**
 * hc-1201: the titlebar's 剪辑 (lib/openfilm-editor-entry.ts). Kael: 「在右上角的打开设置旁边加一个手动打开、
 * 隐藏的开关，如果是第一次打开默认先检查环境，下载编辑器工具包」. While the editor shows, the switch hides it;
 * ready, it opens the newest film of the conversation on screen, else the project last opened, else says how
 * one comes about; not ready, it checks, installs as the person asked, shows how far, and opens when ready.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $openfilmSetup,
  closeOpenfilmSetup,
  OPENFILM_SETUP_POLL_MS,
  openOpenfilmEditor,
  retryOpenfilmSetup,
  toggleOpenfilmEditor
} from '@/lib/openfilm-editor-entry'
import { $openfilmStudioOn, OPENFILM_STUDIO_TAB_ID } from '@/lib/openfilm-studio'
import { $previewTabs, closeRightRail } from '@/store/preview'
import { $previewStatusBySession } from '@/store/preview-status'
import { $activeSessionId } from '@/store/session'

const STUDIO_URL = 'http://127.0.0.1:53327/open?key=k'

type Status = { on: boolean; preparing: boolean; ready: boolean }
type Bridge = NonNullable<Window['hermesDesktop']['openfilmStudio']>

const ROOM = { free: 9e9, needed: 7e8 }

function stub(over: Partial<Bridge> & { statuses?: Status[] } = {}) {
  const statuses = over.statuses ?? [{ on: true, ready: true, preparing: false }]
  let asked = 0

  const bridge = {
    check: vi.fn(async () => ({ browser: { ready: true, bytes: 1 }, toolkit: { ready: false, bytes: 2 }, disk: ROOM })),
    lastProject: vi.fn(async () => null),
    open: vi.fn(async (folder: string) => ({ ok: true as const, url: `${STUDIO_URL}&for=${encodeURIComponent(folder)}` })),
    prefetch: vi.fn(async () => 'started' as const),
    progress: vi.fn(async () => ({ failed: false, progress: null })),
    status: vi.fn(async () => statuses[Math.min(asked++, statuses.length - 1)]),
    ...over
  } as Bridge

  window.hermesDesktop = { ...(window.hermesDesktop ?? {}), openfilmStudio: bridge } as Window['hermesDesktop']

  return bridge
}

/** The conversation on screen, with its preview rows (newest last), as the composer's status stack keeps them. */
function rows(...targets: string[]) {
  $activeSessionId.set('s1')
  $previewStatusBySession.set({
    s1: targets.map(target => ({ cwd: '/work', id: target, label: target.split('/').pop() ?? target, target }))
  })
}

const studioTab = () => $previewTabs.get().find(tab => tab.id === OPENFILM_STUDIO_TAB_ID)

describe('the titlebar’s 剪辑', () => {
  const original = window.hermesDesktop

  beforeEach(() => {
    closeRightRail()
    closeOpenfilmSetup()
    $openfilmStudioOn.set(true)
    $previewStatusBySession.set({})
    $activeSessionId.set(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    closeOpenfilmSetup()
    closeRightRail()
    $openfilmStudioOn.set(false)
    window.hermesDesktop = original
  })

  it('while the editor shows, hides it: its tab closes, main is not asked', async () => {
    const bridge = stub()
    $previewTabs.set([{ id: OPENFILM_STUDIO_TAB_ID, target: { kind: 'url', label: 'cook', source: 's', url: STUDIO_URL } }])

    await toggleOpenfilmEditor(true)

    expect(studioTab()).toBeUndefined()
    expect(bridge.status).not.toHaveBeenCalled()
  })

  it('ready: opens the newest film.html of the conversation on screen', async () => {
    const bridge = stub()
    rows('/work/old/film.html', '/work/notes.html', '/work/new/film.html')

    await toggleOpenfilmEditor(false)

    expect(bridge.open).toHaveBeenCalledTimes(1)
    expect(bridge.open).toHaveBeenCalledWith('/work/new')
    expect(studioTab()?.target).toMatchObject({ label: 'new', source: '/work/new/film.html', transient: true })
    expect($openfilmSetup.get()).toBeNull()
  })

  it('a film whose project is gone is passed over for the next one, then for the project last opened', async () => {
    const open = vi.fn(async (folder: string) =>
      folder === '/work/last'
        ? { ok: true as const, url: STUDIO_URL }
        : { ok: false as const, code: 'not_a_film' as const, message: 'not a folder with film.html' }
    )

    stub({ lastProject: vi.fn(async () => '/work/last'), open })
    rows('/work/gone/film.html')

    await openOpenfilmEditor()

    expect(open.mock.calls.map(call => call[0])).toEqual(['/work/gone', '/work/last'])
    expect(studioTab()?.target).toMatchObject({ label: 'last', source: '/work/last/film.html' })
  })

  it('nothing to open: says how a project comes about, and makes none', async () => {
    const bridge = stub()

    await openOpenfilmEditor()

    expect($openfilmSetup.get()).toEqual({ phase: 'empty' })
    expect(bridge.open).not.toHaveBeenCalled()
    expect(studioTab()).toBeUndefined()
  })

  it('not ready: checks, installs as the person asked, shows how far, and opens the film once ready', async () => {
    vi.useFakeTimers()
    const progress = { done: 10_000_000, step: 'toolkit' as const, total: 41_600_000 }

    const bridge = stub({
      statuses: [
        { on: true, ready: false, preparing: false },
        { on: true, ready: false, preparing: true },
        { on: true, ready: true, preparing: false }
      ],
      progress: vi.fn(async () => ({ failed: false, progress }))
    })

    rows('/work/cook/film.html')

    const running = openOpenfilmEditor()

    await vi.waitFor(() => expect($openfilmSetup.get()?.phase).toBe('preparing'))
    expect(bridge.check).toHaveBeenCalledTimes(1)
    expect(bridge.prefetch).toHaveBeenCalledWith(true)
    await vi.advanceTimersByTimeAsync(OPENFILM_SETUP_POLL_MS)
    expect($openfilmSetup.get()).toEqual({
      phase: 'preparing',
      check: { browser: { ready: true, bytes: 1 }, toolkit: { ready: false, bytes: 2 }, disk: ROOM },
      progress
    })
    expect(bridge.open).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(OPENFILM_SETUP_POLL_MS)
    await running

    expect(bridge.open).toHaveBeenCalledWith('/work/cook')
    expect(studioTab()?.target.label).toBe('cook')
    expect($openfilmSetup.get()).toBeNull()
  })

  it('not enough disk space: says so, and installs nothing', async () => {
    const bridge = stub({
      statuses: [{ on: true, ready: false, preparing: false }],
      check: vi.fn(async () => ({
        browser: { ready: false, bytes: 1 },
        toolkit: { ready: false, bytes: 2 },
        disk: { free: 100, needed: 7e8 }
      }))
    })

    await openOpenfilmEditor()

    expect($openfilmSetup.get()?.phase).toBe('disk')
    expect(bridge.prefetch).not.toHaveBeenCalled()
  })

  it('a check the engine cannot give does not stop the install', async () => {
    vi.useFakeTimers()

    const bridge = stub({
      statuses: [{ on: true, ready: false, preparing: false }, { on: true, ready: false, preparing: true }],
      check: vi.fn(async () => null)
    })

    void openOpenfilmEditor()
    await vi.waitFor(() => expect($openfilmSetup.get()).toEqual({ phase: 'preparing', check: null, progress: null }))
    expect(bridge.prefetch).toHaveBeenCalledWith(true)
  })

  it('a failed install says so; 重试 checks again and starts it at once', async () => {
    vi.useFakeTimers()

    const bridge = stub({
      statuses: [{ on: true, ready: false, preparing: false }],
      progress: vi.fn(async () => ({ failed: true, progress: null }))
    })

    const running = openOpenfilmEditor()
    await vi.advanceTimersByTimeAsync(OPENFILM_SETUP_POLL_MS)
    await running

    expect($openfilmSetup.get()?.phase).toBe('failed')
    expect(bridge.prefetch).toHaveBeenCalledTimes(1)

    void retryOpenfilmSetup()
    await vi.waitFor(() => expect(bridge.prefetch).toHaveBeenCalledTimes(2))
    expect(bridge.prefetch).toHaveBeenLastCalledWith(true)
    expect(bridge.check).toHaveBeenCalledTimes(2)
  })

  it('clicking again while the popover is open closes it, and its run ends: nothing opens later', async () => {
    vi.useFakeTimers()

    const bridge = stub({
      statuses: [
        { on: true, ready: false, preparing: false },
        { on: true, ready: false, preparing: true },
        { on: true, ready: true, preparing: false }
      ]
    })

    rows('/work/cook/film.html')
    void openOpenfilmEditor()
    await vi.waitFor(() => expect($openfilmSetup.get()?.phase).toBe('preparing'))

    await toggleOpenfilmEditor(false)
    expect($openfilmSetup.get()).toBeNull()
    await vi.advanceTimersByTimeAsync(OPENFILM_SETUP_POLL_MS * 3)

    expect($openfilmSetup.get()).toBeNull()
    expect(bridge.open).not.toHaveBeenCalled()
  })

  it('an account the editor is no longer open to: the switch goes away and nothing runs', async () => {
    const bridge = stub({ statuses: [{ on: false, ready: false, preparing: false }] })

    await openOpenfilmEditor()

    expect($openfilmStudioOn.get()).toBe(false)
    expect($openfilmSetup.get()).toBeNull()
    expect(bridge.check).not.toHaveBeenCalled()
    expect(bridge.prefetch).not.toHaveBeenCalled()
  })
})
