import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { DesktopAgentAuthResult, DesktopAgentAuthStatus, DesktopAgentProxyState } from '@/global'

// hc-545 编码 Agent 账号连接卡. The card talks only to window.hermesDesktop.agentAuth
// / .agentProxy (the main-process bridges). We stub them per test. The load-
// bearing assertion is the ANTI-CONFLATION at the UI layer: a logged-in-but-
// unreachable agent must render the "proxy needed" line, NOT the "not signed in"
// line — the exact trap this ticket exists to close.

const status = vi.fn<() => Promise<DesktopAgentAuthStatus>>()
const connect = vi.fn()
const proxyGet = vi.fn<() => Promise<DesktopAgentProxyState>>()
const proxySet = vi.fn()

function agentResult(over: Partial<DesktopAgentAuthResult>): DesktopAgentAuthResult {
  return { family: 'claude', state: 'unknown', email: '', plan: '', ...over }
}

function stubBridge() {
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    agentAuth: { status, connect },
    agentProxy: { get: proxyGet, set: proxySet }
  }
}

beforeEach(() => {
  stubBridge()
  proxyGet.mockResolvedValue({ ok: true, mode: 'auto', customUrl: '', detected: { active: false, url: '' } })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

async function renderCard() {
  const { AgentAuthSettings } = await import('./agent-auth-settings')

  return render(<AgentAuthSettings />)
}

it('renders unreachable (proxy) and logged_out (sign in) as DISTINCT states — never conflated', async () => {
  status.mockResolvedValue({
    ok: true,
    claude: agentResult({ family: 'claude', state: 'unreachable' }),
    codex: agentResult({ family: 'codex', state: 'logged_out' })
  })

  await renderCard()

  // claude: signed in but blocked → the network/proxy line, plus the "set up
  // proxy" action (not "connect account").
  expect(await screen.findByText(/API is unreachable/i)).toBeTruthy()
  expect(screen.getByText(/Set up network proxy/i)).toBeTruthy()

  // codex: genuinely not signed in → the sign-in line + connect action.
  expect(screen.getByText(/Not signed in/i)).toBeTruthy()
  expect(screen.getByText(/Connect account/i)).toBeTruthy()
})

it('renders a ready agent with its email', async () => {
  status.mockResolvedValue({
    ok: true,
    claude: agentResult({ family: 'claude', state: 'ready', email: 'k@l.com' }),
    codex: agentResult({ family: 'codex', state: 'no_cli' })
  })

  await renderCard()

  expect(await screen.findByText(/Connected · k@l\.com/i)).toBeTruthy()
  // no_cli surfaces the install command to copy.
  expect(screen.getByText(/npm install -g @openai\/codex/i)).toBeTruthy()
})

it('renders nothing in the web build (no bridge)', async () => {
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  const { container } = await renderCard()
  expect(container.firstChild).toBeNull()
})
