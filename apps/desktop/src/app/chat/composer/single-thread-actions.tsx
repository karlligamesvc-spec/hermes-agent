import './single-thread-composer.css'

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { type ComponentProps, type PointerEvent, type RefObject, useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { Tip, TipKeybindLabel } from '@/components/ui/tooltip'
import { registry } from '@/contrib/registry'
import { useI18n } from '@/i18n'
import { useSingleThreadComposerCopy } from '@/i18n/single-thread-composer'
import { triggerHaptic } from '@/lib/haptics'
import { ArrowUp, iconSize, Loader2, Mic, Square } from '@/lib/icons'
import { type KeybindContribution, KEYBINDS_AREA } from '@/lib/keybinds/actions'
import { cn } from '@/lib/utils'
import { $wakeWord } from '@/store/wake-word'

import { ComposerControls as DefaultComposerControls } from './controls'
import { ModelPill } from './model-pill'
import { ReasoningPill } from './reasoning-pill'
import { useSingleThreadComposer } from './single-thread-gate'
import type { ChatBarState, VoiceStatus } from './types'
import { VoiceConversationPanel } from './voice-conversation-panel'
import { VoiceMenu } from './voice-menu'

/**
 * hc-1060 G4: the composer's trailing controls as 「APEX 极简助手原型 v2」 draws
 * them, in single-thread product mode only (Kael 2026-10-26, N5–N7):
 *
 * - the dictation mic is back beside the input — tap to start and tap again,
 *   or hold it, talk and let go — and ⌘D does the same;
 * - one round button at the end: the voice conversation while the input is
 *   empty, Send once there is something to send;
 * - no Stop here. While APEX works the input keeps taking messages (they reach
 *   the running turn through the existing steer-or-queue path); stopping lives
 *   on the activity line (SingleThreadStopButton), plus Esc and 「停一下」.
 *
 * ChatBar imports `ComposerControls` from this module, so every other composer
 * — the switch off, developer mode, the HUD bar, session tiles — renders the
 * default controls unchanged.
 */
export function ComposerControls(props: ComponentProps<typeof DefaultComposerControls>) {
  return useSingleThreadComposer() ? <SingleThreadComposerActions {...props} /> : <DefaultComposerControls {...props} />
}

/** The shortcut-table id of single-thread dictation (⌘D). */
export const DICTATE_ACTION = 'composer.dictate'

/** A press at least this long is push-to-talk: letting go stops the recording. */
export const DICTATION_HOLD_MS = 350

function SingleThreadComposerActions({
  autoSpeak,
  canSubmit,
  compactModelPill = false,
  conversation,
  disabled,
  hasComposerPayload,
  hideModelPill = false,
  minimal = false,
  state,
  voiceStatus,
  onDictate,
  onToggleAutoSpeak
}: ComponentProps<typeof DefaultComposerControls>) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const wake = useStore($wakeWord)
  const quiet = minimal || conversation.active

  useDictateShortcut(onDictate, rootRef)

  return (
    <div
      className="ml-auto flex min-w-0 shrink items-center gap-(--composer-control-gap)"
      data-single-thread-composer=""
      ref={rootRef}
    >
      {conversation.active && <VoiceConversationPanel {...conversation} />}
      {minimal || hideModelPill ? null : (
        <>
          <ModelPill compact={compactModelPill} disabled={disabled} model={state.model} />
          {compactModelPill ? null : <ReasoningPill disabled={disabled} model={state.model} />}
        </>
      )}
      {/* The wake word is listening: its menu stays in sight, as in the default row. */}
      {wake.listening && !quiet && (
        <VoiceMenu
          autoSpeak={autoSpeak}
          disabled={disabled}
          onDictate={onDictate}
          onStartConversation={conversation.onStart}
          onToggleAutoSpeak={onToggleAutoSpeak}
          settingsTrigger={false}
          state={state}
          voiceStatus={voiceStatus}
        />
      )}
      {quiet ? null : (
        <DictationMic disabled={disabled} onDictate={onDictate} state={state.voice} status={voiceStatus} />
      )}
      {/* While a conversation runs, its panel carries the hang-up. */}
      {hasComposerPayload ? (
        <SendButton disabled={disabled || !canSubmit} />
      ) : conversation.active ? null : (
        <VoiceButton disabled={disabled} onStart={conversation.onStart} />
      )}
    </div>
  )
}

const ROUND_BUTTON =
  'size-10 shrink-0 rounded-full p-0 bg-(--single-thread-accent) text-white hover:bg-(--single-thread-accent-hover) disabled:opacity-50'

