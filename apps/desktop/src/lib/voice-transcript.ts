import type { LiveTranscriptFragment } from './voice-live'

/** Keep late ASR in its spoken turn, with stable ordering for streaming deltas.
 * Legacy timestamped fragments retain their existing chronology. */
export function appendVoiceTranscript(
  current: LiveTranscriptFragment[], fragment: LiveTranscriptFragment, limit: number
): LiveTranscriptFragment[] {
  return [...current, fragment]
    .sort((a, b) => (a.turnOrder ?? a.startMs) - (b.turnOrder ?? b.startMs))
    .slice(-limit)
}
