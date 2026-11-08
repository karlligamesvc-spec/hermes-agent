import { cronResultBroadcast, notifyCronResult } from '@/store/cron-result-notify'

import type { GatewayEventContext } from './types'

/** hc-1186: a scheduled job's result came back into a chat; notify, then let lifecycle refresh the cron list.
 *  Not gated on the active source: the result may be another assistant's, and the notification is global. */
export function handleCronResultEvent(ctx: GatewayEventContext): boolean {
  const result = ctx.event.type === 'cron.changed' ? cronResultBroadcast(ctx.payload) : undefined

  if (result) {
    notifyCronResult(result)
  }

  return false
}
