export const BUSINESS_WORKSPACE_FLAG_KEY = 'apex.desktop.feature.business-workspace'

export const BUSINESS_NAV_IDS = ['new-session', 'projects', 'workflows', 'cron', 'artifacts', 'accounts', 'history'] as const

export function isBusinessNavigationContract(ids: readonly string[]): boolean {
  return ids.length === BUSINESS_NAV_IDS.length && ids.every((id, index) => id === BUSINESS_NAV_IDS[index])
}

/** Rollback seam for the hc-685 information architecture. Apex builds default on. */
export function isBusinessWorkspaceEnabled(storage: Pick<Storage, 'getItem'> = window.localStorage): boolean {
  return storage.getItem(BUSINESS_WORKSPACE_FLAG_KEY) !== '0'
}
