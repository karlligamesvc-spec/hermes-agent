import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AnalysisDocument } from '../analysis-types'

import { AnalysisWorkspaceFrame } from './analysis-workspace-frame'

afterEach(cleanup)

const source: AnalysisDocument = {
  id: 'document-1', filename: 'actual.pdf', kind: 'pdf', status: 'ready', storageMode: 'local',
  anchors: [{ id: 'actual-page-7', location: { page: 7 }, text: 'Source excerpt from page seven.' }]
}

describe('analysis workspace frame', () => {
  it('navigates actual excerpts, keeps a notes draft across tabs, and exposes both reading regions', () => {
    const jump = vi.fn()
    render(<AnalysisWorkspaceFrame companion={<input aria-label="Ask about the source" />} jump={jump}
      label={location => `Page ${location.page}`} locale="en" notes={<input aria-label="Note draft" defaultValue="unsaved note" />}
      reader={<p>Actual PDF reader</p>} source={source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Page 7: Source excerpt from page seven.' }))
    expect(jump).toHaveBeenCalledExactlyOnceWith('actual-page-7')
    expect(within(screen.getByRole('region', { name: 'Source reader' })).getByText('Actual PDF reader')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Reading companion' })).getByRole('textbox', { name: 'Ask about the source' })).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Research notes' }), { button: 0, ctrlKey: false })
    const draft = screen.getByRole('textbox', { name: 'Note draft' })
    fireEvent.change(draft, { target: { value: 'keep this draft' } })
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Outline' }), { button: 0, ctrlKey: false })
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Research notes' }), { button: 0, ctrlKey: false })
    expect(screen.getByRole('textbox', { name: 'Note draft' })).toBe(draft)
    expect((draft as HTMLInputElement).value).toBe('keep this draft')
    expect(screen.getByRole('link', { name: 'Go to source' }).getAttribute('href')).toBe(`#${screen.getByRole('region', { name: 'Source reader' }).id}`)
  })

  it('keeps media mounted through notes and retains the real viewing companion', () => {
    render(<AnalysisWorkspaceFrame companion={<button type="button">Actual video question</button>} jump={vi.fn()}
      label={location => `${location.start_seconds}s`} locale="en" notes={<p>Actual video notes</p>}
      reader={<video aria-label="Paired local video" />} source={{ ...source, kind: 'subtitle' }} />)
    const media = screen.getByLabelText('Paired local video')
    expect(screen.queryByRole('region', { name: 'Source reader' })).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Video conversation' })).getByRole('button', { name: 'Actual video question' })).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Research notes' }), { button: 0, ctrlKey: false })
    expect(media.isConnected).toBe(true)
    expect(screen.getByText('Actual video notes').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Media and transcript' }), { button: 0, ctrlKey: false })
    expect(screen.getByLabelText('Paired local video')).toBe(media)
    expect(screen.getByRole('link', { name: 'Go to companion' }).getAttribute('href')).toBe(`#${screen.getByRole('region', { name: 'Video conversation' }).id}`)
  })

  it('lets the owner reveal the actual media after a notes citation without remounting either pane', () => {
    const onSourcePaneChange = vi.fn()

    const props = {
      companion: <p>Actual companion</p>, jump: vi.fn(), label: () => 'Actual timestamp', locale: 'en' as const,
      notes: <input aria-label="Controlled note draft" defaultValue="quoted source" />,
      reader: <video aria-label="Controlled local video" />, source: { ...source, kind: 'subtitle' as const },
      onSourcePaneChange
    }

    const view = render(<AnalysisWorkspaceFrame {...props} sourcePane="notes" />)
    const media = screen.getByLabelText('Controlled local video')
    const draft = screen.getByRole('textbox', { name: 'Controlled note draft' })
    expect(media.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Media and transcript' }), { button: 0, ctrlKey: false })
    expect(onSourcePaneChange).toHaveBeenCalledExactlyOnceWith('source')
    expect(media.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true)
    view.rerender(<AnalysisWorkspaceFrame {...props} sourcePane="source" />)
    expect(screen.getByLabelText('Controlled local video')).toBe(media)
    expect(media.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false)
    view.rerender(<AnalysisWorkspaceFrame {...props} sourcePane="notes" />)
    expect(screen.getByRole('textbox', { name: 'Controlled note draft' })).toBe(draft)
    expect((draft as HTMLInputElement).value).toBe('quoted source')
  })
})
