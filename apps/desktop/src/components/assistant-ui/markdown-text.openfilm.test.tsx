import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mediaMarkdownHref } from '@/lib/media'
import { $openfilmStudioOn, OPENFILM_STUDIO_TAB_ID } from '@/lib/openfilm-studio'
import { $rightRailActiveTabId } from '@/store/layout'
import { $previewTabs, closeRightRail } from '@/store/preview'
import { $connection } from '@/store/session'

import { MarkdownTextContent } from './markdown-text'

/**
 * The twin of the film.html row above the composer (preview-row.test.tsx): an
 * agent's film.html named in a reply is a file card whose "Open preview" goes
 * through openPreview, so for an account the editor is open to it lands in the
 * editor, never in the system browser. Pinned so the card cannot drift onto a
 * browser path the way the row's plain click had.
 */
describe('an agent film.html in a reply', () => {
  const STUDIO_URL = 'http://127.0.0.1:53327/open?key=k&to=%2Fprojects%2Fcook'
  const FILM = '/work/cook/film.html'
  const original = window.hermesDesktop

  beforeEach(() => {
    $connection.set({ mode: 'local' } as never)
    $openfilmStudioOn.set(true)
    closeRightRail()
  })

  afterEach(() => {
    cleanup()
    $connection.set(null)
    $openfilmStudioOn.set(false)
    closeRightRail()
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: original })
  })

  it.each([
    { name: 'a MEDIA delivery', text: `[film.html](${mediaMarkdownHref(FILM)})` },
    { name: 'a plain file link', text: `改好了：[片子](${FILM})` }
  ])('$name opens in the editor from its card', async ({ text }) => {
    const openExternal = vi.fn(async () => undefined)
    const openPreviewInBrowser = vi.fn(async () => undefined)
    const open = vi.fn(async () => ({ ok: true as const, url: STUDIO_URL }))

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        normalizePreviewTarget: vi.fn(async () => ({
          kind: 'file',
          label: 'film.html',
          path: FILM,
          previewKind: 'html',
          source: FILM,
          url: `file://${FILM}`
        })),
        openExternal,
        openfilmStudio: {
          open,
          prefetch: vi.fn(async () => 'started' as const),
          status: vi.fn(async () => ({ on: true, preparing: false, ready: true }))
        },
        openPreviewInBrowser
      }
    })

    render(<MarkdownTextContent isRunning={false} text={text} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open preview' }))

    await waitFor(() => expect($rightRailActiveTabId.get()).toBe(OPENFILM_STUDIO_TAB_ID))
    expect(open).toHaveBeenCalledWith('/work/cook')
    expect($previewTabs.get().map(tab => tab.id)).toEqual([OPENFILM_STUDIO_TAB_ID])
    expect(openPreviewInBrowser).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })
})
