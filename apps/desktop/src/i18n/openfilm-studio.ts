/**
 * Copy for hc-1176: an agent's film.html opened before the editor (OpenFilm
 * Studio, lib/openfilm-studio.ts) is installed plays as it always did, and this
 * line says the editor is on its way and takes over by itself. Each locale is a
 * whole typed object; ja and ar read en.
 */

import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

export interface OpenfilmStudioCopy {
  /** Shown once when a film opens while the editor is still being installed. */
  preparing: string
}

const en: OpenfilmStudioCopy = {
  preparing: 'The editor is still getting ready, so this plays the film for now. It switches over by itself once ready.'
}

const zh: OpenfilmStudioCopy = {
  preparing: '编辑器还在准备，先放成片；好了会自动切过去。'
}

const zhHant: OpenfilmStudioCopy = {
  preparing: '編輯器還在準備，先放成片；好了會自動切過去。'
}

export const OPENFILM_STUDIO_COPY: Readonly<Record<Locale, OpenfilmStudioCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function openfilmStudioCopyNow(): OpenfilmStudioCopy {
  return OPENFILM_STUDIO_COPY[getRuntimeI18nLocale()] ?? en
}
