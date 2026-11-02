/**
 * hc-1133 identity guard harness. Renders the surfaces the new account menu must
 * leave alone outside product mode: AccountPanel with its menu open, the whole
 * chat sidebar with that menu open, and the single-thread row before it is
 * opened. It must keep using only APIs main already had: the same file recorded
 * the goldens beside it on fork main bb742c3fbe, before any hc-1133 code existed.
 */
// First: the recording time zone, before any app module or fixture.
import '../single-thread-shell/time-zone'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { expect, vi } from 'vitest'

import { AccountPanel } from '@/app/chat/sidebar/account-panel'
import { SidebarSurface } from '@/app/contrib/surfaces'
import type { SidebarActions } from '@/app/contrib/types'
import { SidebarProvider } from '@/components/ui/sidebar'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $selectedStoredSessionId, $sessions, $sessionsLoading } from '@/store/session'

import { GOLDEN_NOW, normalized, SESSION_ROWS } from '../single-thread-shell/render'

const noop = () => {}

const SIDEBAR_ACTIONS: SidebarActions = {
  onArchiveSession: noop,
  onBranchSession: noop,
  onDeleteSession: noop,
  onLoadMoreSessions: noop,
  onManageCronJob: noop,
  onNavigate: noop,
  onNewSessionInWorkspace: noop,
  onNewSessionSplit: noop,
  onResumeSession: noop,
  onTriggerCronJob: noop
}

/** What the cloud answers while the weekly ledger only records: nothing here may reach these surfaces. */
export const SHADOW_PLAN_USAGE = {
  ok: true,
  usage: {
    period: 'month',
    planCode: 'fast',
    planName: '快速',
    usedRatio: 0.18,
    weekly: { enforced: false, resetsAt: '2026-11-08T16:00:00+00:00', unlimited: false, usedRatio: 0.4 }
  }
}

export function seedAccountMenuState(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(GOLDEN_NOW)
  setRuntimeI18nLocale('zh')
  $sessions.set(SESSION_ROWS)
  $sessionsLoading.set(false)
  $selectedStoredSessionId.set('chat-a')
  $authState.set({
    account: { email: 'kael@example.com', name: 'Kael', plan: 'fast' },
    accountId: 'acct-1',
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-in'
  })
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { managed: { planUsage: vi.fn(async () => SHADOW_PLAN_USAGE) } }
  })
}

async function openMenu(): Promise<void> {
  fireEvent.pointerDown(screen.getByRole('button', { name: '打开账户菜单: Kael' }), { button: 0, ctrlKey: false })
  await screen.findByRole('menuitem', { name: '退出登录' })
}

/** AccountPanel alone with its menu open, as the business chrome shows it (`businessChrome`) or not. */
export async function accountPanelHtml(businessChrome: boolean): Promise<string> {
  const view = render(
    <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="zh">
        <AccountPanel businessChrome={businessChrome} onNavigateBusiness={noop} />
      </I18nProvider>
    </MemoryRouter>
  )

  await openMenu()

  return normalized(view.baseElement.innerHTML)
}

/** The sidebar the mode draws, with the account menu open. */
export async function sidebarWithMenuHtml(): Promise<string> {
  const view = render(
    <MemoryRouter initialEntries={['/chat-a']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <SidebarProvider>
          <SidebarSurface actions={SIDEBAR_ACTIONS} currentView="chat" />
        </SidebarProvider>
      </I18nProvider>
    </MemoryRouter>
  )

  await openMenu()

  return normalized(view.baseElement.innerHTML)
}

/** The account row before anything is opened: the name over its plan line. */
export async function accountRowHtml(): Promise<string> {
  render(
    <MemoryRouter initialEntries={['/chat-a']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <SidebarProvider>
          <SidebarSurface actions={SIDEBAR_ACTIONS} currentView="chat" />
        </SidebarProvider>
      </I18nProvider>
    </MemoryRouter>
  )

  const row = await screen.findByRole('button', { name: '打开账户菜单: Kael' })

  await waitFor(() => expect(row.querySelector('[data-single-thread-account-line="plan"]')).not.toBeNull())

  return normalized(row.outerHTML)
}
