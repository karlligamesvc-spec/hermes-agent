import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import { addLocalNote, createLocalUploadedVideoTranscript, deleteLocalDocument, getLocalDocument, localOverviewRevision, saveLocalVideoOverview } from './apex-analysis-local'

it('persists only for its owner and current source while preserving concurrent notes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-store-'))
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  try {
    const source = createLocalUploadedVideoTranscript(root, owner, { filename: 'clip.srt', evidence_origin: 'uploaded_video_audio',
      srt: '1\n00:00:01,000 --> 00:00:02,000\nRevenue grew\n',
      anchors: [{ id: 'a1', text: 'Revenue grew', location: { start_seconds: 1, end_seconds: 2 } }] })
    const item = { schema: 1 as const, locale: 'en' as const, revision: localOverviewRevision(source), points: [{ text: 'Revenue grew.', anchor_ids: ['a1'] }] }
    addLocalNote(root, owner, source.id, 'Concurrent note', 'a1')
    saveLocalVideoOverview(root, owner, source.id, item)
    expect(getLocalDocument(root, owner, source.id)?.video_overviews?.en).toEqual(item)
    expect(getLocalDocument(root, owner, source.id)?.notes[0].body).toBe('Concurrent note')
    expect(() => saveLocalVideoOverview(root, other, source.id, item)).toThrow('source_not_found')
    expect(() => saveLocalVideoOverview(root, owner, source.id, { ...item, revision: 'old' })).toThrow('overview_output_invalid')
    expect(() => saveLocalVideoOverview(root, owner, source.id, { ...item, points: [{ text: 'Wrong', anchor_ids: ['fake'] }] })).toThrow('overview_output_invalid')
    deleteLocalDocument(root, owner, source.id)
    expect(() => saveLocalVideoOverview(root, owner, source.id, item)).toThrow('source_not_found')
    expect(getLocalDocument(root, owner, source.id)).toBeNull()
  } finally {fs.rmSync(root, { recursive: true, force: true })}
})
