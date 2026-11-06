/**
 * hc-1166 多助手单引擎: whose an engine event or request is while one engine
 * serves every assistant.
 *
 * Every event and server request then arrives on the primary socket tagged
 * with the primary's profile (APEX), whichever assistant's session it is for.
 * The session says whose it is: the assistant whose thread holds its stored
 * id, else the assistant a relay turn runs for. A broadcast that can concern
 * whichever assistant is on screen (the session lists moved, an IM pairing,
 * the engine came back) is that assistant's; the engine's other broadcasts
 * watch APEX's own home and keep their tag.
 *
 * Off (an engine per assistant) the tag is the answer, exactly as before.
 */

import { $activeGatewayProfile } from './profile'
import { storedSessionIdForRuntimeId } from './session-states'
import { $singleEngineFlag } from './single-engine'
import { $handoffs } from './single-thread-handoff'
import { profileOfThreadStoredId } from './single-thread-presence'

/** Change-watcher and boot broadcasts about every assistant's stores, not APEX's home alone. */
const ON_SCREEN_BROADCASTS = new Set(['pairing.changed', 'sessions.changed', 'setup.ready'])

/** The assistant a runtime session belongs to, as far as this window knows; null when it does not. */
export function sessionOwnerProfile(runtimeSessionId: null | string | undefined): null | string {
  if (!runtimeSessionId) {
    return null
  }

  return (
    profileOfThreadStoredId(storedSessionIdForRuntimeId(runtimeSessionId)) ??
    $handoffs.get().find(record => record.turn?.runtimeSessionId === runtimeSessionId)?.to ??
    null
  )
}

/**
 * The profile an event or server request from the engine is for: its tag with
 * an engine per assistant; with one engine, the owner of its session, the
 * assistant on screen for a broadcast about every assistant, else the tag.
 */
export function engineEventProfile<T extends null | string | undefined>(
  tagged: T,
  runtimeSessionId?: null | string,
  type?: string
): string | T {
  if (!$singleEngineFlag.get()) {
    return tagged
  }

  if (!runtimeSessionId && type && ON_SCREEN_BROADCASTS.has(type)) {
    return $activeGatewayProfile.get()
  }

  return sessionOwnerProfile(runtimeSessionId) ?? tagged
}
