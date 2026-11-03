import { ErrorPrimitive, useAuiState } from '@assistant-ui/react'
import type { FC } from 'react'

import { useSingleThreadUpstreamCopy } from '@/i18n/single-thread-upstream-copy'
import type { ErrorSurface } from '@/lib/error-surface'
import { useSingleThreadMode } from '@/store/single-thread'

const BODY_CLASS = 'mt-0.5 block min-w-0 text-(--ui-text-secondary)'
const SERVICE_SAID_MAX = 200

/**
 * The service's own words in an engine failure text: the line after
 * "Provider said:" (agent/turn_failure_copy.py), first line only. The APEX
 * relay writes these in the user's language; nothing else in the text is kept.
 */
export function serviceSaid(errorText: string): null | string {
  const words = /(?:^|\n)Provider said:[ \t]*([^\n]+)/.exec(errorText)?.[1]?.trim()

  if (!words) {
    return null
  }

  return words.length > SERVICE_SAID_MAX ? `${words.slice(0, SERVICE_SAID_MAX - 1)}…` : words
}

/**
 * hc-1116: the error card's body. In single-thread product mode it says what
 * happened in APEX's words, by the layer that failed, instead of the engine's
 * English (which names /model, /retry and `hermes` commands); the service's own
 * words stay under it, and the full text stays in 「复制错误详情」. Developer
 * mode and single-thread off render the engine's text exactly as before.
 */
export const AssistantErrorMessage: FC = () => {
  const singleThread = useSingleThreadMode()
  const copy = useSingleThreadUpstreamCopy()
  const surface = useAuiState(s => s.message.metadata?.custom?.errorSurface as ErrorSurface | undefined)

  const errorText = useAuiState(s => {
    const status = s.message.status as { error?: unknown; type?: string } | undefined

    return status?.type === 'incomplete' && typeof status.error === 'string' ? status.error : ''
  })

  if (!singleThread) {
    return <ErrorPrimitive.Message className={BODY_CLASS} />
  }

  const words = serviceSaid(errorText)

  return (
    <span className={BODY_CLASS} data-slot="aui_error-body">
      {(surface && copy.errorBody[surface.layer]) || copy.errorBody.generic}
      {words && (
        <span className="mt-1 block text-(--ui-text-tertiary)" data-slot="aui_error-service-said">
          {copy.serviceSaid}
          {words}
        </span>
      )}
    </span>
  )
}
