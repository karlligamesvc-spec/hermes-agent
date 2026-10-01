import { afterEach, expect, it, vi } from 'vitest'

import { $composerAttachments } from '@/store/composer'

import type { WiringActions } from '../contrib/types'

import type { AnalysisDocument } from './analysis-types'
import { stageVideoAnalysisDraft } from './video-analysis-composer-handoff'
import { syncVideoTranscriptDraft, VIDEO_TRANSCRIPT_COPY } from './video-transcript-draft'

const originalBridge = window.hermesDesktop

const source: AnalysisDocument = { id: 'owned-source', filename: 'clip.srt', kind: 'subtitle', status: 'ready',
  storageMode: 'local', evidenceOrigin: 'uploaded_video_audio', analysis_scope: 'owner', analysis_revision: 'current',
  anchors: [{ id: 'a1', text: 'speech', location: { start_seconds: 1, end_seconds: 3 } }] }

const ownFile = { id: 'user-file', occurrenceId: 'user-1', kind: 'file' as const, label: 'my-notes.txt' }
const actions = { onAttachImageBlob: vi.fn() } as unknown as WiringActions

function bridge(read = vi.fn().mockResolvedValue({ ok: true, text: 'complete native JSON' }),
  save = vi.fn().mockResolvedValue('/local/Full transcript.txt')) {
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: {
    analysisDocuments: { transcriptForDraft: read }, savePastedText: save
  } })
  $composerAttachments.set([ownFile])

  return { read, save }
}

afterEach(() => {
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: originalBridge })
  $composerAttachments.set([])
})

it('attaches full native text once and revokes the evidence claim for a removed or replaced occurrence in every locale', async () => {
  for (const locale of ['zh', 'zh-hant', 'en', 'ja', 'ar'] as const) {
    const { read, save } = bridge()
    const staged = await stageVideoAnalysisDraft(source, locale, [], actions, () => true)

    expect(read).toHaveBeenNthCalledWith(1, source.id, 'owner', 'current')
    expect(read).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenCalledExactlyOnceWith('complete native JSON')
    expect(staged.draft.length).toBeLessThan(4000)
    expect(staged.draft).toContain(VIDEO_TRANSCRIPT_COPY[locale].attached)
    const [attachment] = staged.attachments

    expect(attachment).toMatchObject({ kind: 'file', analysisTranscriptSourceId: source.id, path: '/local/Full transcript.txt' })
    expect(attachment.refText).toContain('@file:')
    expect($composerAttachments.get()).toEqual([ownFile, attachment])
    const withEdits = staged.draft + '\nMy question'
    expect(syncVideoTranscriptDraft(withEdits, staged.transcript!, [ownFile, attachment])).toBe(withEdits)
    const replaced = { ...attachment, occurrenceId: 'replacement' }
    const removed = syncVideoTranscriptDraft(withEdits, staged.transcript!, [ownFile, replaced])
    expect(removed).toContain(VIDEO_TRANSCRIPT_COPY[locale].unavailable)
    expect(removed).not.toContain(VIDEO_TRANSCRIPT_COPY[locale].attached)
    expect(removed).toContain('My question')
  }
})

it.each(['scope', 'source', 'disk', 'limit'])('preserves user files and tells the truth when %s changes while staging', async failure => {
  let current = true
  const { read, save } = bridge()

  if (failure === 'scope') {save.mockImplementation(async () => {current = false;

 return '/late/file.txt'})}

  if (failure === 'source') {read.mockResolvedValueOnce({ ok: true, text: 'complete native JSON' }).mockResolvedValueOnce({ ok: false, code: 'transcript_source_changed' })}

  if (failure === 'disk') {save.mockRejectedValue(new Error('disk full'))}

  if (failure === 'limit') {read.mockResolvedValue({ ok: false, code: 'transcript_too_large' })}
  const result = stageVideoAnalysisDraft(source, 'en', [], actions, () => current)

  if (failure === 'scope' || failure === 'source') {
    await expect(result).rejects.toThrow(/analysis_context_changed|transcript_source_changed/)
  } else {
    const staged = await result
    expect(staged.transcript).toBeUndefined()
    expect(staged.draft).toContain('No full transcript is attached')
  }

  expect($composerAttachments.get()).toEqual([ownFile])
})

it('binds output instructions within the draft limit in every locale, without copying evidence into the workspace', async () => {
  const directory = 'C:\\Users\\User With Spaces\\Local\\analysis-workspaces\\' + 'a'.repeat(64) + '\\' + 'b'.repeat(64)
  const longSource = { ...source, anchors: Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, text: 'long speech '.repeat(40), location: { start_seconds: i, end_seconds: i + 1 } })) }

  for (const locale of ['zh', 'zh-hant', 'en', 'ja', 'ar'] as const) {
    bridge()
    const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const prepare = vi.fn().mockResolvedValue({ ok: true, directory, workspaceId })
    window.hermesDesktop!.analysisDocuments!.prepareDeepWorkspace = prepare
    const staged = await stageVideoAnalysisDraft(longSource, locale, [], actions, () => true)
    expect(prepare).toHaveBeenCalledExactlyOnceWith(source.id, 'owner', 'current')
    expect(staged.draft.length).toBeLessThan(4000)
    expect(staged.workspaceId).toBe(workspaceId)
    expect(staged.draft).toContain(JSON.stringify(directory))
    expect(staged.draft).toContain('--workspace')
    expect(staged.draft).toContain('ANALYSIS.md')
    expect(staged.draft).toContain('TIMELINE.md')
    const removed = syncVideoTranscriptDraft(staged.draft, staged.transcript!, [])
    expect(removed).not.toContain(VIDEO_TRANSCRIPT_COPY[locale].attached)
    expect(removed).toContain(JSON.stringify(directory))
  }
})

it('rolls back only staged attachments if workspace preparation fails or returns into another context', async () => {
  for (const failure of ['native', 'context']) {
    bridge()
    let current = true
    window.hermesDesktop!.analysisDocuments!.prepareDeepWorkspace = vi.fn().mockImplementation(async () => {
      if (failure === 'context') {current = false}

      return failure === 'native' ? { ok: false, code: 'workspace_invalid' } : { ok: true, directory: '/late/workspace' }
    })
    await expect(stageVideoAnalysisDraft(source, 'en', [], actions, () => current)).rejects.toThrow(failure === 'native' ? 'workspace_invalid' : 'analysis_context_changed')
    expect($composerAttachments.get()).toEqual([ownFile])
  }
})
