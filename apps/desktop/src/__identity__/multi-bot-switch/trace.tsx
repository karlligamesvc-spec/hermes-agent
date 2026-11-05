/**
 * hc-1146 trace harness: what the conversation column goes through while the
 * user clicks from one assistant to another and back, as a list of frames.
 *
 * The shell (useSingleThreadShell) and the switch (openBot) are the real ones.
 * The chat controller's two halves a switch touches are stubs with the app's
 * timing: a fresh draft drops the selection and goes to `/` a little late
 * (wiring.tsx → startFreshSessionDraft), and a conversation route is selected
 * a little after the route changed (use-route-resume.ts → resumeSession, which
 * selects at its synchronous entry). Both engines are warm: the registry
 * publishes the target as the active profile in the click's own tick and the
 * swap settles 20 ms later (the test's ensureGatewayProfile mock).
 *
 * A frame is what the column could paint: the route, the conversation
 * selected, the thread the shell holds ($mainThread: `loading` paints
 * nothing), the swap in flight (what 「正在唤醒」 reads), the assistant asked
 * for and the engine answering. Uses only APIs fork main 50265a41 already
 * had, so the goldens were recorded there before hc-1146 changed the switch.
 */
import { act, cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'

import type { RequestGateway } from '@/app/single-thread/composer-middleware'
import { useSingleThreadShell } from '@/app/single-thread/use-single-thread-shell'
import { $mainThread, MAIN_THREAD_TITLE } from '@/store/main-thread'
import { $activeGatewayProfile, $freshSessionRequest, $gatewaySwapTarget } from '@/store/profile'
import { $selectedStoredSessionId } from '@/store/session'
import { $botIntent, openBot } from '@/store/single-thread-bots'

const THREADS: Record<string, string> = { default: 'apex-root', writer: 'writer-root' }

/** How late the fresh draft lands after it was asked for. */
const FRESH_DRAFT_DELAY_MS = 5
/** How late a conversation route is selected after the route changed. */
const RESUME_DELAY_MS = 2
/** Long enough for a warm swap (20 ms), a fresh draft and a resume to settle. */
const SETTLE_MS = 80

function traceGateway(): RequestGateway & { calls: string[] } {
  const calls: string[] = []

  const request = (async (method: string, params?: Record<string, unknown>) => {
    calls.push(params && 'profile' in params ? `${method}(${String(params.profile)})` : method)

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
  }) as RequestGateway & { calls: string[] }

  request.calls = calls

  return request
}

function frameRecorder() {
  const frames: string[] = []
  let route = ''

  const note = () => {
    const thread = $mainThread.get()

    const frame = [
      route,
      `selected=${$selectedStoredSessionId.get()}`,
      `thread=${thread.profile}:${thread.status}:${thread.tipId}`,
      `swap=${$gatewaySwapTarget.get()}`,
      `intent=${$botIntent.get()}`,
      `active=${$activeGatewayProfile.get()}`
    ].join(' | ')

    if (frames.at(-1) !== frame) {
      frames.push(frame)
    }
  }

  const stops = [$selectedStoredSessionId, $mainThread, $gatewaySwapTarget, $botIntent, $activeGatewayProfile].map(
    store => (store as { listen: (cb: () => void) => () => void }).listen(note)
  )

  return {
    frames,
    route: (pathname: string) => {
      route = pathname
      note()
    },
    stop: () => stops.forEach(stop => stop())
  }
}

/** The chat controller's half of a switch, at the app's timing (see the header). */
function Column({ onRoute, request }: { onRoute: (pathname: string) => void; request: RequestGateway }) {
  useSingleThreadShell(request)
  const { pathname } = useLocation()
  const navigate = useNavigate()

  useEffect(() => onRoute(pathname), [onRoute, pathname])

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

  useEffect(() => {
    const id = pathname === '/' ? null : decodeURIComponent(pathname.slice(1))

    if (!id || $selectedStoredSessionId.get() === id) {
      return
    }

    const timer = window.setTimeout(() => $selectedStoredSessionId.set(id), RESUME_DELAY_MS)

    return () => window.clearTimeout(timer)
  }, [pathname])

  return null
}

/**
 * Let `ms` pass one millisecond per act() scope: React renders an update made
 * outside act only when the scope ends, so one long scope would paint every
 * route change late, after the timers that follow it in the app.
 */
async function tick(ms: number): Promise<void> {
  for (let passed = 0; passed < ms; passed += 1) {
    await act(async () => new Promise(resolve => window.setTimeout(resolve, 1)))
  }
}

/**
 * Settle on APEX's thread, click 小红书文案, then click APEX again. Returns the
 * frames of both switches, the engine switches asked for (`ensureCalls`, the
 * mocked ensureGatewayProfile's call list) and the gateway requests.
 */
export async function multiBotSwitchTrace(ensureCalls: () => unknown[][]): Promise<string> {
  const request = traceGateway()
  const recorder = frameRecorder()

  $activeGatewayProfile.set('default')
  $selectedStoredSessionId.set('apex-root')

  render(
    <MemoryRouter initialEntries={['/apex-root']}>
      <Column onRoute={recorder.route} request={request} />
    </MemoryRouter>
  )

  // The roster and both threads are read (with several assistants on); a fixed settle in every mode.
  await tick(40)
  recorder.frames.splice(0, recorder.frames.length - 1)

  const switches: Record<string, unknown> = {}

  for (const target of ['writer', 'default']) {
    const start = recorder.frames.length - 1

    act(() => void openBot(target).catch(() => undefined))
    await tick(SETTLE_MS)

    switches[`to ${target}`] = recorder.frames.slice(start)
  }

  recorder.stop()
  cleanup()

  return `${JSON.stringify(
    { ensure: ensureCalls().map(call => call[0]), requests: request.calls, switches },
    null,
    2
  )}\n`
}
