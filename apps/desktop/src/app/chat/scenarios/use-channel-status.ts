import { useEffect, useState } from 'react'

// hc-554 显化 — "渠道 · 分身在哪" reads the same local binding state the settings
// cards already trust (no new network): imEntry.list() for the IM channels
// (bound = a local binding row exists) and daemon.status() for the phone-remote
// (/cc) leg. Every bridge is optional (absent on an older main / web build); an
// absent bridge yields available:false so the UI shows a guide state (or hides).

export interface ChannelLeg {
  /** The bridge exists in this build. */
  available: boolean
  /** A local binding / the leg is live. */
  bound: boolean
}

export interface ChannelStatus {
  feishu: ChannelLeg
  phoneRemote: ChannelLeg
  weixin: ChannelLeg
}

const UNAVAILABLE: ChannelLeg = { available: false, bound: false }

const INITIAL: ChannelStatus = {
  feishu: UNAVAILABLE,
  weixin: UNAVAILABLE,
  phoneRemote: UNAVAILABLE
}

/** Live-ish channel binding state for the manifestation surfaces. One-shot read
 *  on mount plus the daemon's push subscription — mirrors the settings cards. */
export function useChannelStatus(): ChannelStatus {
  const [status, setStatus] = useState<ChannelStatus>(INITIAL)

  useEffect(() => {
    const desktop = typeof window !== 'undefined' ? window.hermesDesktop : undefined
    let cancelled = false

    const imBridge = desktop?.imEntry
    const daemonBridge = desktop?.daemon

    if (imBridge?.list) {
      void imBridge
        .list()
        .then(result => {
          if (cancelled) {
            return
          }

          const ids = new Set((result?.channels ?? []).map(channel => channel.channelId))

          setStatus(prev => ({
            ...prev,
            feishu: { available: true, bound: ids.has('feishu') },
            weixin: { available: true, bound: ids.has('weixin') }
          }))
        })
        .catch(() => undefined)
    }

    const applyDaemon = (snapshot: { enabled?: boolean; status?: string } | null | undefined) => {
      if (cancelled || !snapshot) {
        return
      }

      setStatus(prev => ({
        ...prev,
        phoneRemote: {
          available: true,
          bound: snapshot.status === 'online' || Boolean(snapshot.enabled)
        }
      }))
    }

    if (daemonBridge?.status) {
      void daemonBridge.status().then(applyDaemon).catch(() => undefined)
    }

    const unsubscribe = daemonBridge?.onStatus?.(applyDaemon)

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  return status
}
