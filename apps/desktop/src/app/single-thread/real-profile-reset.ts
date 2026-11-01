/**
 * hc-1132: switch `browser.use_real_profile` off once for whoever said yes to the
 * old consent dialog. That dialog promised sites in the panel would be signed in
 * and that nothing would leave the computer, neither of which held, and product
 * mode has no plain way back to the switch. The engine deletes the copied profile
 * the next time a browser tool runs with the setting off, so nothing here touches
 * files.
 *
 * What it does, per profile (the dialog wrote to whichever assistant was on screen):
 * - off: settled. Nothing to undo, and any later "on" is somebody's own choice.
 * - on, in product mode: PUT it off, then settled.
 * - on, in developer mode: left alone and asked again, so it goes off once if that
 *   person later lands in product mode with it still on.
 *
 * Settled profiles are never read again, and once all are settled nothing runs on
 * this install any more. That is what keeps someone who turns it on by hand in
 * developer mode from being switched back, now or on any later launch.
 *
 * With the single-thread switch off nothing runs at all: no reads, no ledger. A
 * failed read or write settles nothing, so the next launch tries again. A remote
 * gateway's config is not this install's, so it is left alone too. The ledger lives
 * in this window's storage and config.yaml is the only other thing written; rolling
 * the app back leaves the setting off.
 */

import { invalidateHermesConfig } from '@/app/hooks/use-config-record'
import { readUseRealProfile } from '@/app/settings/browser-real-profile-panel'
import { getHermesConfigRecord, getProfiles, saveHermesConfigRecord } from '@/hermes'
import { readJson, writeJson } from '@/lib/storage'
import { $connection, $gatewayState } from '@/store/session'
import { $singleThreadFlag, $singleThreadMode } from '@/store/single-thread'
import { isAuxiliaryWindow, isPeerInstanceWindow, isWatchWindow } from '@/store/windows'

export const REAL_PROFILE_RESET_KEY = 'apex.desktop.real-profile-reset.v1'

interface ResetLedger {
  complete: boolean
  settled: string[]
}

function readLedger(): ResetLedger {
  const stored = readJson<Partial<ResetLedger>>(REAL_PROFILE_RESET_KEY)

  return {
    complete: stored?.complete === true,
    settled: Array.isArray(stored?.settled) ? stored.settled.filter(name => typeof name === 'string') : []
  }
}

async function settleProfiles(): Promise<void> {
  const { profiles } = await getProfiles()

  if (!profiles?.length) {
    return
  }

  const settled = new Set(readLedger().settled)
  let waiting = false
  let changed = false

  for (const profile of profiles) {
    if (settled.has(profile.name)) {
      continue
    }

    // Null is the primary backend's own profile; the primary serves the others through ?profile=.
    const scope = profile.is_default ? null : profile.name

    try {
      if (readUseRealProfile(await getHermesConfigRecord(scope, { includeDefaults: false }))) {
        if (!$singleThreadMode.get()) {
          waiting = true

          continue
        }

        await saveHermesConfigRecord({ browser: { use_real_profile: false } }, scope)
        changed = true
      }

      settled.add(profile.name)
    } catch {
      waiting = true
    }
  }

  writeJson(REAL_PROFILE_RESET_KEY, { complete: !waiting, settled: [...settled] })

  if (changed) {
    void invalidateHermesConfig()
  }
}

let running = false
let runAgain = false

function settleIfDue(): void {
  if ($gatewayState.get() !== 'open' || !$singleThreadFlag.get() || $connection.get()?.mode === 'remote') {
    return
  }

  if (readLedger().complete) {
    return
  }

  if (running) {
    runAgain = true

    return
  }

  running = true

  void settleProfiles()
    .catch(() => undefined)
    .finally(() => {
      running = false

      if (runAgain) {
        runAgain = false
        settleIfDue()
      }
    })
}

/** Primary window only: a pop-out or HUD renderer has its own stores and must not run this a second time. */
export function watchRealProfileReset(): () => void {
  if (isAuxiliaryWindow() || isWatchWindow() || isPeerInstanceWindow()) {
    return () => undefined
  }

  const stopGateway = $gatewayState.listen(settleIfDue)
  const stopFlag = $singleThreadFlag.listen(settleIfDue)
  const stopMode = $singleThreadMode.listen(settleIfDue)

  settleIfDue()

  return () => {
    stopGateway()
    stopFlag()
    stopMode()
  }
}