function SendButton({ disabled }: { disabled: boolean }) {
  const { t } = useI18n()

  return (
    <Tip label={<TipKeybindLabel actionId="composer.send" text={t.composer.send} />}>
      <Button
        aria-label={t.composer.send}
        className={ROUND_BUTTON}
        data-single-thread-round="send"
        disabled={disabled}
        type="submit"
      >
        <ArrowUp className={iconSize.lg} stroke={2.2} />
      </Button>
    </Tip>
  )
}

/** Empty input: the voice conversation. */
function VoiceButton({ disabled, onStart }: { disabled: boolean; onStart: () => void }) {
  const { t } = useI18n()

  return (
    <Tip label={t.composer.startVoice}>
      <Button
        aria-label={t.composer.startVoice}
        className={ROUND_BUTTON}
        data-single-thread-round="voice"
        disabled={disabled}
        onClick={() => {
          triggerHaptic('open')
          onStart()
        }}
        type="button"
      >
        <WaveformGlyph />
      </Button>
    </Tip>
  )
}

/** The prototype's five-bar waveform. */
function WaveformGlyph() {
  return (
    <svg
      aria-hidden="true"
      className={iconSize.lg}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth={2.2}
      viewBox="0 0 24 24"
    >
      <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
    </svg>
  )
}

/**
 * Dictation into the input. A tap starts it and the next tap stops it; a press
 * held past {@link DICTATION_HOLD_MS} stops it when let go. Keyboard activation
 * (Enter / Space) taps.
 */
function DictationMic({
  disabled,
  onDictate,
  state,
  status
}: {
  disabled: boolean
  onDictate: () => void
  state: ChatBarState['voice']
  status: VoiceStatus
}) {
  const { t } = useI18n()
  const copy = useSingleThreadComposerCopy()
  const pressRef = useRef<null | { at: number; started: boolean }>(null)
  const recording = status === 'recording'
  const transcribing = status === 'transcribing'
  const label = recording ? t.composer.stopDictation : transcribing ? t.composer.transcribingDictation : copy.dictate

  const press = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return
    }

    event.currentTarget.setPointerCapture?.(event.pointerId)
    pressRef.current = { at: Date.now(), started: !recording }
    triggerHaptic(recording ? 'close' : 'open')
    onDictate()
  }

  const release = () => {
    const held = pressRef.current

    pressRef.current = null

    if (held?.started && Date.now() - held.at >= DICTATION_HOLD_MS) {
      triggerHaptic('close')
      onDictate()
    }
  }

  return (
    <Tip label={<TipKeybindLabel actionId={DICTATE_ACTION} text={label} />}>
      <Button
        aria-label={label}
        aria-pressed={recording}
        className={cn(
          'size-9 shrink-0 rounded-[10px] p-0 text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground',
          recording && 'bg-(--single-thread-accent-soft) text-(--single-thread-accent)'
        )}
        data-single-thread-dictate={status}
        disabled={disabled || !state.enabled || transcribing}
        onClick={event => {
          // A pointer press already acted on pointerdown; detail 0 is the keyboard.
          if (event.detail === 0) {
            onDictate()
          }
        }}
        onPointerCancel={release}
        onPointerDown={press}
        onPointerUp={release}
        size="icon"
        type="button"
        variant="ghost"
      >
        {recording ? (
          <Square className={cn('fill-current', iconSize.xs)} />
        ) : transcribing ? (
          <Loader2 className={cn('animate-spin', iconSize.md)} />
        ) : (
          <Mic className={iconSize.lg} stroke={1.9} />
        )}
      </Button>
    </Tip>
  )
}

/** ⌘D pressed: the mounted single-thread composer takes it. */
const $dictateRequests = atom(0)

function requestDictation() {
  $dictateRequests.set($dictateRequests.get() + 1)
}

/**
 * ⌘D dictates while the single-thread composer is mounted. The row claims the
 * combo (see `KeybindContribution.claims`), so the default-profile switch that
 * owns ⌘D everywhere else yields only here: one person, one assistant, nothing
 * to switch to. Unmounting the row hands ⌘D back. A press while the composer
 * is hidden (another page is open) does nothing.
 */
function useDictateShortcut(onDictate: () => void, rootRef: RefObject<HTMLDivElement | null>) {
  const label = useSingleThreadComposerCopy().dictate

  useEffect(
    () =>
      $dictateRequests.listen(() => {
        const root = rootRef.current

        if (root?.isConnected && !root.closest('[hidden]')) {
          onDictate()
        }
      }),
    [onDictate, rootRef]
  )

  useEffect(
    () =>
      registry.register({
        area: KEYBINDS_AREA,
        id: DICTATE_ACTION,
        data: {
          category: 'composer',
          claims: true,
          defaults: ['mod+d'],
          id: DICTATE_ACTION,
          label,
          run: requestDictation
        } satisfies KeybindContribution
      }),
    [label]
  )
}
