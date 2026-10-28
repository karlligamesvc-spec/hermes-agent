/**
 * apex-pool-busy.ts — "every pooled engine is mid-turn" (hc-1080), shared by
 * the main process (which raises it) and the renderer (hc-1077, which words it).
 *
 * With several assistants on, opening one more assistant than the pool holds
 * retires the least recently used engine that has no turn in flight
 * (electron/apex-pool-engines.ts makeRoomInPool). Only when every pooled engine
 * is working does the open fail, at once rather than after the 30 s slot wait,
 * with this result. Electron passes only an Error's message across
 * `ipcRenderer.invoke`, so the result travels in the message:
 * `APEX_POOL_ALL_BUSY {"busy":["writer","editor","maxer"],"limit":3}`.
 */

export const POOL_ALL_BUSY_CODE = 'APEX_POOL_ALL_BUSY'

export interface PoolAllBusy {
  /** Profile names of the pooled engines that are mid-turn, least recently used first. */
  busy: string[]
  /** How many pooled engines the device allows (Settings › Advanced; default 3). */
  limit: number
}

export function poolAllBusyMessage(info: PoolAllBusy): string {
  return `${POOL_ALL_BUSY_CODE} ${JSON.stringify({ busy: info.busy, limit: info.limit })}`
}

/**
 * The result inside an error or message, including Electron's IPC wrapping
 * ("Error invoking remote method 'hermes:connection': Error: APEX_POOL_ALL_BUSY {…}").
 * Null for any other failure.
 */
export function parsePoolAllBusy(error: unknown): null | PoolAllBusy {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const match = text.match(new RegExp(`${POOL_ALL_BUSY_CODE} (\\{.*\\})`))

  if (!match) {
    return null
  }

  try {
    const parsed = JSON.parse(match[1])
    const busy = Array.isArray(parsed?.busy) ? parsed.busy.filter((name: unknown) => typeof name === 'string') : []
    const limit = Number.isInteger(parsed?.limit) && parsed.limit > 0 ? parsed.limit : 0

    return { busy, limit }
  } catch {
    return null
  }
}
