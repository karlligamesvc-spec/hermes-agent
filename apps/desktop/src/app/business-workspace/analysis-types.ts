import type { SourceAnswerInput, StoredSourceAnswer } from '../../../shared/analysis-answer'
import type { DeepAnalysisReport } from '../../../shared/analysis-deep-report'
import type { VideoSemanticOverview } from '../../../shared/analysis-video-overview'

export interface AnalysisAnchor {
  id: string
  location: Record<string, number | string>
  text: string
}

export type AnalysisQuestion = StoredSourceAnswer

export interface AnalysisNote {
  id: string
  body: string
  anchor_id: string | null
}

export interface AnalysisDocument {
  id: string
  filename: string
  kind: 'pdf' | 'word' | 'excel' | 'text' | 'feishu' | 'subtitle'
  status: 'processing' | 'ready' | 'failed'
  storageMode: 'cloud' | 'local'
  error_code?: string | null
  source_url?: string | null
  sourceUrl?: string
  anchors?: AnalysisAnchor[]
  notes?: AnalysisNote[]
  questions?: AnalysisQuestion[]
  createdAt?: string
  created_at?: string
  analysis_scope?: string
  analysis_revision?: string
  source_answers_supported?: boolean
  deep_reports?: DeepAnalysisReport[]
  video_overviews?: Record<string, VideoSemanticOverview>
  parse_version?: number
  evidence_origin?: 'linked_video_audio' | 'uploaded_video_audio' | null
  evidenceOrigin?: 'linked_video_audio' | 'uploaded_video_audio'
}

export interface AnalysisVideoResolution {
  platform: string | null
  status: 'original_site_only' | 'upload_required' | 'unreadable'
  capability: 'download_candidate' | 'audio_candidate' | 'captions_candidate' | 'upload_required' | null
  source_url: string | null
  evidence_status: 'not_read'
  can_answer: false
  can_play_in_app: false
}

export interface AnalysisDocumentsBridge {
  policy: () => Promise<{ ok: boolean; code?: string; policy?: { mode: 'cloud' | 'local'; cloud_storage_configured: boolean } }>
  list: () => Promise<{ ok: boolean; code?: string; cloudUnavailable?: boolean; items?: AnalysisDocument[] }>
  importFile: () => Promise<{ ok: boolean; code?: string; item?: AnalysisDocument }>
  importLink: (url: string) => Promise<{ ok: boolean; code?: string; item?: AnalysisDocument }>
  resolveVideoLink: (url: string) => Promise<{ ok: boolean; code?: string; resolution?: AnalysisVideoResolution }>
  transcribeVideoLink: (url: string) => Promise<{ ok: boolean; code?: string; item?: AnalysisDocument }>
  uploadVideo: () => Promise<{ ok: boolean; code?: string; item?: AnalysisDocument }>
  authorizeFeishu: () => Promise<{ ok: boolean; code?: string; flow_id?: string; verification_url?: string; interval?: number }>
  pollFeishu: (flowId: string) => Promise<{ ok: boolean; code?: string; status?: 'pending' | 'authorized' | 'denied' | 'expired'; interval?: number }>
  forgetFeishu: () => Promise<{ ok: boolean; code?: string }>
  get: (id: string) => Promise<{ ok: boolean; code?: string; item?: AnalysisDocument }>
  importDeepReport: (id: string, scope: string, revision: string) => Promise<{ ok: boolean; code?: string; item?: DeepAnalysisReport }>
  deleteDeepReport: (id: string, scope: string, reportId: string) => Promise<{ ok: boolean; code?: string }>
  transcriptForDraft: (id: string, scope: string, revision: string) => Promise<{ ok: boolean; code?: string; text?: string }>
  overviewContext: (id: string, scope: string) => Promise<{ ok: boolean; code?: string; item?: AnalysisDocument }>
  saveOverview: (id: string, scope: string, overview: VideoSemanticOverview) => Promise<{ ok: boolean; code?: string; item?: VideoSemanticOverview }>
  questionContext: (id: string, scope: string) => Promise<{ ok: boolean; code?: string; item?: AnalysisDocument }>
  saveAnswer: (id: string, scope: string, answer: SourceAnswerInput) => Promise<{ ok: boolean; code?: string; item?: AnalysisQuestion }>
  ask: (id: string, question: string) => Promise<{ ok: boolean; code?: string; item?: AnalysisQuestion }>
  addNote: (id: string, body: string, anchorId: string | null) => Promise<{ ok: boolean; code?: string; item?: AnalysisNote }>
  deleteNote: (id: string, noteId: string) => Promise<{ ok: boolean; code?: string }>
  retry: (id: string) => Promise<{ ok: boolean; code?: string }>
  delete: (id: string) => Promise<{ ok: boolean; code?: string }>
  openSource: (id: string) => Promise<{ ok: boolean; code?: string }>
  previewPdf: (id: string) => Promise<{ ok: boolean; code?: string; data_url?: string }>
}
