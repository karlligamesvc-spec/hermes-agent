import { atom, computed, onMount } from 'nanostores'

import { $authState } from '@/store/auth'

export const WORKFLOW_DOMAIN_POLL_INTERVAL_MS = 15_000
const CHANNEL = 'apex:workflow-domain'
let channel: BroadcastChannel | null = null
let urgentRevision = 0

// Only invalidation signals cross windows. Every window reads its own authorized HTTP data.
export const $workflowDomainRevision = atom(0)
export const $workflowDomainAccountScope = computed($authState, auth =>
  auth.enabled === false ? 'device' : `account:${auth.enabled ?? 'checking'}:${auth.status}:${auth.accountId ?? ''}`
)

export function workflowDomainUrgentRevision(): number {return urgentRevision}

function invalidate(urgent = true): void {
  if (urgent) {urgentRevision += 1}
  $workflowDomainRevision.set($workflowDomainRevision.get() + 1)
}

function workflowChannel(): BroadcastChannel | null {
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL)
  }

  return channel
}

export function workflowWindowIsViewed(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

export function workflowDomainChanged(): void {
  invalidate()
  workflowChannel()?.postMessage(1)
}

onMount($workflowDomainRevision, () => {
  let timer: number | null = null
  let wasViewed = workflowWindowIsViewed()
  let pendingExternalChange = false
  const bus = workflowChannel()

  const stop = () => {
    if (timer !== null) {window.clearInterval(timer); timer = null}
  }

  const schedule = () => {
    stop()

    if (workflowWindowIsViewed()) {
      timer = window.setInterval(() => invalidate(false), WORKFLOW_DOMAIN_POLL_INTERVAL_MS)
    }
  }

  const sync = () => {
    const viewed = workflowWindowIsViewed()

    if (viewed && (!wasViewed || pendingExternalChange)) {
      pendingExternalChange = false
      invalidate()
    }

    wasViewed = viewed
    schedule()
  }

  const changed = (event: MessageEvent) => {
    if (event.data !== 1) {return}

    if (workflowWindowIsViewed()) {invalidate()} else {pendingExternalChange = true}
  }

  bus?.addEventListener('message', changed)
  window.addEventListener('focus', sync)
  window.addEventListener('blur', sync)
  document.addEventListener('visibilitychange', sync)
  schedule()

  return () => {
    stop()
    bus?.removeEventListener('message', changed)
    window.removeEventListener('focus', sync)
    window.removeEventListener('blur', sync)
    document.removeEventListener('visibilitychange', sync)
  }
})
