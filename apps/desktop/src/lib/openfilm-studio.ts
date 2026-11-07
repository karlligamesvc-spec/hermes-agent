/**
 * PROTOTYPE, off unless this install sets APEXNODES_OPENFILM_STUDIO=1
 * (electron/openfilm-studio.ts): a local `film.html`, an agent's OpenFilm edit,
 * opens in OpenFilm Studio, the editor, instead of as an HTML page.
 *
 * Main settles the switch at launch; this window asks it once. Until the answer
 * says on, and whenever it is off, nothing here changes how a preview opens.
 */

import { atom } from 'nanostores'

import type { PreviewTarget } from '@/store/preview'

export const $openfilmStudioOn = atom(false)

/** The preview tab Studio lives in: one, re-fronted and re-pointed on every open. */
export const OPENFILM_STUDIO_TAB_ID = 'url:openfilm-studio' as const

/** The project folder of a local `film.html`; null for any other target. */
export function openfilmProjectFolder(target: PreviewTarget): null | string {
  if (target.kind !== 'file' || target.dataUrl || target.transient) {
    return null
  }

  const match = /^(.+)[\\/]film\.html$/.exec(target.path ?? '')

  return match ? match[1] : null
}

/** Studio's address for the project in `folder`; null when Studio could not open it. */
export async function openfilmStudioUrl(folder: string): Promise<null | string> {
  try {
    const opened = await window.hermesDesktop?.openfilmStudio?.open(folder)

    if (opened?.ok) {
      return opened.url
    }

    console.warn('[openfilm-studio] not opened:', opened?.code, opened?.message)
  } catch (error) {
    console.warn('[openfilm-studio] not opened:', error)
  }

  return null
}

if (typeof window !== 'undefined') {
  void Promise.resolve(window.hermesDesktop?.openfilmStudio?.status?.()).then(
    status => $openfilmStudioOn.set(status?.on === true),
    () => undefined
  )
}
