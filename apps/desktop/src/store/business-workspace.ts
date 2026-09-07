import {
  ARTIFACTS_ROUTE,
  ASSISTANT_ROUTE,
  CRON_ROUTE,
  DELIVERABLES_ROUTE,
  HISTORY_ROUTE,
  NEW_CHAT_ROUTE,
  PROJECTS_ROUTE,
  SEARCH_ROUTE,
  SKILLS_ROUTE,
  TASKS_ROUTE,
  WORKFLOWS_ROUTE
} from '@/app/routes'

export const BUSINESS_WORKSPACE_FLAG_KEY = 'apex.desktop.feature.business-workspace'

export interface SidebarNavigationContract {
  id: string
  action?: 'new-session'
  route?: string
  keybindActionId?: string
}

export const BUSINESS_HISTORY_ROUTE = HISTORY_ROUTE

export const BUSINESS_SIDEBAR_NAV_CONTRACT = [
  { id: 'start', action: 'new-session', route: NEW_CHAT_ROUTE, keybindActionId: 'session.new' },
  { id: 'projects', route: PROJECTS_ROUTE },
  { id: 'workflows', route: WORKFLOWS_ROUTE },
  { id: 'scheduled-runs', route: CRON_ROUTE, keybindActionId: 'nav.cron' },
  { id: 'deliverables', route: DELIVERABLES_ROUTE, keybindActionId: 'nav.artifacts' },
  { id: 'assistant', route: ASSISTANT_ROUTE },
  { id: 'history', route: BUSINESS_HISTORY_ROUTE, keybindActionId: 'session.focusSearch' }
] as const satisfies readonly SidebarNavigationContract[]

/** Exact origin/main rollback contract. Keep route/action/keybind fields intact. */
export const LEGACY_SIDEBAR_NAV_CONTRACT = [
  { id: 'new-session', action: 'new-session', keybindActionId: 'session.new' },
  { id: 'search', route: SEARCH_ROUTE, keybindActionId: 'session.focusSearch' },
  { id: 'cron', route: CRON_ROUTE, keybindActionId: 'nav.cron' },
  { id: 'tasks', route: TASKS_ROUTE },
  { id: 'skills', route: SKILLS_ROUTE, keybindActionId: 'nav.skills' },
  { id: 'artifacts', route: ARTIFACTS_ROUTE, keybindActionId: 'nav.artifacts' }
] as const satisfies readonly SidebarNavigationContract[]

export const BUSINESS_NAV_IDS = BUSINESS_SIDEBAR_NAV_CONTRACT.map(item => item.id)

export function isBusinessNavigationContract(ids: readonly string[]): boolean {
  return ids.length === BUSINESS_NAV_IDS.length && ids.every((id, index) => id === BUSINESS_NAV_IDS[index])
}

/** Rollback seam for the hc-685 information architecture. Apex builds default on. */
export function isBusinessWorkspaceEnabled(storage: Pick<Storage, 'getItem'> = window.localStorage): boolean {
  return storage.getItem(BUSINESS_WORKSPACE_FLAG_KEY) !== '0'
}

export function visibleSidebarNavItems<T, U>(
  builtIn: readonly T[],
  contributed: readonly U[],
  businessMode: boolean
): (T | U)[] {
  return businessMode ? [...builtIn] : [...builtIn, ...contributed]
}

export function activateSidebarNavigation(
  item: SidebarNavigationContract,
  navigate: (route: string) => void,
  startFreshSession: () => void
): void {
  if (item.action === 'new-session') {
    startFreshSession()

    return
  }

  if (item.route) {
    navigate(item.route)
  }
}

export function runSessionSearchShortcut(navigate: (route: string) => void, focus: () => void): void {
  navigate(BUSINESS_HISTORY_ROUTE)
  focus()
}
