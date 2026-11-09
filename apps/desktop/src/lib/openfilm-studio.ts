/**
 * Only for an account the Scheduler opens the editor to
 * (electron/openfilm-studio.ts, hc-1178): a local `film.html`, an agent's
 * OpenFilm edit, opens in OpenFilm Studio, the editor, instead of as an HTML
 * page — once the engine has installed Studio's toolkit (hc-1176). The first
 * video tool an agent runs starts that install in the background; a film opened
 * before it is done plays as it always did and switches to the editor when it is.
 *
 * Main holds the account's answer; this window asks it when it opens and again
 * whenever an agent starts a tool (a sign-in may come after the window opened,
 * and a film.html only ever comes from an agent's tools). Until the answer says
 * on, and whenever it is off, nothing here changes how a preview opens.
 *
 * Studio's tab is APEX's editor, not a web page (hc-1188): it is called 「剪辑」
 * and has no browser bar, browser verbs or "+", and the editor shows APEX's
 * language rather than the computer's.
 */

import { atom } from 'nanostores'

import { getRuntimeI18nLocale } from '@/i18n/runtime'
import type { Locale } from '@/i18n/types'
import type { PreviewTarget } from '@/store/preview'

export const $openfilmStudioOn = atom(false)

/** The preview tab Studio lives in: one, re-fronted and re-pointed on every open. */
export const OPENFILM_STUDIO_TAB_ID = 'url:openfilm-studio' as const

/** Whether `tabId` is Studio's tab: the editor, which the pane shows without a browser's chrome. */
export function isOpenfilmStudioTab(tabId: null | string | undefined): boolean {
  return tabId === OPENFILM_STUDIO_TAB_ID
}

/** Where Studio's editor keeps its language (openfilm@0.3.0 studio/ui). */
const STUDIO_LANGUAGE_KEY = 'openfilm.language'

/**
 * The language Studio's editor shows for APEX's `locale`, among those it has
 * (en, zh-CN, ja, ko, es): Traditional Chinese reads Simplified, the nearer of
 * the two, and Arabic reads English.
 */
export function openfilmStudioLanguage(locale: Locale): string {
  if (locale === 'zh' || locale === 'zh-hant') {
    return 'zh-CN'
  }

  return locale === 'ja' ? 'ja' : 'en'
}

/**
 * The script that sets the editor in a Studio page to `language`. The editor
 * keeps its language in localStorage and reads it again on a `storage` event,
 * which a page never gets for its own writes, so the script sends one: the
 * editor changes language in place, with no reload. The event names only the
 * key, all the editor reads: a `storageArea` must be the browser's own Storage
 * (jsdom refuses any other, as CI's tests have). → whether it changed it.
 */
export function openfilmStudioLanguageScript(language: string): string {
  const key = JSON.stringify(STUDIO_LANGUAGE_KEY)
  const value = JSON.stringify(language)

  return `(() => { try { if (localStorage.getItem(${key}) === ${value}) return false; localStorage.setItem(${key}, ${value}); window.dispatchEvent(new StorageEvent('storage', { key: ${key}, newValue: ${value} })); return true } catch { return null } })()`
}

/**
 * Give the editor in `webview` APEX's language, when it is Studio's tab. The
 * pane calls this as each Studio page starts and loads, and when APEX's
 * language changes. A guest not ready for scripts yet is left alone: its next
 * load event tries again.
 */
export function applyOpenfilmStudioLanguage(
  webview: { executeJavaScript?: (code: string) => Promise<unknown> } | null | undefined,
  tabId: null | string | undefined,
  locale: Locale = getRuntimeI18nLocale()
): void {
  if (!isOpenfilmStudioTab(tabId) || typeof webview?.executeJavaScript !== 'function') {
    return
  }

  try {
    void webview.executeJavaScript(openfilmStudioLanguageScript(openfilmStudioLanguage(locale))).catch(() => undefined)
  } catch {
    // Electron throws before the guest is attached; its did-navigate / dom-ready comes next.
  }
}

/** The tools an agent makes, cuts or reads a video with: the first one seen starts the toolkit's install. */
export const OPENFILM_VIDEO_TOOLS: ReadonlySet<string> = new Set([
  'generate_video',
  'video_generate',
  'video_breakdown',
  'video_analyze'
])

