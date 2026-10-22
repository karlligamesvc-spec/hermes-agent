import { atom, computed } from 'nanostores'

import { persistBoolean, storedBoolean } from '@/lib/storage'

import { $singleThreadMode } from './single-thread'

const KEY = 'hermes.desktop.intro-splash.v1'

/** Whether the wordmark + tagline splash renders on an empty chat. */
export const $introSplash = atom(storedBoolean(KEY, true))

$introSplash.subscribe(on => persistBoolean(KEY, on))

export function setIntroSplash(on: boolean) {
  $introSplash.set(on)
}

/** What the empty primary chat honours: the Appearance toggle, and never the
 *  Start page in hc-1014 single-thread product mode (decision 2: open straight
 *  into the conversation; the thread draws its own empty state). */
export const $introSplashShown = computed([$introSplash, $singleThreadMode], (on, singleThread) => on && !singleThread)
