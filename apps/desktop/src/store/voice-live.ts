import { atom } from 'nanostores'

import { getApiRequestConnection, getApiRequestProfile } from '@/api/client'
import { fetchVoiceLiveStatus, type VoiceChatMode, type VoiceLiveStatus } from '@/lib/voice-live'
import { activeGateway } from '@/store/gateway'

/** Profile-scoped Runtime voice admission. Desktop uses qwenAvailable for its
 * fixed native Qwen call; legacy mode fields remain part of Runtime compatibility. */
export const $voiceLiveStatus = atom<null | VoiceLiveStatus>(null)

const currentScope = () => JSON.stringify([getApiRequestConnection(), getApiRequestProfile()])
let inflight: null | { scope: string; promise: Promise<null | VoiceLiveStatus> } = null
let resolvedScope: null | string = null

export async function refreshVoiceLiveStatus(force = false): Promise<null | VoiceLiveStatus> {
  const scope = currentScope()

  if (!force && inflight?.scope === scope) {
    return inflight.promise
  }

  if (resolvedScope !== scope) {
    $voiceLiveStatus.set(null)
  }

  const request = { scope, promise: Promise.resolve<null | VoiceLiveStatus>(null) }
  request.promise = fetchVoiceLiveStatus()
    .then(status => {
      if (inflight === request && currentScope() === scope) {
        resolvedScope = scope
        $voiceLiveStatus.set(status)
      }

      return currentScope() === scope ? status : null
    })
    .finally(() => {
      if (inflight === request) {
        inflight = null
      }
    })
  inflight = request

  return request.promise
}

/** Selected mode. `chained` until the backend answers, or when the backend predates the mode. */
export function selectedVoiceChatMode(status: null | VoiceLiveStatus = $voiceLiveStatus.get()): VoiceChatMode {
  return status?.mode ?? 'chained'
}

/**
 * Persist `voice.voice_chat_mode` on the live gateway (whichever profile/host
 * the app is talking to) and re-read the resolved status, so the menu shows
 * what the backend will actually mount next. Takes effect on the NEXT
 * conversation; an active one keeps its engine.
 */
export async function setVoiceChatMode(mode: VoiceChatMode): Promise<null | VoiceLiveStatus> {
  const gateway = activeGateway()

  if (!gateway) {
    throw new Error('gateway not connected')
  }

  await gateway.request('config.set', { key: 'voice.voice_chat_mode', value: mode })

  return refreshVoiceLiveStatus(true)
}
