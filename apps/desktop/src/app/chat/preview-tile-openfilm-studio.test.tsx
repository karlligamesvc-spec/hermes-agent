/**
 * hc-1188: Studio's tab in the preview strip is APEX's editor, not a Browser.
 * It is named 「剪辑」 in APEX's language, never after the page Studio serves
 * (OpenFilm's own title), wears a media glyph rather than the globe, and has
 * none of a Browser's verbs: no "+", no pop-out, no open-in-browser.
 */
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('./right-rail/preview', () => ({
  PreviewTilePane: () => null
}))

vi.mock('./right-rail/preview-console-store', () => ({
  forgetPreviewConsole: () => undefined
}))

import { ToolIcon } from '@/components/ui/tool-icon'
import { registry } from '@/contrib/registry'
import { I18nProvider } from '@/i18n'
import { setRuntimeI18nLocale } from '@/i18n/runtime'
import type { Locale } from '@/i18n/types'
import { OPENFILM_STUDIO_TAB_ID } from '@/lib/openfilm-studio'
import { $previewTabs, closeRightRail, noteBrowserPage, openPreview } from '@/store/preview'

import { watchPreviewTiles } from './preview-tile'

const STUDIO_URL = 'http://127.0.0.1:53327/open?key=k&to=%2Fprojects%2Fcook'

interface PaneData {
  newTab?: () => void
  tabLead?: () => ReactNode
  tabMenuPrefix?: unknown
  tabTitle?: () => ReactNode
}

function pane(tabId: string): { data: PaneData; title?: string } {
  const entry = registry.getArea('panes').find(item => item.id === `preview-tile:${tabId}`)

  if (!entry) {
    throw new Error(`no pane for ${tabId}`)
  }

  return { data: (entry.data ?? {}) as PaneData, title: entry.title }
}

/** The editor's tab as lib/openfilm-studio.ts opens it (store/preview.ts openFilmInStudio). */
function openStudioTab() {
  $previewTabs.set([
    ...$previewTabs.get(),
    {
      id: OPENFILM_STUDIO_TAB_ID,
      target: { kind: 'url', label: 'cook', source: '/work/cook/film.html', transient: true, url: STUDIO_URL }
    }
  ])
}

function openBrowserTab(url: string): string {
  openPreview({ kind: 'url', label: 'Browser', source: url, url }, 'explicit-link')

  return $previewTabs.get().findLast(tab => tab.id !== OPENFILM_STUDIO_TAB_ID && tab.target.kind === 'url')!.id
}

const html = (node: ReactNode, locale: Locale = 'en') =>
  render(
    <I18nProvider configClient={null} initialLocale={locale}>
      {node}
    </I18nProvider>
  ).container.innerHTML

beforeAll(() => {
  watchPreviewTiles()
})

afterEach(() => {
  cleanup()
  closeRightRail()
  setRuntimeI18nLocale('en')
})

describe('the editor’s tab', () => {
  it.each<[Locale, string]>([
    ['zh', '剪辑'],
    ['zh-hant', '剪輯'],
    ['en', 'Editor']
  ])('in %s is called %s, not after the page Studio serves', (locale, name) => {
    setRuntimeI18nLocale(locale)
    openStudioTab()
    // What Studio's page reports as it loads; a Browser tab would take this as its name.
    noteBrowserPage(OPENFILM_STUDIO_TAB_ID, { title: 'OpenFilm Studio', url: 'http://127.0.0.1:53327/projects/cook' })

    const { data, title } = pane(OPENFILM_STUDIO_TAB_ID)

    expect(title).toBe(name)
    expect(
      render(
        <I18nProvider configClient={null} initialLocale={locale}>
          {data.tabTitle?.()}
        </I18nProvider>
      ).container.textContent
    ).toBe(name)
  })

  it('wears a media glyph, where a Browser wears the globe', () => {
    openStudioTab()
    const browser = openBrowserTab('https://example.com/')

    const media = html(<ToolIcon className="opacity-70" name="file-media" size="0.6875rem" />)
    const globe = html(<ToolIcon className="opacity-70" name="globe" size="0.6875rem" />)

    expect(media).not.toBe(globe)
    expect(html(pane(OPENFILM_STUDIO_TAB_ID).data.tabLead?.())).toBe(media)
    expect(html(pane(browser).data.tabLead?.())).toBe(globe)
  })

  it('has none of a Browser’s verbs: no “+”, no pop-out, no open in the browser', () => {
    openStudioTab()
    const browser = openBrowserTab('https://example.com/')

    expect(pane(browser).data.newTab).toBeTypeOf('function')
    expect(pane(browser).data.tabMenuPrefix).toBeTypeOf('function')
    expect(pane(OPENFILM_STUDIO_TAB_ID).data.newTab).toBeUndefined()
    expect(pane(OPENFILM_STUDIO_TAB_ID).data.tabMenuPrefix).toBeUndefined()
  })
})
