import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $openfilmStudioOn, OPENFILM_STUDIO_TAB_ID } from '@/lib/openfilm-studio'
import { $rightRailActiveTabId } from '@/store/layout'
import { $previewTabs, closeRightRail } from '@/store/preview'
import { $connection } from '@/store/session'

import { PreviewStatusRow } from './preview-row'

describe('PreviewStatusRow', () => {
  beforeEach(() => {
    $connection.set(null)
    closeRightRail()
  })

  afterEach(() => {
    cleanup()
    $connection.set(null)
    closeRightRail()
    vi.restoreAllMocks()
  })

  it('keeps the preview tooltip label in inline flow inside the portaled decoration', async () => {
    const view = render(
      <PreviewStatusRow
        item={{ cwd: 'C:\\repo', id: 'preview.html', label: 'preview.html', target: 'preview.html' }}
        onDismiss={() => undefined}
      />
    )

    fireEvent.pointerMove(screen.getByText('preview.html'), { pointerType: 'mouse' })
    await screen.findByRole('tooltip')

    const content = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')
    const decoration = content?.firstElementChild

    expect(content).not.toBeNull()
    expect(view.container.contains(content)).toBe(false)
    // The decoration's per-line background only wraps inline FLOW. A flex box
    // (block or inline-flex) under it lights the first line and leaves the
    // rest dark-on-dark, so the two lines must be split by a hard break.
    expect(decoration?.querySelector('.flex, .inline-flex')).toBeNull()
    expect(decoration?.querySelector('br')).not.toBeNull()
  })

  it('opens remote non-HTML file artifacts in the in-app preview instead of the local browser bridge', async () => {
    const remotePath = '/home/agent/report.pdf'
    const openPreviewInBrowser = vi.fn(async () => undefined)

    $connection.set({ mode: 'remote' } as never)
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        api: vi.fn(async () => ({ binary: true, byteSize: 42, mimeType: 'application/pdf' })),
        normalizePreviewTarget: vi.fn(async () => ({
          kind: 'file',
          label: 'report.pdf',
          path: remotePath,
          previewKind: 'binary',
          source: remotePath,
          url: 'file:///home/agent/report.pdf'
        })),
        openPreviewInBrowser
      }
    })

    render(
      <PreviewStatusRow
        item={{ cwd: '/home/agent', id: remotePath, label: 'report.pdf', target: remotePath }}
        onDismiss={() => undefined}
      />
    )

    fireEvent.click(screen.getByText('report.pdf'))

    await waitFor(() => {
      expect($previewTabs.get()).toEqual([
        expect.objectContaining({ target: expect.objectContaining({ kind: 'file', path: remotePath }) })
      ])
    })
    expect(openPreviewInBrowser).not.toHaveBeenCalled()
  })

  it('keeps local file artifacts on the browser bridge', async () => {
    const localPath = '/Users/alice/report.pdf'
    const openPreviewInBrowser = vi.fn(async () => undefined)

    $connection.set({ mode: 'local' } as never)
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        normalizePreviewTarget: vi.fn(async () => ({
          kind: 'file',
          label: 'report.pdf',
          path: localPath,
          previewKind: 'binary',
          source: localPath,
          url: 'file:///Users/alice/report.pdf'
        })),
        openPreviewInBrowser
      }
    })

    render(
      <PreviewStatusRow
        item={{ cwd: '/Users/alice', id: localPath, label: 'report.pdf', target: localPath }}
        onDismiss={() => undefined}
      />
    )

    fireEvent.click(screen.getByText('report.pdf'))

    await waitFor(() => {
      expect(openPreviewInBrowser).toHaveBeenCalledWith('file:///Users/alice/report.pdf')
    })
    expect($previewTabs.get()).toEqual([])
  })

  it('keeps remote HTML on the staged browser-open path, not the in-app pane', async () => {
    const remotePath = '/home/agent/index.html'
    const html = '<!doctype html><html><body>hi</body></html>'
    const dataUrl = `data:text/html;base64,${btoa(html)}`
    const openPreviewInBrowser = vi.fn(async () => undefined)
    const saveImageBuffer = vi.fn(async () => '/tmp/staged.html')

    $connection.set({ mode: 'remote' } as never)
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        api: vi.fn(async () => dataUrl),
        normalizePreviewTarget: vi.fn(async () => ({
          kind: 'file',
          label: 'index.html',
          path: remotePath,
          previewKind: 'html',
          source: remotePath,
          url: 'file:///home/agent/index.html'
        })),
        openPreviewInBrowser,
        saveImageBuffer
      }
    })

    render(
      <PreviewStatusRow
        item={{ cwd: '/home/agent', id: remotePath, label: 'index.html', target: remotePath }}
        onDismiss={() => undefined}
      />
    )

    fireEvent.click(screen.getByText('index.html'))

    await waitFor(() => {
      expect(saveImageBuffer).toHaveBeenCalled()
      expect(openPreviewInBrowser).toHaveBeenCalledWith('file:///tmp/staged.html')
    })
    expect($previewTabs.get()).toEqual([])
  })
})

