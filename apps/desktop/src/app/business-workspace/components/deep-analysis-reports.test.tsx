import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { AnalysisDocument, AnalysisDocumentsBridge } from '../analysis-types'

import { DeepAnalysisReports } from './deep-analysis-reports'

const report = { id: 'r1', filename: 'ANALYSIS.md', body: '<script>window.untrusted = true</script>\n# Findings', revision: 'rev-a', sha256: 'digest', created_at: '2026-09-29T00:00:00Z', provenance: 'selected_file' as const }
const source: AnalysisDocument = { id: 'local-a', filename: 'video.srt', kind: 'subtitle', status: 'ready', storageMode: 'local', analysis_scope: 'owner', analysis_revision: 'rev-a', deep_reports: [report] }
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('reopens a stored report as inert text, marks older revisions and removes the selected copy', async () => {
  const onChange = vi.fn()
  const deleteDeepReport = vi.fn().mockResolvedValue({ ok: true })
  const view = render(<DeepAnalysisReports bridge={{ deleteDeepReport } as unknown as AnalysisDocumentsBridge} locale="en" onChange={onChange} source={{ ...source, analysis_revision: 'rev-b' }} />)
  fireEvent.click(screen.getByText(/ANALYSIS.md ·/))
  expect(view.container.querySelector('pre')?.textContent).toBe(report.body)
  expect(view.container.querySelector('script')).toBeNull()
  expect(screen.getByText('Saved for an earlier source revision. Check its references again.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Delete copy · ANALYSIS.md' }))
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([]))
  expect(deleteDeepReport).toHaveBeenCalledWith('local-a', 'owner', 'r1')
})

it('imports once, displays stable errors, and ignores results after source or account switch', async () => {
  const onChange = vi.fn()
  const importDeepReport = vi.fn().mockResolvedValueOnce({ ok: false, code: 'report_too_large' })
  const bridge = { importDeepReport } as unknown as AnalysisDocumentsBridge
  const view = render(<DeepAnalysisReports bridge={bridge} key="a" locale="en" onChange={onChange} source={{ ...source, deep_reports: [] }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save report file' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The report exceeds 64 KiB. Shorten it and retry.')
  let finish!: (result: unknown) => void
  importDeepReport.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fireEvent.click(screen.getByRole('button', { name: 'Save report file' }))
  fireEvent.click(screen.getByRole('button', { name: 'Saving…' }))
  expect(importDeepReport).toHaveBeenCalledTimes(2)
  expect(importDeepReport).toHaveBeenLastCalledWith('local-a', 'owner', 'rev-a')
  view.rerender(<DeepAnalysisReports bridge={bridge} key="b" locale="en" onChange={onChange} source={{ ...source, id: 'local-b', analysis_scope: 'other', deep_reports: [] }} />)
  await act(async () => {finish({ ok: true, item: report })})
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.queryByText(report.body)).toBeNull()
})

it('merges a returned report and keeps cancel quiet', async () => {
  const onChange = vi.fn()
  const importDeepReport = vi.fn().mockResolvedValueOnce({ ok: false, code: 'cancelled' }).mockResolvedValueOnce({ ok: true, item: report })
  render(<DeepAnalysisReports bridge={{ importDeepReport } as unknown as AnalysisDocumentsBridge} locale="zh" onChange={onChange} source={{ ...source, deep_reports: [] }} />)
  fireEvent.click(screen.getByRole('button', { name: '保存报告文件' }))
  await screen.findByRole('button', { name: '保存报告文件' })
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '保存报告文件' }))
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([report]))
})

it('collects only the clicked workspace filename, explains missing output and supports retry at report capacity', async () => {
  const onChange = vi.fn()
  const collectDeepReport = vi.fn().mockResolvedValueOnce({ ok: false, code: 'workspace_report_missing' }).mockResolvedValue({ ok: true, item: report })
  const reports = Array.from({ length: 5 }, (_, index) => ({ ...report, id: `r${index + 1}` }))
  render(<DeepAnalysisReports bridge={{ collectDeepReport } as unknown as AnalysisDocumentsBridge} locale="en" onChange={onChange} source={{ ...source, deep_reports: reports }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Collect TIMELINE.md' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This report has not been written yet. Retry after the Agent finishes.')
  expect(collectDeepReport).toHaveBeenLastCalledWith('local-a', 'owner', 'rev-a', 'TIMELINE.md')
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Collect ANALYSIS.md' }))
  await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([...reports.slice(1), report]))
  expect(collectDeepReport).toHaveBeenLastCalledWith('local-a', 'owner', 'rev-a', 'ANALYSIS.md')
})


it('explains that a prepared but unsent draft cannot collect yet', async () => {
  const onChange = vi.fn()
  const collectDeepReport = vi.fn().mockResolvedValue({ ok: false, code: 'workspace_submission_missing' })
  render(<DeepAnalysisReports bridge={{ collectDeepReport } as unknown as AnalysisDocumentsBridge} locale="en" onChange={onChange} source={{ ...source, deep_reports: [] }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Collect ANALYSIS.md' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Send the breakdown draft first. Its folder is bound only after the send is accepted.')
  expect(onChange).not.toHaveBeenCalled()
})
