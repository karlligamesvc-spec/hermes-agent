/**
 * hc-1099 identity harness: what the single-thread shell does around an
 * assistant switch whose engine is already running, as a trace.
 *
 * Only the stores move here, in the order a warm switch moves them: the fresh
 * draft is asked for, the gateway swap starts and the registry publishes the
 * target as the active profile in the same tick (use-gateway-boot.ts
 * onActiveRouteChanged), the fresh draft lands a tick later, the swap settles.
 * Then a notification selects APEX's thread. The trace records every gateway
 * switch the shell asks for, every route it visits and where the stores end.
 * Uses only APIs fork main already had, so the goldens could be recorded there.
 */
import { act, cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'

import type { RequestGateway } from '@/app/single-thread/composer-middleware'
import { useSingleThreadShell } from '@/app/single-thread/use-single-thread-shell'
import { MAIN_THREAD_TITLE } from '@/store/main-thread'
import { $activeGatewayProfile, $freshSessionRequest, $gatewaySwapTarget, requestFreshSession } from '@/store/profile'
import { $selectedStoredSessionId } from '@/store/session'
import { $botIntent } from '@/store/single-thread-bots'

const THREADS: Record<string, string> = { default: 'apex-root', writer: 'writer-root' }

export function traceGateway(): RequestGateway & { calls: [string, Record<string, unknown> | undefined][] } {
  const calls: [string, Record<string, unknown> | undefined][] = []

  const request = (async (method: string, params?: Record<string, unknown>) => {
    calls.push([method, params])

    if (method === 'session.list') {
      const id = THREADS[String(params?.profile)]

      return { sessions: id ? [{ id, title: MAIN_THREAD_TITLE }] : [] }
    }

    if (method === 'profiles.list') {
      return {
        profiles: [
          { is_default: true, name: 'default' },
          { name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } }
        ]
      }
    }

    if (method === 'profiles.describe') {
      return { soul: '你是小红书文案。' }
    }

    return {}
  }) as RequestGateway & { calls: typeof calls }

  request.calls = calls

  return request
}

/** How late the fresh draft lands after the engine was published (a later commit's effect in the app). */
const FRESH_DRAFT_DELAY_MS = 5

/** The chat controller's half of a switch: a fresh draft drops the selection and goes to `/`, a little late. */
function FreshDraft() {
  const navigate = useNavigate()

  useEffect(
    () =>
      $freshSessionRequest.listen(() => {
        window.setTimeout(() => {
          $selectedStoredSessionId.set(null)
          navigate('/')
        }, FRESH_DRAFT_DELAY_MS)
      }),
    [navigate]
  )

  return null
}

function Shell({ request, visited }: { request: RequestGateway; visited: string[] }) {
  useSingleThreadShell(request)
  const { pathname } = useLocation()

  useEffect(() => {
    if (visited.at(-1) !== pathname) {
      visited.push(pathname)
    }
  }, [pathname, visited])

  return <FreshDraft />
}

const tick = (ms = 0) => act(async () => new Promise(resolve => window.setTimeout(resolve, ms)))

/**
 * Run the warm switch and the notification. `ensureCalls` is the mocked
 * ensureGatewayProfile's call list (the shell's only way to switch engines).
 */
export async function switchFollowTrace(ensureCalls: () => unknown[][]): Promise<string> {
  const request = traceGateway()
  const visited: string[] = []

  $activeGatewayProfile.set('default')
  $selectedStoredSessionId.set('apex-root')

  render(
    <MemoryRouter initialEntries={['/apex-root']}>
      <Shell request={request} visited={visited} />
    </MemoryRouter>
  )

  // Off (or in developer mode) the shell looks nothing up: a fixed settle, the same in every mode.
  await tick(30)

  const steps: Record<string, unknown>[] = []

  const note = (step: string) =>
    steps.push({
      active: $activeGatewayProfile.get(),
      ensure: ensureCalls().map(call => call[0]),
      intent: $botIntent.get(),
      selected: $selectedStoredSessionId.get(),
      step,
      swap: $gatewaySwapTarget.get(),
      visited: [...visited]
    })

  note('settled on APEX')

  // The warm switch's first tick: the click's fresh-draft request, the swap and the registry's publication.
  // A synchronous act: it flushes the effects without letting the fresh draft's timer run.
  act(() => {
    requestFreshSession()
    $gatewaySwapTarget.set('writer')
    $activeGatewayProfile.set('writer')
  })
  note('engine published, old thread still selected')

  await tick(FRESH_DRAFT_DELAY_MS * 4)
  note('fresh draft landed')

  await act(async () => $gatewaySwapTarget.set(null))
  await tick(10)
  note('swap settled')

  // A notification opens APEX's thread while 小红书文案 is on screen.
  await act(async () => $selectedStoredSessionId.set('apex-root'))
  await tick(10)
  note('notification selected APEX’s thread')

  const methods = request.calls.map(([method, params]) =>
    params && 'profile' in params
      ? `${method}(${String(params.profile)})`
      : params && 'name' in params
        ? `${method}(${String(params.name)})`
        : method
  )

  cleanup()

  return `${JSON.stringify({ requests: methods, steps }, null, 2)}\n`
}