/**
 * lib/openfilm-studio.ts: for an account the editor is open to, the agent says
 * 「点开右边的片子就能直接改字幕」, so a PLAIN click on its film.html row opens
 * the editor in the preview pane, not the system browser. Every other target,
 * and every target while the editor is off, keeps the browser; ⌘-click is unchanged.
 */
describe('PreviewStatusRow and an agent film.html', () => {
  const STUDIO_URL = 'http://127.0.0.1:53327/open?key=k&to=%2Fprojects%2Fcook'
  const original = window.hermesDesktop

  beforeEach(() => {
    $connection.set({ mode: 'local' } as never)
    $openfilmStudioOn.set(false)
    closeRightRail()
  })

  afterEach(() => {
    cleanup()
    $connection.set(null)
    $openfilmStudioOn.set(false)
    closeRightRail()
    Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: original })
  })

  function stubDesktop(path: string) {
    const openPreviewInBrowser = vi.fn(async () => undefined)
    const open = vi.fn(async () => ({ ok: true as const, url: STUDIO_URL }))

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: {
        normalizePreviewTarget: vi.fn(async () => ({
          kind: 'file',
          label: path.split('/').pop(),
          path,
          previewKind: 'html',
          source: path,
          url: `file://${path}`
        })),
        openfilmStudio: {
          open,
          prefetch: vi.fn(async () => 'started' as const),
          status: vi.fn(async () => ({ on: true, preparing: false, ready: true }))
        },
        openPreviewInBrowser
      }
    })

    return { open, openPreviewInBrowser }
  }

  interface Row {
    editorOn: boolean
    lands: 'browser' | 'file-tab' | 'studio'
    metaKey: boolean
    name: string
    path: string
  }

  it.each<Row>([
    {
      name: 'editor on, film.html, plain click',
      editorOn: true,
      path: '/work/cook/film.html',
      metaKey: false,
      lands: 'studio'
    },
    {
      name: 'editor off, film.html, plain click',
      editorOn: false,
      path: '/work/cook/film.html',
      metaKey: false,
      lands: 'browser'
    },
    {
      name: 'editor on, another html page, plain click',
      editorOn: true,
      path: '/work/cook/index.html',
      metaKey: false,
      lands: 'browser'
    },
    {
      name: 'editor on, a page only named like a film, plain click',
      editorOn: true,
      path: '/work/cook/my-film.html',
      metaKey: false,
      lands: 'browser'
    },
    {
      name: 'editor on, film.html, ⌘-click',
      editorOn: true,
      path: '/work/cook/film.html',
      metaKey: true,
      lands: 'studio'
    },
    {
      name: 'editor off, film.html, ⌘-click',
      editorOn: false,
      path: '/work/cook/film.html',
      metaKey: true,
      lands: 'file-tab'
    }
  ])('$name → $lands', async ({ editorOn, lands, metaKey, path }) => {
    $openfilmStudioOn.set(editorOn)
    const { open, openPreviewInBrowser } = stubDesktop(path)
    const label = path.split('/').pop()!

    render(<PreviewStatusRow item={{ cwd: '/work/cook', id: path, label, target: path }} onDismiss={() => undefined} />)

    fireEvent.click(screen.getByText(label), { metaKey })

    if (lands === 'studio') {
      await waitFor(() => expect($rightRailActiveTabId.get()).toBe(OPENFILM_STUDIO_TAB_ID))
      expect(open).toHaveBeenCalledWith('/work/cook')
      expect($previewTabs.get().map(tab => tab.id)).toEqual([OPENFILM_STUDIO_TAB_ID])
      expect(openPreviewInBrowser).not.toHaveBeenCalled()
    } else if (lands === 'browser') {
      await waitFor(() => expect(openPreviewInBrowser).toHaveBeenCalledWith(`file://${path}`))
      expect($previewTabs.get()).toEqual([])
      expect(open).not.toHaveBeenCalled()
    } else {
      await waitFor(() => expect($previewTabs.get().map(tab => tab.id)).toEqual([`file:file://${path}`]))
      expect(open).not.toHaveBeenCalled()
      expect(openPreviewInBrowser).not.toHaveBeenCalled()
    }
  })
})
