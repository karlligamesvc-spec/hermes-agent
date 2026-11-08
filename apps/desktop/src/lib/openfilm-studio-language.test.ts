/**
 * hc-1188: Studio's editor shows APEX's language, not the computer's. The editor
 * (openfilm@0.3.0 studio/ui) keeps its language in localStorage
 * `openfilm.language` and reads it again on a `storage` event; the script the
 * pane runs in each Studio page sets it and sends that event, which a page
 * never gets for its own writes. Run here against jsdom's localStorage.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Locale } from '@/i18n/types'

import {
  applyOpenfilmStudioLanguage,
  OPENFILM_STUDIO_TAB_ID,
  openfilmStudioLanguage,
  openfilmStudioLanguageScript
} from './openfilm-studio'

/** Run a script the way a page does: in the window's global scope. */
const runInPage = (script: string): unknown => (0, eval)(script)

afterEach(() => {
  window.localStorage.clear()
})

describe('the editor’s language for APEX’s', () => {
  it.each<[Locale, string]>([
    ['zh', 'zh-CN'],
    // Studio has no Traditional Chinese: Simplified is the nearer of what it has.
    ['zh-hant', 'zh-CN'],
    ['en', 'en'],
    ['ja', 'ja'],
    // Nor Arabic.
    ['ar', 'en']
  ])('%s is %s', (locale, language) => {
    expect(openfilmStudioLanguage(locale)).toBe(language)
  })
})

describe('the script a Studio page runs', () => {
  it('sets the editor’s language and tells the editor, which then reads it', () => {
    const heard: Array<null | string> = []

    // What the editor does on the event: reads its language again.
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'openfilm.language') {
        heard.push(window.localStorage.getItem('openfilm.language'))
      }
    }

    window.addEventListener('storage', onStorage)

    try {
      expect(runInPage(openfilmStudioLanguageScript('zh-CN'))).toBe(true)
      expect(window.localStorage.getItem('openfilm.language')).toBe('zh-CN')
      expect(heard).toEqual(['zh-CN'])

      // Already so: nothing written, nothing re-read (a page load after the first sets nothing).
      expect(runInPage(openfilmStudioLanguageScript('zh-CN'))).toBe(false)
      expect(heard).toEqual(['zh-CN'])

      // APEX's language changed: the editor follows in place.
      expect(runInPage(openfilmStudioLanguageScript('en'))).toBe(true)
      expect(heard).toEqual(['zh-CN', 'en'])
    } finally {
      window.removeEventListener('storage', onStorage)
    }
  })

  it('overrides a language picked inside Studio: APEX’s is the one it follows', () => {
    window.localStorage.setItem('openfilm.language', 'es')

    expect(runInPage(openfilmStudioLanguageScript('zh-CN'))).toBe(true)
    expect(window.localStorage.getItem('openfilm.language')).toBe('zh-CN')
  })

  it('quotes what it is given, so a language is never code', () => {
    const script = openfilmStudioLanguageScript(`x'); throw new Error('ran'); ('`)

    expect(runInPage(script)).toBe(true)
    expect(window.localStorage.getItem('openfilm.language')).toBe(`x'); throw new Error('ran'); ('`)
  })
})

describe('giving a pane’s guest the language', () => {
  const guest = () => ({ executeJavaScript: vi.fn(async (_code: string) => true) })

  it('runs the script for APEX’s language in Studio’s tab', () => {
    const webview = guest()

    applyOpenfilmStudioLanguage(webview, OPENFILM_STUDIO_TAB_ID, 'zh-hant')

    expect(webview.executeJavaScript).toHaveBeenCalledExactlyOnceWith(openfilmStudioLanguageScript('zh-CN'))
  })

  it.each([
    ['a Browser tab', 'url:5b0c'],
    ['a file peek', 'file:/work/cook/film.html'],
    ['no tab', undefined]
  ])('leaves %s alone', (_label, tabId) => {
    const webview = guest()

    applyOpenfilmStudioLanguage(webview, tabId, 'zh')

    expect(webview.executeJavaScript).not.toHaveBeenCalled()
  })

  it('leaves a guest not ready for scripts alone: its next load tries again', async () => {
    const throwsNow = {
      executeJavaScript: () => {
        throw new Error('The WebView must be attached to the DOM and the dom-ready event emitted')
      }
    }

    const refuses = { executeJavaScript: vi.fn(async () => Promise.reject(new Error('Script failed to execute'))) }

    expect(() => applyOpenfilmStudioLanguage(throwsNow, OPENFILM_STUDIO_TAB_ID, 'zh')).not.toThrow()
    expect(() => applyOpenfilmStudioLanguage({}, OPENFILM_STUDIO_TAB_ID, 'zh')).not.toThrow()
    expect(() => applyOpenfilmStudioLanguage(null, OPENFILM_STUDIO_TAB_ID, 'zh')).not.toThrow()
    applyOpenfilmStudioLanguage(refuses, OPENFILM_STUDIO_TAB_ID, 'zh')
    // A refusal is swallowed, not an unhandled rejection.
    await expect(refuses.executeJavaScript.mock.results[0]?.value).rejects.toThrow('Script failed')
  })
})
