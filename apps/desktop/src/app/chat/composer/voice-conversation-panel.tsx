import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import type { LiveTranscriptFragment } from '@/lib/voice-live'

import type { ConversationStatus } from './hooks/use-voice-conversation'

interface VoiceConversationPanelProps {
  engineName?: string | null
  level: number
  muted: boolean
  status: ConversationStatus
  transcript?: LiveTranscriptFragment[]
  onEnd: () => void
  onToggleMute: () => void
}

/** Presentation stays outside the home/composer clipping ancestors. The owning
 * composer retains the microphone and transport when a voice tool opens a chat. */
export function VoiceConversationPanel({
  engineName,
  level,
  muted,
  status,
  transcript = [],
  onEnd,
  onToggleMute
}: VoiceConversationPanelProps) {
  const { t } = useI18n()
  const c = t.composer
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)

  const label = muted
    ? c.muted
    : status === 'speaking'
      ? c.speaking
      : status === 'thinking'
        ? c.thinking
        : status === 'transcribing'
          ? c.transcribing
          : status === 'idle'
            ? t.common.loading
            : c.listening

  const turns: LiveTranscriptFragment[] = []

  for (const fragment of transcript) {
    const last = turns.at(-1)

    if (last && last.speaker === fragment.speaker && last.turnId === fragment.turnId) {
      last.text += fragment.text
    } else {
      turns.push({ ...fragment })
    }
  }

  return createPortal(
    <section
      aria-label={c.startVoice}
      className="fixed left-1/2 top-14 z-40 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 rounded-3xl border border-(--stroke-nous) bg-(--ui-bg-elevated) p-3 shadow-nous"
      data-voice-conversation-panel=""
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
        >
          <Codicon name="mic" size="1.25rem" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{engineName || c.startVoice}</p>
          <div className="flex items-center gap-2 text-xs text-(--ui-text-secondary)">
            <span aria-hidden="true" className="flex h-3 items-center gap-0.5">
              {[0.5, 0.8, 1, 0.8, 0.5].map((weight, index) => (
                <span
                  className="w-0.5 rounded-full bg-primary"
                  key={index}
                  style={{ height: `${30 + (muted ? 0 : Math.min(1, level) * weight * 70)}%` }}
                />
              ))}
            </span>
            <span role="status">{label}</span>
          </div>
        </div>
        <Button
          aria-label={c.voiceSettings}
          className="rounded-full bg-muted"
          onClick={() => navigate('/settings?tab=config:voice')}
          size="icon"
          title={c.voiceSettings}
          type="button"
          variant="ghost"
        >
          <Codicon name="settings-gear" size="1rem" />
        </Button>
        <Button
          aria-expanded={expanded}
          aria-label={c.voiceTranscript}
          aria-pressed={expanded}
          className="rounded-full bg-muted"
          onClick={() => setExpanded(value => !value)}
          size="icon"
          title={c.voiceTranscript}
          type="button"
          variant="ghost"
        >
          <Codicon name="comment-discussion" size="1rem" />
        </Button>
        <Button
          aria-label={muted ? c.unmuteMic : c.muteMic}
          aria-pressed={muted}
          className="rounded-full bg-muted"
          onClick={onToggleMute}
          size="icon"
          title={muted ? c.unmuteMic : c.muteMic}
          type="button"
          variant="ghost"
        >
          <Codicon name={muted ? 'mic-off' : 'mic'} size="1rem" />
        </Button>
        <Button
          aria-label={c.endConversation}
          className="rounded-full"
          onClick={onEnd}
          size="icon"
          title={c.endConversation}
          type="button"
          variant="destructive"
        >
          <Codicon name="close" size="1.125rem" />
        </Button>
      </div>
      {expanded && (
        <div
          aria-label={c.voiceTranscript}
          className="mt-3 max-h-64 overflow-y-auto overscroll-contain px-1 text-sm leading-6"
          role="log"
        >
          {turns.length ? (
            turns.map((turn, index) => (
              <p
                className={`mb-2 rounded-2xl px-3 py-2 ${turn.speaker === 'user' ? 'ml-8 bg-primary/10' : 'mr-8 bg-muted'}`}
                key={index}
              >
                {turn.text}
              </p>
            ))
          ) : (
            <p className="py-3 text-center text-(--ui-text-secondary)">{c.voiceTranscriptEmpty}</p>
          )}
        </div>
      )}
    </section>,
    document.body
  )
}
