/**
 * hc-1142 identity guard harness: what 「退出登录」 puts on screen outside product
 * mode, from the click to the login screen. The goldens beside this file were
 * recorded with this same file on fork main f159f8abf3, before any hc-1142 code
 * existed, so it must keep using only APIs main already had.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { vi } from 'vitest'

import { AccountPanel } from '@/app/chat/sidebar/account-panel'
import { DesktopAuthGate } from '@/app/desktop-auth-gate'
import { $notifications } from '@/store/notifications'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { never, normalized, Providers, seed, settle } from '../re-sign-in/render'

export type SignOutMode = 'developer' | 'switch-off'

export function setSignOutMode(mode: SignOutMode): void {
  // Tool view first: switch-on-then-developer would pass through product mode on the way.
  setToolViewMode(mode === 'developer' ? 'technical' : 'product')
  setSingleThreadFlagForTest(mode === 'developer')
}

/** A bridge whose sign-out answers with `signOut` and whose status never answers. */
export function installSignOutBridge(signOut: () => Promise<unknown>): void {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { api: vi.fn(never), managed: { signOut: vi.fn(signOut), status: vi.fn(never) } }
  })
}

let setGatewayOpen: (open: boolean) => void = () => undefined

/** The main window's account row and auth gate, with the gateway state under the test's control. */
function Shell() {
  const [open, setOpen] = useState(true)
  setGatewayOpen = setOpen

  return (
    <>
      <AccountPanel />
      <DesktopAuthGate enabled={open} requestGateway={vi.fn(never) as never} />
    </>
  )
}

/** Signed in, the account menu open, 退出登录 clicked; the bridge decides what happens next. */
export async function clickSignOut(): Promise<HTMLElement> {
  seed()
  $notifications.set([])

  const view = render(
    <Providers>
      <Shell />
    </Providers>
  )

  fireEvent.pointerDown(screen.getByRole('button', { name: '打开账户菜单: Kael' }), { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole('menuitem', { name: '退出登录' }))
  await settle()

  return view.baseElement
}

/** The engine restarts after the sign-out: its gateway drops, then comes back. */
export async function gateway(open: boolean): Promise<void> {
  act(() => setGatewayOpen(open))
  await settle()
}

export function bodyHtml(element: HTMLElement): string {
  return normalized(element.innerHTML)
}

/** What the notification store holds: the failure's words and its action. */
export function notificationsJson(): string {
  const rows = $notifications.get().map(item => ({
    action: item.action?.label ?? null,
    kind: item.kind,
    message: item.message,
    title: item.title ?? null
  }))

  return JSON.stringify(rows, null, 2) + '\n'
}
