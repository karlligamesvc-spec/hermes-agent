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

export function workflowWindowIsViewed(ownerDocument: Document = document): boolean {
  return ownerDocument.visibilityState === 'visible' && ownerDocument.hasFocus()
}

export function workflowDomainChanged(): void {
  invalidate()
  workflowChannel()?.postMessage(1)
}

onMount($workflowDomainRevision, () => {
  // Delayed deactivation can outlive both globals and methods on the mounting realm.
  const ownerWindow = window
  const ownerDocument = document
  const clearPollingInterval = ownerWindow.clearInterval.bind(ownerWindow)
  const removeWindowListener = ownerWindow.removeEventListener.bind(ownerWindow)
  const removeDocumentListener = ownerDocument.removeEventListener.bind(ownerDocument)
  const isViewed = () => workflowWindowIsViewed(ownerDocument)
  let timer: number | null = null
  let wasViewed = isViewed()
  let pendingExternalChange = false
  const bus = workflowChannel()
  const removeBusListener = bus?.removeEventListener.bind(bus)

  const stop = () => {
    if (timer !== null) {clearPollingInterval(timer); timer = null}
  }

  const schedule = () => {
    stop()

    if (isViewed()) {
      timer = ownerWindow.setInterval(() => invalidate(false), WORKFLOW_DOMAIN_POLL_INTERVAL_MS)
    }
  }

  const sync = () => {
    const viewed = isViewed()

    if (viewed && (!wasViewed || pendingExternalChange)) {
      pendingExternalChange = false
      invalidate()
    }

    wasViewed = viewed
    schedule()
  }

  const changed = (event: MessageEvent) => {
    if (event.data !== 1) {return}

    if (isViewed()) {invalidate()} else {pendingExternalChange = true}
  }

  bus?.addEventListener('message', changed)
  ownerWindow.addEventListener('focus', sync)
  ownerWindow.addEventListener('blur', sync)
  ownerDocument.addEventListener('visibilitychange', sync)
  schedule()

  return () => {
    stop()
    removeBusListener?.('message', changed)
    removeWindowListener('focus', sync)
    removeWindowListener('blur', sync)
    removeDocumentListener('visibilitychange', sync)
  }
})
