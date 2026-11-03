import { useStore } from '@nanostores/react'

import { $hudMode } from '@/store/hud'
import { $singleThreadMode } from '@/store/single-thread'

import { useComposerScope } from './scope'

/**
 * hc-1060: is this the composer prototype v2 draws — the main chat's composer
 * in single-thread product mode? The HUD bar and session tiles keep theirs, and
 * so does every composer with the switch off or in developer mode.
 */
export function useSingleThreadComposer(): boolean {
  const singleThread = useStore($singleThreadMode)
  const hudMode = useStore($hudMode)
  const scope = useComposerScope()

  return singleThread && !hudMode && scope.target === 'main'
}
