import { OVERVIEW_LOCALES, type OverviewLocale, type OverviewSource } from './analysis-video-overview'

export interface SourceAnswerInput {
  schema: 1
  revision: string
  locale: OverviewLocale
  question: string
  answer_type: 'semantic_answer' | 'semantic_no_evidence'
  answer: string
  anchor_ids: string[]
}

export interface StoredSourceAnswer {
  id: string
  question: string
  answer: string
  answer_type: 'source_excerpts' | 'no_evidence' | SourceAnswerInput['answer_type']
  source_revision?: string | null
  citations: Array<{ anchor_id: string; location: Record<string, number | string> }>
}

/** The entire extracted text is used, or the question is refused before inference. */
export function sourceQuestionEvidence(source: OverviewSource) {
  const anchors = source.anchors ?? []

  if (source.status !== 'ready' || !['pdf', 'word', 'excel', 'text', 'feishu', 'subtitle'].includes(source.kind) ||
    !anchors.length || new Set(anchors.map(a => a.id)).size !== anchors.length ||
    anchors.some(a => !a.id || !a.text.trim())) {throw new Error('answer_evidence_invalid')}

  if (anchors.length > 2000 || JSON.stringify(anchors).length > 60000) {throw new Error('answer_source_too_large')}

  return anchors
}

export function validateSourceAnswer(value: unknown, source: OverviewSource, revision: string): SourceAnswerInput {
  const ids = new Set(sourceQuestionEvidence(source).map(a => a.id))
  const input = value as SourceAnswerInput | null

  if (!input || input.schema !== 1 || !/^[a-f0-9]{64}$/.test(revision) || input.revision !== revision ||
    !OVERVIEW_LOCALES.includes(input.locale) || typeof input.question !== 'string' ||
    input.question.trim().length < 2 || input.question.length > 1000 || typeof input.answer !== 'string' ||
    input.answer.length > 6000 || !Array.isArray(input.anchor_ids) || input.anchor_ids.length > 12 ||
    new Set(input.anchor_ids).size !== input.anchor_ids.length || input.anchor_ids.some(id => !ids.has(id))) {
    throw new Error('answer_output_invalid')
  }

  if (input.answer_type === 'semantic_answer') {
    if (!input.answer.trim() || !input.anchor_ids.length) {throw new Error('answer_output_invalid')}
  } else if (input.answer_type !== 'semantic_no_evidence' || input.answer !== '' || input.anchor_ids.length) {
    throw new Error('answer_output_invalid')
  }

  return { schema: 1, revision, locale: input.locale, question: input.question.trim(),
    answer_type: input.answer_type, answer: input.answer.trim(), anchor_ids: [...input.anchor_ids] }
}
