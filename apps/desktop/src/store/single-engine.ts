/**
 * hc-1166 多助手单引擎: the renderer's view of the switch main settles at launch
 * (electron/apex-single-engine.ts). On, every local assistant is served by the
 * primary engine: one socket carries every assistant's calls, and each call's
 * `profile` names whose home the engine binds for it.
 *
 * Same rule as main, so the two never disagree: single-thread on, several
 * assistants on, and `multi_bot_single_engine` on (an install switch wins,
 * else only the platform's literal `true`). Like main it does not look at the
 * renderer's developer mode.
 *
 * Off, nothing here changes a route.
 */

import { atom } from 'nanostores'

import type { DesktopClientConfigState } from '@/global'
import { desktopFeatureOn, onLateClientConfig } from '@/lib/desktop-features'

/** `desktop_features` names, as store/single-thread.ts, store/single-thread-bots.ts and main use them. */
export const SINGLE_THREAD_FEATURE_NAME = 'single_thread'
export const MULTI_BOT_FEATURE_NAME = 'multi_bot'
export const SINGLE_ENGINE_FEATURE = 'multi_bot_single_engine'

type ClientConfigLike = null | Pick<DesktopClientConfigState, 'installSwitches' | 'payload'> | undefined

function featureOn(state: ClientConfigLike, name: string): boolean {
  const install = state?.installSwitches?.[name]

  return typeof install === 'boolean' ? install : desktopFeatureOn(state?.payload, name)
}

/** The switch for one cached client-config state. */
export function singleEngineSwitchFrom(state: ClientConfigLike): boolean {
  return (
    featureOn(state, SINGLE_THREAD_FEATURE_NAME) &&
    featureOn(state, MULTI_BOT_FEATURE_NAME) &&
    featureOn(state, SINGLE_ENGINE_FEATURE)
  )
}

export const $singleEngineFlag = atom<boolean>(false)

let reading: null | Promise<boolean> = null

/** Read the switch once per window (a local disk read through main); never throws. */
export function loadSingleEngineFlag(): Promise<boolean> {
  reading ??= (async () => {
    try {
      const state = await window.hermesDesktop?.clientConfig?.get()

      if (state) {
        $singleEngineFlag.set(singleEngineSwitchFrom(state))
      }
    } catch {
      // Keep what is held: a broken bridge is not the platform turning it off.
    }

    return $singleEngineFlag.get()
  })()

  return reading
}

/**
 * The owner a session-less RPC that names a `profile` routes to while every
 * assistant shares one engine: that profile. Undefined otherwise, which keeps
 * the dispatcher's own ladder (the selected conversation's owner).
 *
 * On one shared socket the route also decides the call's scope (a shared
 * route stamps its own profile on the call), so a lookup for APEX's thread sent
 * while the conversation being left is still selected would otherwise be
 * answered as the other assistant's (hc-1166: the switch back to APEX that
 * bounced to the assistant being left).
 */
export function namedProfileRpcOwner(
  sessionId: string | undefined,
  params: Record<string, unknown> | undefined
): string | undefined {
  if (sessionId || !$singleEngineFlag.get()) {
    return undefined
  }

  const named = typeof params?.profile === 'string' ? params.profile.trim() : ''

  return named || undefined
}

/** Tests only. */
export function setSingleEngineFlagForTest(on: boolean): void {
  reading = Promise.resolve(on)
  $singleEngineFlag.set(on)
}

onLateClientConfig(state => {
  reading = Promise.resolve(singleEngineSwitchFrom(state))
  $singleEngineFlag.set(singleEngineSwitchFrom(state))
})
void loadSingleEngineFlag()
