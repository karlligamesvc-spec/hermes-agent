import { atom } from 'nanostores'

import { persistBoolean, readKey } from '@/lib/storage'

// v1 defaulted to expanded and eagerly persisted that fallback, so an existing
// `false` cannot tell us whether the user chose it or merely launched the app.
// Move the preference to a versioned key so this release can make collapsed
// the product default once; later user toggles remain durable on v2.
export const REASONING_COLLAPSED_BY_DEFAULT_STORAGE_KEY = 'hermes.desktop.reasoning.collapsedByDefault.v2'

export function reasoningCollapsedByDefault(read: (key: string) => null | string = readKey): boolean {
  const stored = read(REASONING_COLLAPSED_BY_DEFAULT_STORAGE_KEY)

  return stored === null ? true : stored === 'true'
}

/** Desktop-local presentation preference; shared backend config must not be changed by a single window. */
export const $reasoningCollapsedByDefault = atom(reasoningCollapsedByDefault())

$reasoningCollapsedByDefault.subscribe(value => persistBoolean(REASONING_COLLAPSED_BY_DEFAULT_STORAGE_KEY, value))

export function setReasoningCollapsedByDefault(value: boolean) {
  $reasoningCollapsedByDefault.set(value)
}
