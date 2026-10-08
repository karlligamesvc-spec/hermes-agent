import { atom } from 'nanostores'

export interface VoiceSessionOwner {
  sessionId: string
  storedSessionId: string
}

// Floating calls remain consumers even when their chat is offscreen. Each
// composer owns a token, so a stale close cannot release a newer call's owner.
export const $voiceSessionOwners = atom<ReadonlyMap<symbol, VoiceSessionOwner>>(new Map())

export function setVoiceSessionOwner(token: symbol, owner: VoiceSessionOwner | null) {
  const owners = new Map($voiceSessionOwners.get())

  if (owner) {
    owners.set(token, owner)
  } else {
    owners.delete(token)
  }

  $voiceSessionOwners.set(owners)
}

export function hasVoiceSessionOwner(sessionId: string, storedSessionId?: string | null): boolean {
  return [...$voiceSessionOwners.get().values()].some(owner =>
    owner.sessionId === sessionId || Boolean(storedSessionId && owner.storedSessionId === storedSessionId)
  )
}
