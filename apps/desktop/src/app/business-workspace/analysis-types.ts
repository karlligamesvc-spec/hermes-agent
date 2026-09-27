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
  kind: 'pdf' | 'word' | 'excel' | 'text'
  status: 'processing' | 'ready' | 'failed'
  storageMode: 'cloud' | 'local'
  error_code?: string | null
  anchors?: AnalysisAnchor[]
  notes?: AnalysisNote[]
  questions?: AnalysisQuestion[]
  createdAt?: string
  created_at?: string
}

export interface AnalysisDocumentsBridge {
  policy: () => Promise<{ ok: boolean; code?: string; policy?: { mode: 'cloud' | 'local'; cloud_storage_configured: boolean } }>
  list: () => Promise<{ ok: boolean; code?: string; cloudUnavailable?: boolean; items?: AnalysisDocument[] }>
  importFile: () => Promise<{ ok: boolean; code?: string; item?: AnalysisDocument }>
  get: (id: string) => Promise<{ ok: boolean; code?: string; item?: AnalysisDocument }>
  ask: (id: string, question: string) => Promise<{ ok: boolean; code?: string; item?: AnalysisQuestion }>
  addNote: (id: string, body: string, anchorId: string | null) => Promise<{ ok: boolean; code?: string; item?: AnalysisNote }>
  deleteNote: (id: string, noteId: string) => Promise<{ ok: boolean; code?: string }>
  retry: (id: string) => Promise<{ ok: boolean; code?: string }>
  delete: (id: string) => Promise<{ ok: boolean; code?: string }>
  openSource: (id: string) => Promise<{ ok: boolean; code?: string }>
}
