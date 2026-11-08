/**
 * hc-1186: the `cron_result` row a scheduled job's result comes back as (apex_overlay/cron_desktop_delivery.py).
 *
 * The engine writes it with role "user" (so strict providers accept it between turns) and display metadata
 * {job_id, job_name, status, delivery_id, run_session_id, display_text}. The chat shows a card, never a user
 * bubble: the row is the schedule's, not the user's.
 */

import { cronResultCopyNow } from '@/i18n/cron-results'
import type { SessionMessage } from '@/types/hermes'

export const CRON_RESULT_DISPLAY_KIND = 'cron_result'

export interface CronResult {
  jobName: string
  failed: boolean
  /** The result itself, as the job's run produced it. */
  text: string
  /** The job's own run conversation (`cron_<job>_<time>`), when there is one. */
  runSessionId?: string
}

function metadataObject(metadata: SessionMessage['display_metadata']): null | Record<string, unknown> {
  let parsed: unknown = metadata

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }

  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The card's data for a `cron_result` row; undefined for every other row. */
export function cronResultOf(
  message: Pick<SessionMessage, 'display_kind' | 'display_metadata'>
): CronResult | undefined {
  if (message.display_kind !== CRON_RESULT_DISPLAY_KIND) {
    return undefined
  }

  const meta = metadataObject(message.display_metadata) ?? {}
  const runSessionId = asText(meta.run_session_id)

  return {
    jobName: asText(meta.job_name) || asText(meta.job_id),
    failed: meta.status === 'failed',
    text: asText(meta.display_text),
    ...(runSessionId ? { runSessionId } : {})
  }
}

/** The one-line text the row carries in the transcript (copy, search, previews). */
export function cronResultLabel(result: CronResult): string {
  return cronResultCopyNow().title(result.jobName, result.failed)
}
