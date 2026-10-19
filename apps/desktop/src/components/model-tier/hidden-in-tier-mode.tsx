import type { ReactNode } from 'react'

import { useModelTierMode } from '@/store/model-tiers'

/**
 * Renders its children only when the window is NOT in tier mode (hc-960).
 *
 * The way to drop a model control (a model field, a usage-by-model list) from
 * an APEX account inside a large host component: the decision lives here, so
 * the host gains no branch and every such control is gated the same way.
 */
export function HiddenInModelTierMode({ children }: { children: ReactNode }) {
  return useModelTierMode() ? null : children
}
