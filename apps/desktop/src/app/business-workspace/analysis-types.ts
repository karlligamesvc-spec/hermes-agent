export interface AnalysisAnchor {
  id: string
  location: Record<string, number | string>
  text: string
}

export interface AnalysisQuestion {
  id: string
  question: string
  answer: string
  answer_type: 'no_evidence' | 'source_excerpts'
  citations: Array<{ anchor_id: string; location: Record<string, number | string> }>
}

export interface AnalysisNote {
  id: string
  body: string
  anchor_id: string | null
}

export interface AnalysisDocument {
  id: string
  filename: string
  kind: 'pdf' | 'word' | 'excel' | 'text' | 'feishu'
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
  authorizeFeishu: () => Promise<{ ok: boolean; code?: string; flow_id?: string; verification_url?: string; interval?: number }>
  pollFeishu: (flowId: string) => Promise<{ ok: boolean; code?: string; status?: 'pending' | 'authorized' | 'denied' | 'expired'; interval?: number }>
  forgetFeishu: () => Promise<{ ok: boolean; code?: string }>
  get: (id: string) => Promise<{ ok: boolean; code?: string; item?: AnalysisDocument }>
  ask: (id: string, question: string) => Promise<{ ok: boolean; code?: string; item?: AnalysisQuestion }>
  addNote: (id: string, body: string, anchorId: string | null) => Promise<{ ok: boolean; code?: string; item?: AnalysisNote }>
  deleteNote: (id: string, noteId: string) => Promise<{ ok: boolean; code?: string }>
  retry: (id: string) => Promise<{ ok: boolean; code?: string }>
  delete: (id: string) => Promise<{ ok: boolean; code?: string }>
  openSource: (id: string) => Promise<{ ok: boolean; code?: string }>
}
