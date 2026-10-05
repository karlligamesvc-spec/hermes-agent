import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { iconSize, MicOff } from '@/lib/icons'
import type { LiveTranscriptFragment } from '@/lib/voice-live'

import type { ConversationStatus } from './hooks/use-voice-conversation'

interface VoiceConversationPanelProps {
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
  const panelRef = useRef<HTMLElement>(null)
  const dragRef = useRef<null | { pointerId: number; offsetX: number; offsetY: number }>(null)
  const [position, setPosition] = useState<null | { x: number; y: number }>(null)

  const movePanel = useCallback((x: number, y: number) => {
    const rect = panelRef.current?.getBoundingClientRect()

    if (!rect) {
      return
    }

    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    })
  }, [])

  useEffect(() => {
    const keepVisible = () => {
      const rect = panelRef.current?.getBoundingClientRect()

      if (rect) {
        movePanel(rect.left, rect.top)
      }
    }

    window.addEventListener('resize', keepVisible)

    return () => window.removeEventListener('resize', keepVisible)
  }, [movePanel])

  // Expanding subtitles can make a moved panel taller; keep the controls visible.
  useEffect(() => {
    if (position) {
      movePanel(position.x, position.y)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clamp on expansion, not on each drag paint
  }, [expanded, movePanel])

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
      className={`fixed ${position ? '' : 'left-1/2 top-14 -translate-x-1/2'} z-40 w-[min(32rem,calc(100vw-2rem))] rounded-3xl border border-(--stroke-nous) bg-(--ui-bg-elevated) p-3 shadow-nous`}
      data-voice-conversation-panel=""
      ref={panelRef}
      style={position ? { left: position.x, top: position.y } : undefined}
    >
      <div className="flex items-center gap-2">
        <div
          aria-label={c.moveVoicePanel}
          className="flex min-w-0 flex-1 cursor-grab select-none items-center gap-2 active:cursor-grabbing"
          onKeyDown={event => {
            const steps: Record<string, [number, number]> = {
              ArrowLeft: [-16, 0],
              ArrowRight: [16, 0],
              ArrowUp: [0, -16],
              ArrowDown: [0, 16]
            }

            const delta = steps[event.key]
            const rect = panelRef.current?.getBoundingClientRect()

            if (!delta || !rect) {
              return
            }

            event.preventDefault()
            movePanel(rect.left + delta[0], rect.top + delta[1])
          }}
          onPointerCancel={() => {
            dragRef.current = null
          }}
          onPointerDown={event => {
            if (event.button !== 0) {
              return
            }

            const rect = panelRef.current?.getBoundingClientRect()

            if (!rect) {
              return
            }

            dragRef.current = {
              pointerId: event.pointerId,
              offsetX: event.clientX - rect.left,
              offsetY: event.clientY - rect.top
            }
            event.currentTarget.setPointerCapture?.(event.pointerId)
          }}
          onPointerMove={event => {
            const drag = dragRef.current

            if (drag?.pointerId === event.pointerId) {
              movePanel(event.clientX - drag.offsetX, event.clientY - drag.offsetY)
            }
          }}
          onPointerUp={event => {
            if (dragRef.current?.pointerId !== event.pointerId) {
              return
            }

            dragRef.current = null

            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          }}
          role="group"
          style={{ touchAction: 'none' }}
          tabIndex={0}
          title={c.moveVoicePanel}
        >
          <span
            aria-hidden="true"
            className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
          >
            <Codicon name="mic" size="1.25rem" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{c.voiceControls}</p>
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
          {muted ? <MicOff className={iconSize.md} /> : <Codicon name="mic" size="1rem" />}
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
