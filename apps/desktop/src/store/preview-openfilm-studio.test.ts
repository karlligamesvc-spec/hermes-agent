/**
 * PROTOTYPE (lib/openfilm-studio.ts): with this install's switch on, an agent's
 * film.html opens in OpenFilm Studio; off, opening a preview is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $openfilmStudioOn, OPENFILM_STUDIO_TAB_ID } from '@/lib/openfilm-studio'

import { $rightRailActiveTabId } from './layout'
import { $previewTabs, closeRightRail, openPreview, type PreviewTarget } from './preview'

const STUDIO_URL = 'http://127.0.0.1:53327/open?key=k&to=%2Fprojects%2Fp1'

function fileTarget(path: string): PreviewTarget {
  return { kind: 'file', label: path, path, previewKind: 'html', source: path, url: `file://${path}` }
}

type StudioBridge = NonNullable<Window['hermesDesktop']['openfilmStudio']>

function stubStudio(open: StudioBridge['open']) {
  const bridge: StudioBridge = { open: vi.fn(open), status: vi.fn(async () => ({ on: true })) }
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
})
