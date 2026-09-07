import type { WorkflowDomainBridge } from './types'

/** The renderer receives only typed operations; credentials stay in Electron. */
export function workflowDomainBridge(): null | WorkflowDomainBridge {
  return (window.hermesDesktop?.workflowDomain as WorkflowDomainBridge | undefined) ?? null
}
