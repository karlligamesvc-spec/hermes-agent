import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { openSession } from '@/app/open-session'
import { Button } from '@/components/ui/button'
import { getSession } from '@/hermes'

import type { AnalysisChatLink } from '../../../../shared/analysis-chat-link'
import type { OverviewLocale } from '../../../../shared/analysis-video-overview'
import type { AnalysisDocument, AnalysisDocumentsBridge } from '../analysis-types'
import { ANALYSIS_CHAT_COPY, analysisChatContextMatches } from '../video-analysis-chat-handoff'

export function DeepAnalysisChat({ source, locale, bridge }: {
  source: AnalysisDocument; locale: OverviewLocale; bridge: AnalysisDocumentsBridge | null | undefined
}) {
  const navigate = useNavigate()
  const copy = ANALYSIS_CHAT_COPY[locale]
  const generation = useRef(0)
  const [link, setLink] = useState<AnalysisChatLink | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  // A request generation guards component lifetime; no reactive atom is mirrored.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    let active = true
    generation.current += 1
    setState('loading'); setLink(null); setError('')
    const read = bridge?.readDeepChat

    if (!read || !source.analysis_scope || !source.analysis_revision) {return}
    void read(source.id, source.analysis_scope, source.analysis_revision).then(result => {
      if (!active) {return}
      setLink(result.item ?? null); setState(result.ok ? 'ready' : 'error')
    }).catch(() => {if (active) {setState('error')}})

    return () => { active = false; generation.current += 1 }
  }, [bridge, source.id, source.analysis_scope, source.analysis_revision, attempt])

  if (!bridge?.readDeepChat) {return null}

  return <div className="space-y-2 text-xs">
    <p className="text-(--ui-text-tertiary)">{copy.hint}</p>
    {state === 'ready' && !link && <p>{copy.none}</p>}
    {state === 'error' && <button onClick={() => setAttempt(value => value + 1)} type="button">{copy.failed}</button>}
    {link && <Button disabled={opening} onClick={() => { void (async () => {
      const started = generation.current
      setOpening(true); setError('')

      try {
        if (!analysisChatContextMatches(link)) {setError(copy.context);

 return}

        // Re-read source ownership before opening; then verify this durable session on its original backend/profile.
        const current = await bridge!.readDeepChat!(source.id, source.analysis_scope!, source.analysis_revision!)

        if (!current.ok || current.item?.sessionId !== link.sessionId) {throw new Error('analysis_context_changed')}
        await getSession(link.sessionId, { connectionId: link.connectionId, profile: link.profile })

        if (started !== generation.current) {return}

        if (!analysisChatContextMatches(link)) {setError(copy.context);

 return}

        const verified = await bridge!.readDeepChat!(source.id, source.analysis_scope!, source.analysis_revision!)

        if (started !== generation.current) {return}

        if (!verified.ok || verified.item?.sessionId !== link.sessionId || !analysisChatContextMatches(link)) {throw new Error('analysis_context_changed')}
        openSession(link.sessionId, navigate)
      } catch {setError(copy.failed)} finally {setOpening(false)}
    })() }} size="sm" variant="outline">{copy.open}</Button>}
    {error && <p role="alert">{error}</p>}
  </div>
}
