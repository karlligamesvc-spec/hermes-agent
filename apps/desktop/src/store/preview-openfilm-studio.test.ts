/**
 * lib/openfilm-studio.ts: with this install's switch on, an agent's film.html
 * opens in OpenFilm Studio once its toolkit is installed, and before that plays
 * as it always did and switches over when it is; off, opening a preview is
 * unchanged. A video tool an agent starts has main install the toolkit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $openfilmStudioOn, noteAgentTool, OPENFILM_READY_POLL_MS, OPENFILM_STUDIO_TAB_ID } from '@/lib/openfilm-studio'

import { $rightRailActiveTabId } from './layout'
import { $notifications } from './notifications'
import { $previewTabs, closeRightRail, openPreview, type PreviewTarget } from './preview'

const STUDIO_URL = 'http://127.0.0.1:53327/open?key=k&to=%2Fprojects%2Fp1'

function fileTarget(path: string): PreviewTarget {
  return { kind: 'file', label: path, path, previewKind: 'html', source: path, url: `file://${path}` }
}

type StudioBridge = NonNullable<Window['hermesDesktop']['openfilmStudio']>

function stubStudio(open: StudioBridge['open'], status = { on: true, ready: true, preparing: false }) {
  const bridge: StudioBridge = {
    open: vi.fn(open),
    prefetch: vi.fn(async () => 'started' as const),
    status: vi.fn(async () => status)
  }

  window.hermesDesktop = { ...(window.hermesDesktop ?? {}), openfilmStudio: bridge } as Window['hermesDesktop']

  return bridge
}

describe('opening an agent film.html', () => {
  const original = window.hermesDesktop

  beforeEach(() => {
    closeRightRail()
    window.localStorage.clear()
    $openfilmStudioOn.set(false)
  })

  afterEach(() => {
    closeRightRail()
    window.localStorage.clear()
    $openfilmStudioOn.set(false)
    window.hermesDesktop = original
  })

  it('is unchanged while the switch is off: the file opens as a file tab and Studio is never asked', () => {
    const bridge = stubStudio(async () => ({ ok: true, url: STUDIO_URL }))

    openPreview(fileTarget('/work/cook/film.html'), 'explicit-link')

    expect($previewTabs.get().map(tab => tab.id)).toEqual(['file:file:///work/cook/film.html'])
    expect(bridge.open).not.toHaveBeenCalled()
  })

  it('opens the project folder in Studio, in its own tab that is never persisted', async () => {
    $openfilmStudioOn.set(true)
    const bridge = stubStudio(async () => ({ ok: true, url: STUDIO_URL }))

    openPreview(fileTarget('/work/cook/film.html'), 'explicit-link')

    await vi.waitFor(() => expect($rightRailActiveTabId.get()).toBe(OPENFILM_STUDIO_TAB_ID))
    expect(bridge.open).toHaveBeenCalledWith('/work/cook')
    expect($previewTabs.get()).toEqual([
      {
        id: OPENFILM_STUDIO_TAB_ID,
        target: { kind: 'url', label: 'cook', source: '/work/cook/film.html', transient: true, url: STUDIO_URL }
      }
    ])
    expect(window.localStorage.getItem('hermes.desktop.previewTabs.v2')).toBe('[]')
  })

  it('re-points the one Studio tab when another project opens', async () => {
    $openfilmStudioOn.set(true)
    stubStudio(async folder => ({ ok: true, url: `${STUDIO_URL}&for=${encodeURIComponent(folder)}` }))

    openPreview(fileTarget('/work/cook/film.html'), 'explicit-link')
    await vi.waitFor(() => expect($previewTabs.get()).toHaveLength(1))
    openPreview(fileTarget('/work/trip/film.html'), 'explicit-link')

    await vi.waitFor(() => expect($previewTabs.get()[0]?.target.label).toBe('trip'))
    expect($previewTabs.get()).toHaveLength(1)
  })

  it('falls back to the file itself when Studio cannot open it', async () => {
    $openfilmStudioOn.set(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    stubStudio(async () => ({ ok: false, code: 'start_failed', message: 'no toolkit' }))

    openPreview(fileTarget('/work/cook/film.html'), 'explicit-link')

    await vi.waitFor(() => expect($previewTabs.get().map(tab => tab.id)).toEqual(['file:file:///work/cook/film.html']))
    expect($previewTabs.get()[0]?.target.renderMode).toBe('preview')
    warn.mockRestore()
  })

  it.each([
    ['another HTML file', fileTarget('/work/cook/index.html')],
    ['a film.html in name only', fileTarget('/work/cook/my-film.html')],
    ['a remote gateway file', { ...fileTarget('/work/cook/film.html'), dataUrl: 'data:text/html;base64,PGh0bWw+' }],
    ['a web page', { kind: 'url', label: 'film', source: 'https://x.test/film.html', url: 'https://x.test/film.html' }]
  ] satisfies [string, PreviewTarget][])('leaves %s to the normal preview', (_label, target) => {
    $openfilmStudioOn.set(true)
    const bridge = stubStudio(async () => ({ ok: true, url: STUDIO_URL }))

    openPreview(target, 'explicit-link')

    expect(bridge.open).not.toHaveBeenCalled()
    expect($previewTabs.get()).toHaveLength(1)
  })

  describe('before the editor is installed', () => {
    const FILM = '/work/cook/film.html'
    const FILE_TAB = 'file:file:///work/cook/film.html'

    function notReadyYet() {
      $openfilmStudioOn.set(true)
      const status = { on: true, ready: false, preparing: true }

      const bridge = stubStudio(async () => {
        return status.ready ? { ok: true, url: STUDIO_URL } : { ok: false, code: 'not_ready', message: 'getting ready' }
      }, status)

      return { bridge, status }
    }

    afterEach(() => vi.useRealTimers())

    it('plays the film as before, says once that the editor is coming, and switches when it is ready', async () => {
      vi.useFakeTimers()
      const { bridge, status } = notReadyYet()

      openPreview(fileTarget(FILM), 'explicit-link')

      await vi.waitFor(() => expect($previewTabs.get().map(tab => tab.id)).toEqual([FILE_TAB]))
      expect($rightRailActiveTabId.get()).toBe(FILE_TAB)
      expect($notifications.get().filter(n => n.id === 'openfilm-studio-preparing')).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(OPENFILM_READY_POLL_MS * 3)
      expect($rightRailActiveTabId.get()).toBe(FILE_TAB)

      status.ready = true
      await vi.advanceTimersByTimeAsync(OPENFILM_READY_POLL_MS)
      await vi.waitFor(() => expect($rightRailActiveTabId.get()).toBe(OPENFILM_STUDIO_TAB_ID))
      expect(bridge.open).toHaveBeenLastCalledWith('/work/cook')
    })

    it('does not jump to the editor once the person has moved on from the film', async () => {
      vi.useFakeTimers()
      const { bridge, status } = notReadyYet()

      openPreview(fileTarget(FILM), 'explicit-link')
      await vi.waitFor(() => expect($rightRailActiveTabId.get()).toBe(FILE_TAB))
      openPreview(fileTarget('/work/cook/notes.md'), 'explicit-link')
      const calls = vi.mocked(bridge.open).mock.calls.length

      status.ready = true
      await vi.advanceTimersByTimeAsync(OPENFILM_READY_POLL_MS * 3)

      expect($rightRailActiveTabId.get()).toBe('file:file:///work/cook/notes.md')
      expect(vi.mocked(bridge.open).mock.calls.length).toBe(calls)
    })
  })

  describe('an agent starting a video tool', () => {
    const settled = () => new Promise(done => setTimeout(done, 0))

    it.each([
      ['generate_video', true],
      ['video_generate', true],
      ['video_breakdown', true],
      ['terminal', false],
      ['browser_navigate', false],
      [undefined, false]
    ])('%s has main install the editor: %s', async (tool, installs) => {
      $openfilmStudioOn.set(true)
      const bridge = stubStudio(async () => ({ ok: true, url: STUDIO_URL }))

      noteAgentTool(tool)
      await vi.waitFor(() => expect(bridge.status).toHaveBeenCalled())
      await settled()

      expect(vi.mocked(bridge.prefetch).mock.calls.length).toBe(installs ? 1 : 0)
    })

    it('installs nothing while the editor is not open to this account, even if it was', async () => {
      $openfilmStudioOn.set(true)

      const bridge = stubStudio(async () => ({ ok: true, url: STUDIO_URL }), {
        on: false,
        ready: false,
        preparing: false
      })

      noteAgentTool('generate_video')
      await vi.waitFor(() => expect(bridge.status).toHaveBeenCalled())
      await settled()

      expect(bridge.prefetch).not.toHaveBeenCalled()
      expect($openfilmStudioOn.get()).toBe(false)
    })

    it('an account opened after the window: the next tool an agent starts turns the editor on', async () => {
      const bridge = stubStudio(async () => ({ ok: true, url: STUDIO_URL }))

      noteAgentTool('terminal')

      await vi.waitFor(() => expect($openfilmStudioOn.get()).toBe(true))
      expect(bridge.prefetch).not.toHaveBeenCalled()
    })

    it('an answer that does not come keeps the last one', async () => {
      $openfilmStudioOn.set(true)
      const bridge = stubStudio(async () => ({ ok: true, url: STUDIO_URL }))
      vi.mocked(bridge.status).mockRejectedValueOnce(new Error('main is busy'))

      noteAgentTool('generate_video')
      await vi.waitFor(() => expect(bridge.status).toHaveBeenCalled())
      await settled()

      expect($openfilmStudioOn.get()).toBe(true)
      expect(bridge.prefetch).toHaveBeenCalledOnce()
    })
  })
})
