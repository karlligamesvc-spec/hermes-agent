/**
 * hc-1085 identity guard harness for the titlebar. Renders the fixed titlebar
 * clusters (TitlebarControls, as the contrib shell mounts them, with no page
 * tools) the way the goldens beside this file were recorded on fork main
 * aa8e554e38, before hc-1085 folded anything. It must keep using only APIs
 * main already had: the same file recorded the goldens there.
 *
 * The caller sets the switches; this file sets the titlebar's own state (which
 * side the app actions sit on, whether the sessions sit on the right, whether
 * the right side is open) and returns the normalized HTML.
 */
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { TitlebarControls } from '@/app/shell/titlebar-controls'
import { I18nProvider } from '@/i18n'
import { $panesFlipped, setFileBrowserOpen } from '@/store/layout'
import { setTitlebarAppActionsSide, type TitlebarAppActionsSide } from '@/store/titlebar-app-actions'

import { normalized } from '../single-thread-shell/render'

export interface TitlebarState {
  appActions?: TitlebarAppActionsSide
  /** The sessions sit right of the chat (⌘\ was pressed, or a mirrored preset). */
  flipped?: boolean
  /** The right side is open. */
  rightOpen?: boolean
}

export function setTitlebarState({ appActions = 'right', flipped = false, rightOpen = false }: TitlebarState): void {
  setTitlebarAppActionsSide(appActions)
  $panesFlipped.set(flipped)
  setFileBrowserOpen(rightOpen)
}

export function resetTitlebarState(): void {
  cleanup()
  setTitlebarState({})
}

/** Both fixed clusters, on the chat. */
export function titlebarHtml(state: TitlebarState = {}): string {
  setTitlebarState(state)

  const view = render(
    <MemoryRouter initialEntries={['/chat-a']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <TitlebarControls onOpenSettings={() => {}} />
      </I18nProvider>
    </MemoryRouter>
  )

  return normalized(view.container.innerHTML) + '\n'
}
