/**
 * hc-1186: an OS notification when a scheduled job's result has come back into its chat.
 *
 * The engine broadcasts `cron.changed` with `apex_cron_result` once the `cron_result` row exists
 * (apex_overlay/cron_desktop_delivery.py). One notification per run, recurring jobs included, only while the
 * user is away from APEX (`global`); clicking it opens that chat (`sessionId` is the chat's stored id, which
 * the notification click hands to `openSession`). Failures notify too, under their own title.
 */

import { cronResultCopyNow } from '@/i18n/cron-results'

import { dispatchNativeNotification } from './native-notifications'

export const CRON_RESULT_PAYLOAD_KEY = 'apex_cron_result'

export interface CronResultBroadcast {
  session_id: string
  job_id: string
  job_name: string
  status: 'failed' | 'ok'
  delivery_id: string
  profile?: string
}

export function cronResultBroadcast(payload: unknown): CronResultBroadcast | undefined {
  const value =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[CRON_RESULT_PAYLOAD_KEY] : null

  if (!value || typeof value !== 'object') {
    return undefined
  }

  const result = value as Partial<CronResultBroadcast>

  return typeof result.session_id === 'string' && result.session_id && typeof result.delivery_id === 'string'
    ? (result as CronResultBroadcast)
    : undefined
}

export function notifyCronResult(result: CronResultBroadcast): boolean {
  const copy = cronResultCopyNow()
  const failed = result.status === 'failed'

  return dispatchNativeNotification({
    kind: failed ? 'turnError' : 'backgroundDone',
    title: failed ? copy.notifyFailed : copy.notifyDone,
    body: result.job_name || result.job_id,
    sessionId: result.session_id,
    global: true,
    tag: `cron-result:${result.delivery_id}:${result.status}`
  })
}
