/**
 * hc-1146 冷切换要等 30 秒: with several assistants on, the assistant to ask
 * first who owns a stored session — the one whose thread it is, as this window
 * holds it ($mainThreadsByProfile) — but only while asking it starts nothing:
 * a switch is starting its engine right now, or its socket is open.
 *
 * A switch opens the clicked assistant's thread at once (hc-1146), so the
 * conversation's resume looks a stored id up that no cached row names an owner
 * for, while the assistant being left is still the active one. The by-id lookup
 * across profiles (resolveStoredSession) asked every other profile in turn, each
 * on that profile's own engine, which a cold one has to start first: a third
 * assistant's engine, queued behind the pool's two background slots, held the
 * conversation for the 30 s slot wait before the assistant clicked was asked.
 * Asked first, that assistant's lookup joins the switch's own start instead.
 *
 * Not while the owner's engine is not being started: asked first then, the
 * lookup would itself start it in the background, ahead of the switch that is
 * still queued behind another one. With a single engine slot that switch can be
 * refused (every engine working), and the lookup would then hold the resume
 * that, on its way back to the assistant still answering, has to move first.
 *
 * Null with one assistant, in developer mode, for any stored id that is no
 * assistant's thread, and for an owner nothing is starting: the lookup keeps its
 * order there.
 */

import { openSecondaryCount } from './gateway'
import { $gatewaySwapTarget, normalizeProfileKey } from './profile'
import { isMultiBotMode } from './single-thread-bots'
import { profileOfThreadStoredId } from './single-thread-presence'

function engineStartingOrUp(profile: string): boolean {
  const switchingTo = $gatewaySwapTarget.get()

  return (switchingTo !== null && normalizeProfileKey(switchingTo) === profile) || openSecondaryCount(profile) > 0
}

export function threadOwnerToAskFirst(storedSessionId: string): null | string {
  const owner = isMultiBotMode() ? profileOfThreadStoredId(storedSessionId) : null

  return owner && engineStartingOrUp(owner) ? owner : null
}
