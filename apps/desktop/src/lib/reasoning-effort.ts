import { DEFAULT_REASONING_EFFORT, isReasoningEffort, type REASONING_EFFORT_VALUES } from '@hermes/shared'

import { normalize } from '@/lib/text'

/** Compact labels for chrome where space is tight (pill, picker rows). Menus
 *  and settings use the translated `shell.modelOptions` strings instead. */
const SHORT_LABELS: Record<string, string> = {
  none: 'Off',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra'
}

/** Localized compact labels supplied by user-facing chrome. Callers may pass
 *  only the scale entries they render; the English map above remains the
 *  non-UI/SDK fallback. */
export type ReasoningEffortLabels = Partial<Record<(typeof REASONING_EFFORT_VALUES)[number], string>>

export function reasoningEffortLabel(effort: string, labels?: ReasoningEffortLabels): string {
  const key = normalize(effort)

  return key ? (labels?.[key as keyof ReasoningEffortLabels] ?? SHORT_LABELS[key] ?? effort) : ''
}

/** Thinking is on unless a level explicitly says otherwise; an empty value
 *  means "inherit", so it resolves through `fallback` first. */
export const isThinkingEnabled = (effort: string, fallback: string = DEFAULT_REASONING_EFFORT): boolean =>
  normalize(effort || fallback) !== 'none'

/** The level a scale control should show. Empty inherits `fallback`; `none`
 *  (thinking off) selects nothing; anything unrecognized clamps to the default. */
export function resolveReasoningEffort(effort: string, fallback: string = DEFAULT_REASONING_EFFORT): string {
  const value = normalize(effort || fallback)

  if (value === 'none') {
    return ''
  }

  return isReasoningEffort(value) ? value : DEFAULT_REASONING_EFFORT
}
