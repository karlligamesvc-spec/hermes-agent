/** Structured derived evidence shared by the native store and renderer. */
export const OVERVIEW_LOCALES = ['zh', 'zh-hant', 'en', 'ja', 'ar'] as const
export type OverviewLocale = typeof OVERVIEW_LOCALES[number]
export interface OverviewSource {
  kind: string
  status: string
  evidence_origin?: string | null
  evidenceOrigin?: string
  anchors?: Array<{ id: string; text: string; location: Record<string, number | string> }>
}
export interface VideoSemanticOverview {
  schema: 1
  revision: string
  locale: OverviewLocale
  points: Array<{ text: string; anchor_ids: string[] }>
}

export function overviewEvidence(source: OverviewSource) {
  const anchors = source.anchors ?? []

  if (source.kind !== 'subtitle' || source.status !== 'ready' ||
    !['linked_video_audio', 'uploaded_video_audio'].includes(source.evidence_origin ?? source.evidenceOrigin ?? '') ||
    !anchors.length || new Set(anchors.map(a => a.id)).size !== anchors.length || anchors.some(a => {
      const start = a.location.start_seconds
      const end = a.location.end_seconds

      return !a.id || !a.text.trim() || typeof start !== 'number' || !Number.isFinite(start) || start < 0 ||
        typeof end !== 'number' || !Number.isFinite(end) || end <= start
    })) {throw new Error('overview_evidence_invalid')}

  // Never summarize an undisclosed prefix or a few samples as if it were the full transcript.
  if (anchors.length > 2000 || JSON.stringify(anchors).length > 60000) {throw new Error('overview_source_too_large')}

  return anchors
}

export function validateVideoOverview(value: unknown, source: OverviewSource, revision: string, locale: string): VideoSemanticOverview {
  const anchors = new Set(overviewEvidence(source).map(a => a.id))
  const result = value as VideoSemanticOverview | null

  if (!OVERVIEW_LOCALES.includes(locale as OverviewLocale) || !revision || !result || result.schema !== 1 ||
    result.revision !== revision || result.locale !== locale || !Array.isArray(result.points) ||
    result.points.length < 1 || result.points.length > 6 || result.points.some(p =>
      !p || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 600 || !Array.isArray(p.anchor_ids) ||
      p.anchor_ids.length < 1 || p.anchor_ids.length > 5 || new Set(p.anchor_ids).size !== p.anchor_ids.length ||
      p.anchor_ids.some(id => !anchors.has(id)))) {throw new Error('overview_output_invalid')}

  return { schema: 1, revision, locale: locale as OverviewLocale,
    points: result.points.map(p => ({ text: p.text.trim(), anchor_ids: [...p.anchor_ids] })) }
}
