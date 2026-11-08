/**
 * hc-1188: a Browser tab that fails to load offers to restart the agent's dev
 * server behind it. The editor's tab (OpenFilm Studio) is APEX's own, not a
 * server of the agent's, so its load error never asks the agent to restart one.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ props: [] as Array<{ onRestartServer?: unknown; tabId?: string }> }))

vi.mock('./preview-pane', () => ({
  PreviewPane: (props: { onRestartServer?: unknown; tabId?: string }) => {
    seen.props.push(props)

    return null
  }
}))

import { $restartPreviewServer } from '@/app/contrib/panes'
import { OPENFILM_STUDIO_TAB_ID } from '@/lib/openfilm-studio'
import { $previewTabs } from '@/store/preview'

import { PreviewTilePane } from './preview'

afterEach(() => {
  cleanup()
  $previewTabs.set([])
  $restartPreviewServer.set(null)
  seen.props = []
})

describe('restarting the server behind a tab that fails to load', () => {
  it('is offered for a Browser tab, never for the editor’s', () => {
    const restart = vi.fn(async () => 'restarted')

    $restartPreviewServer.set(restart)
    $previewTabs.set([
      {
        id: OPENFILM_STUDIO_TAB_ID,
        target: {
          kind: 'url',
          label: 'cook',
          source: '/work/cook/film.html',
          transient: true,
          url: 'http://127.0.0.1:53327/open?key=k&to=%2Fprojects%2Fcook'
        }
      },
      {
        id: 'url:5b0c',
        target: { kind: 'url', label: 'App', source: 'http://localhost:5173', url: 'http://localhost:5173' }
      }
    ])

    render(<PreviewTilePane tabId={OPENFILM_STUDIO_TAB_ID} />)
    render(<PreviewTilePane tabId="url:5b0c" />)

    expect(seen.props.find(props => props.tabId === OPENFILM_STUDIO_TAB_ID)?.onRestartServer).toBeUndefined()
    expect(seen.props.find(props => props.tabId === 'url:5b0c')?.onRestartServer).toBe(restart)
  })
})