/** How often a film shown before the editor was ready asks whether it is now. */
export const OPENFILM_READY_POLL_MS = 4_000

export type OpenfilmStudioOpened =
  | { code: 'not_a_film' | 'not_ready' | 'off' | 'open_failed' | 'start_failed' | 'unavailable'; ok: false }
  | { ok: true; url: string }

/** The project folder of a local `film.html`; null for any other target. */
export function openfilmProjectFolder(target: PreviewTarget): null | string {
  if (target.kind !== 'file' || target.dataUrl || target.transient) {
    return null
  }

  const match = /^(.+)[\\/]film\.html$/.exec(target.path ?? '')

  return match ? match[1] : null
}

/** Studio's address for the project in `folder`, or why there is none. */
export async function openfilmStudioUrl(folder: string): Promise<OpenfilmStudioOpened> {
  try {
    const opened = await window.hermesDesktop?.openfilmStudio?.open(folder)

    if (opened?.ok) {
      return { ok: true, url: opened.url }
    }

    if (opened?.code !== 'not_ready') {
      console.warn('[openfilm-studio] not opened:', opened?.code, opened?.message)
    }

    return { ok: false, code: opened?.code ?? 'unavailable' }
  } catch (error) {
    console.warn('[openfilm-studio] not opened:', error)

    return { ok: false, code: 'unavailable' }
  }
}

/** Ask main whether the editor is open to this account now; an answer that does not come keeps the last one. */
export function refreshOpenfilmStudioOn(): Promise<boolean> {
  return Promise.resolve(window.hermesDesktop?.openfilmStudio?.status?.()).then(
    status => {
      $openfilmStudioOn.set(status?.on === true)

      return $openfilmStudioOn.get()
    },
    () => $openfilmStudioOn.get()
  )
}

/**
 * An agent started tool `name`: the answer is asked again, and a video tool has
 * main install the toolkit, unless it is there or on its way.
 */
export function noteAgentTool(name: unknown): void {
  if (!window.hermesDesktop?.openfilmStudio) {
    return
  }

  void refreshOpenfilmStudioOn().then(on => {
    if (on && typeof name === 'string' && OPENFILM_VIDEO_TOOLS.has(name)) {
      void Promise.resolve(window.hermesDesktop?.openfilmStudio?.prefetch?.()).catch(() => undefined)
    }
  })
}

let waiting: null | ReturnType<typeof setInterval> = null

/**
 * Until the editor is ready, ask main every OPENFILM_READY_POLL_MS; then call
 * `onReady`, unless the film is no longer what the pane shows (`shown()`), and
 * stop asking either way. One film waits at a time: a newer one takes over.
 */
export function waitForOpenfilmEditor(shown: () => boolean, onReady: () => void): void {
  if (waiting) {
    clearInterval(waiting)
  }

  const timer = setInterval(() => {
    if (!shown()) {
      clearInterval(timer)
      waiting = waiting === timer ? null : waiting

      return
    }

    void Promise.resolve(window.hermesDesktop?.openfilmStudio?.status?.()).then(
      status => {
        if (status?.ready === true && waiting === timer) {
          clearInterval(timer)
          waiting = null

          if (shown()) {
            onReady()
          }
        }
      },
      () => undefined
    )
  }, OPENFILM_READY_POLL_MS)

  waiting = timer
}

/**
 * hc-1201: the titlebar's 剪辑 shows only while the answer is yes, so it is
 * asked again when the signed-in account changes and when the window comes
 * back to the front (main keeps an answer a minute), not only when an agent
 * starts a tool.
 */
export function watchOpenfilmStudioOn(target: Window = window): void {
  const refresh = () => {
    if (target.hermesDesktop?.openfilmStudio) {
      void refreshOpenfilmStudioOn()
    }
  }

  target.hermesDesktop?.onManagedAccountChanged?.(refresh)
  target.addEventListener('focus', refresh)
}

if (typeof window !== 'undefined') {
  void refreshOpenfilmStudioOn()
  watchOpenfilmStudioOn()
}
