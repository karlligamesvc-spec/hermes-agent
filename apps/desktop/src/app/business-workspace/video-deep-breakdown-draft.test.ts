import { describe, expect, it } from 'vitest'

import type { AnalysisDocument } from './analysis-types'
import { videoDeepBreakdownDraft } from './video-deep-breakdown-draft'

function source(anchors: AnalysisDocument['anchors'], sourceUrl?: string): AnalysisDocument {
  return {
    id: 'local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'source-video.srt', kind: 'subtitle',
    status: 'ready', storageMode: 'local', parseVersion: sourceUrl ? undefined : 'uploaded_video_audio_v1',
    sourceUrl, anchors, notes: [], questions: []
  }
}

describe('video deep breakdown handoff', () => {
  it('passes an owned linked-video transcript to the Agent as a reviewable, evidence-bounded draft', () => {
    const draft = videoDeepBreakdownDraft(source([
      { id: 'a1', location: { start_seconds: 2, end_seconds: 5 }, text: '实际口播' }
    ], 'https://www.iesdouyin.com/share/video/123'), 'zh')

    expect(draft).toContain('https://www.iesdouyin.com/share/video/123')
    expect(draft).toContain('[0:02–0:05] 实际口播')
    expect(draft).toContain('只有实际检查原视频或截图后才分析镜头')
    expect(draft).toContain('音效还需要实际听到原音频，截图不足以证明')
    expect(draft).toContain('先读取当前可用的 short-video-studio 与 Hypit Skill')
    expect(draft).not.toContain('以下只包含部分原文')
  })

  it('marks an uploaded original as needing reattachment and a long transcript as partial', () => {
    const anchors = Array.from({ length: 80 }, (_, index) => ({
      id: `a${index + 1}`, location: { start_seconds: index * 5, end_seconds: index * 5 + 2 },
      text: `第 ${index + 1} 段真实口播 ${'内容'.repeat(30)}`
    }))
    const draft = videoDeepBreakdownDraft(source(anchors), 'zh')!

    expect(draft).toContain('在聊天中重新附上原视频')
    expect(draft).toContain('以下只包含部分原文')
    expect(draft).not.toContain('第 80 段真实口播')
    expect(draft.length).toBeLessThanOrEqual(4000)
    for (const locale of ['zh', 'zh-hant', 'en', 'ja', 'ar'] as const) {
      expect(videoDeepBreakdownDraft(source(anchors), locale)!.length).toBeLessThanOrEqual(4000)
    }
  })

  it('never prepares a deep-video claim from untimed captions or an unresolved URL', () => {
    expect(videoDeepBreakdownDraft(source([
      { id: 'a1', location: { paragraph: 1 }, text: '无时间码' }
    ]), 'zh')).toBeNull()
    expect(videoDeepBreakdownDraft({ ...source([
      { id: 'a1', location: { start_seconds: 2, end_seconds: 5 }, text: '有时间码' }
    ]), parseVersion: undefined }, 'zh')).toBeNull()
  })
})
