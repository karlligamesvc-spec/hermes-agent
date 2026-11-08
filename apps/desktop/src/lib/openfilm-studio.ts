/**
 * Off unless this install sets APEXNODES_OPENFILM_STUDIO=1
 * (electron/openfilm-studio.ts): a local `film.html`, an agent's OpenFilm edit,
 * opens in OpenFilm Studio, the editor, instead of as an HTML page — once the
 * engine has installed Studio's toolkit (hc-1176). The first video tool an
 * agent runs starts that install in the background; a film opened before it is
 * done plays as it always did and switches to the editor when it is.
 *
 * Main settles the switch at launch; this window asks it once. Until the answer
 * says on, and whenever it is off, nothing here changes how a preview opens.
 */

import { atom } from 'nanostores'

import type { PreviewTarget } from '@/store/preview'

export const $openfilmStudioOn = atom(false)

/** The preview tab Studio lives in: one, re-fronted and re-pointed on every open. */
export const OPENFILM_STUDIO_TAB_ID = 'url:openfilm-studio' as const

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

/** An agent started tool `name`: a video tool has main install the toolkit, unless it is there or on its way. */
export function noteAgentTool(name: unknown): void {
  if ($openfilmStudioOn.get() && typeof name === 'string' && OPENFILM_VIDEO_TOOLS.has(name)) {
    void Promise.resolve(window.hermesDesktop?.openfilmStudio?.prefetch?.()).catch(() => undefined)
  }
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

if (typeof window !== 'undefined') {
  void Promise.resolve(window.hermesDesktop?.openfilmStudio?.status?.()).then(
    status => $openfilmStudioOn.set(status?.on === true),
    () => undefined
  )
}
