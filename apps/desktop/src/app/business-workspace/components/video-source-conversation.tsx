import { type ReactNode, useEffect, useRef } from 'react'

import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

import { validateVideoOverview } from '../../../../shared/analysis-video-overview'
import { ANALYSIS_PAGE_COPY } from '../analysis-page-copy'
import type { AnalysisDocument, AnalysisDocumentsBridge } from '../analysis-types'
import type { VideoBreakdownLocale } from '../video-deep-breakdown-draft'

import { SOURCE_ANSWER_COPY, SourceQuestionAction } from './source-question-answer'
import { VIDEO_SOURCE_CHAT_COPY } from './video-source-chat-copy'

function ConversationLog({ children, count, pending }: { children: ReactNode; count: number; pending: boolean }) {
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (log.current) {
      log.current.scrollTop = log.current.scrollHeight
    }
  }, [count, pending])

  return (
    <div aria-live="polite" className="analysis-conversation-messages" ref={log} role="log">
      {children}
    </div>
  )
}

export function VideoSourceConversation({
  source,
  locale,
  bridge,
  question,
  setQuestion,
  onSaved,
  jump,
  label,
  advanced
}: {
  source: AnalysisDocument
  locale: VideoBreakdownLocale
  bridge: AnalysisDocumentsBridge | null
  question: string
  setQuestion: (value: string) => void
  onSaved: (id: string) => Promise<void>
  jump: (id: string) => void
  label: (location: Record<string, string | number>) => string
  advanced: ReactNode
}) {
  const copy = VIDEO_SOURCE_CHAT_COPY[locale]
  const answerCopy = SOURCE_ANSWER_COPY[locale]
  let summary: ReturnType<typeof validateVideoOverview> | undefined

  try {
    summary = validateVideoOverview(source.video_overviews?.[locale], source, source.analysis_revision ?? '', locale)
  } catch {
    /* No current saved summary. */
  }

  const citations = (ids: string[]) => (
    <div className="analysis-conversation-citations">
      {ids.map(id => {
        const anchor = source.anchors?.find(item => item.id === id)

        return (
          anchor && (
            <Button key={id} onClick={() => jump(id)} size="inline" type="button" variant="link">
              {ANALYSIS_PAGE_COPY[locale].citation} · {label(anchor.location)}
            </Button>
          )
        )
      })}
    </div>
  )

  return (
    <div className="analysis-source-conversation">
      <SourceQuestionAction bridge={bridge} locale={locale} onSaved={onSaved} question={question} source={source}>
        {({ busy, available, submittedQuestion, submit }) => (
          <>
            <ConversationLog count={source.questions?.length ?? 0} pending={busy}>
              {summary && (
                <article className="analysis-conversation-assistant">
                  <p className="text-xs text-(--ui-text-tertiary)">{copy.summary}</p>
                  {summary.points.map((point, index) => (
                    <div key={index}>
                      <CompactMarkdown className="text-sm" text={point.text} />
                      {citations(point.anchor_ids)}
                    </div>
                  ))}
                </article>
              )}
              {!summary && !source.questions?.length && !busy && (
                <p className="analysis-conversation-empty">{copy.empty}</p>
              )}
              {(source.questions ?? []).map(item => (
                <div className="analysis-conversation-turn" key={item.id}>
                  <p className="analysis-conversation-user">{item.question}</p>
                  <article className="analysis-conversation-assistant">
                    {item.source_revision && item.source_revision !== source.analysis_revision && (
                      <p className="text-xs text-(--ui-text-tertiary)">{answerCopy.stale}</p>
                    )}
                    <CompactMarkdown
                      className="text-sm text-(--ui-text-primary)"
                      text={
                        item.answer_type === 'no_evidence' || item.answer_type === 'semantic_no_evidence'
                          ? answerCopy.noEvidence
                          : item.answer
                      }
                    />
                    {(!item.source_revision || item.source_revision === source.analysis_revision) &&
                      citations(item.citations.map(citation => citation.anchor_id))}
                  </article>
                </div>
              ))}
              {busy && (
                <div className="analysis-conversation-turn">
                  <p className="analysis-conversation-user">{submittedQuestion}</p>
                  <p role="status">{answerCopy.pending}</p>
                </div>
              )}
            </ConversationLog>
            <form
              className="analysis-conversation-composer"
              onSubmit={event => {
                event.preventDefault()
                submit()
              }}
            >
              <Textarea
                aria-label={ANALYSIS_PAGE_COPY[locale].question}
                className="resize-none"
                maxLength={1000}
                onChange={event => setQuestion(event.target.value)}
                onKeyDown={event => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229
                  ) {
                    event.preventDefault()
                    submit()
                  }
                }}
                placeholder={copy.placeholder}
                rows={3}
                value={question}
              />
              <Button disabled={!available || busy || question.trim().length < 2} type="submit">
                {copy.send}
              </Button>
            </form>
            <details className="analysis-conversation-disclosure">
              <summary>{copy.details}</summary>
              <p>{copy.disclosure}</p>
            </details>
          </>
        )}
      </SourceQuestionAction>
      <details className="analysis-conversation-advanced">
        <summary>{copy.more}</summary>
        {advanced}
      </details>
    </div>
  )
}
