import { atom } from 'nanostores'

// This window's acknowledged writes invalidate server reads; no tenant payload is cached here.
export const $workflowDomainRevision = atom(0)

export function workflowDomainChanged(): void {
  $workflowDomainRevision.set($workflowDomainRevision.get() + 1)
}
