import { describe, expect, it, vi } from 'vitest'

import type { AnalysisDocument } from './analysis-types'
import { prepareVideoBreakdownHandoff } from './video-deep-breakdown-handoff'

const document: AnalysisDocument = {
  id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'clip.srt', kind: 'subtitle',
  status: 'ready', storageMode: 'local', evidenceOrigin: 'uploaded_video_audio',
  anchors: [{ id: 'a1', location: { start_seconds: 3, end_seconds: 5 }, text: 'verified speech' }],
  notes: [], questions: []
}

const jpeg = `data:image/jpeg;base64,${btoa('actual jpeg bytes')}`

describe('video frame handoff to the local Agent draft', () => {
  it('stages accepted frame files and names only their player times as visual evidence', async () => {
    const attach = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const draft = await prepareVideoBreakdownHandoff(document, 'en', [
      { seconds: 12.5, dataUrl: jpeg }, { seconds: 21.2, dataUrl: jpeg }
    ], attach)

    expect(attach).toHaveBeenCalledTimes(2)
    expect(attach.mock.calls[0][0]).toBeInstanceOf(File)
    expect(attach.mock.calls[0][0].name).toBe('apex-frame-12-5s.jpg')
    expect(attach.mock.calls[0][0].type).toBe('image/jpeg')
    expect(await attach.mock.calls[0][0].text()).toBe('actual jpeg bytes')
    expect(draft).toContain('Attached frames')
    expect(draft).toContain('0:12.5')
    expect(draft).not.toContain('0:21.2')
    expect(draft).toContain('1 captured frame(s) could not be attached')
    expect(draft).toContain('do not infer other shots or sound effects')
    expect(draft).toContain('[0:03–0:05] "verified speech"')
  })

  it('does not write malformed images or fabricate a frame when staging fails', async () => {
    const attach = vi.fn().mockRejectedValue(new Error('disk full'))
    const draft = await prepareVideoBreakdownHandoff(document, 'zh', [
      { seconds: 1, dataUrl: 'data:text/plain;base64,YQ==' },
      { seconds: 2, dataUrl: jpeg }
    ], attach)

    expect(attach).toHaveBeenCalledTimes(1)
    expect(draft).not.toContain('已附画面截图')
    expect(draft).toContain('另有 2 张截图未能附上')
  })

  it('never stages frames for an unresolved or untimed source', async () => {
    const attach = vi.fn()
    const draft = await prepareVideoBreakdownHandoff({ ...document, evidenceOrigin: undefined }, 'en', [
      { seconds: 1, dataUrl: jpeg }
    ], attach)

    expect(draft).toBeNull()
    expect(attach).not.toHaveBeenCalled()
  })
})
