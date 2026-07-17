import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { writeClipboardText } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type {
  DesktopAgentAuthResult,
  DesktopAgentAuthState,
  DesktopAgentFamily,
  DesktopAgentProxyMode
} from '@/global'
import { useI18n } from '@/i18n'
import { AlertCircle, CheckCircle2, Copy, Globe, KeyRound, Loader2, LogIn, RefreshCw } from '@/lib/icons'
import { notify } from '@/store/notifications'

import { SettingsCategoryHeading } from './env-credentials'

// hc-545 编码 Agent 账号连接卡 — the last piece of the passthrough/daemon new-user
// journey. It surfaces the THREE-STATE login status of the user's own claude /
// codex CLIs (logged_out / unreachable / ready), hosts an in-app OAuth so the
// user never touches a terminal, and drives the macOS system-proxy autopilot.
// The anti-conflation rule is the whole point: `unreachable` (fix: proxy) is
// never shown as `logged_out` (fix: sign in) — the exact trap PM hit on the real
// machine. All logic lives in main (electron/apex-agent-auth + apex-agent-proxy);
// no secret ever reaches this component.

// The families we host, in display order. Names are brand literals (not i18n);
// install hints mirror the runtime registry (agent/coding_agents/registry.py).
const FAMILIES: { id: DesktopAgentFamily; name: string; install: string }[] = [
  { id: 'claude', name: 'Claude Code', install: 'npm install -g @anthropic-ai/claude-code' },
  { id: 'codex', name: 'Codex', install: 'npm install -g @openai/codex' }
]

const POLL_INTERVAL_MS = 3000
const POLL_MAX_TICKS = 40 // ~2 min — an OAuth flow past that is abandoned

function desktopBridge() {
  return typeof window !== 'undefined' ? window.hermesDesktop : undefined
}

function agentAuthBridge() {
  return desktopBridge()?.agentAuth
}

function agentProxyBridge() {
  return desktopBridge()?.agentProxy
}

// Tone + icon per state. `logged_out` and `unreachable` are visually distinct so
// the user reads the right fix at a glance.
function stateVisual(state: DesktopAgentAuthState) {
  switch (state) {
    case 'ready':
      return { Icon: CheckCircle2, tone: 'text-primary' }

    case 'unreachable':
      return { Icon: Globe, tone: 'text-destructive' }

    case 'logged_out':
      return { Icon: AlertCircle, tone: 'text-amber-500 dark:text-amber-400' }

    case 'no_cli':
      return { Icon: AlertCircle, tone: 'text-muted-foreground' }

    default:
      return { Icon: AlertCircle, tone: 'text-muted-foreground' }
  }
}

export function AgentAuthSettings() {
  const { t } = useI18n()
  const copy = t.settings.agentAuth

  const [statuses, setStatuses] = useState<Record<DesktopAgentFamily, DesktopAgentAuthResult> | null>(null)
  const [checking, setChecking] = useState(false)
  const [connecting, setConnecting] = useState<DesktopAgentFamily | null>(null)
  const [waiting, setWaiting] = useState<DesktopAgentFamily | null>(null)
  const [guide, setGuide] = useState<{ command: string; family: DesktopAgentFamily } | null>(null)

  const [proxyMode, setProxyMode] = useState<DesktopAgentProxyMode>('auto')
  const [customUrl, setCustomUrl] = useState('')
  const [detected, setDetected] = useState<{ active: boolean; url: string }>({ active: false, url: '' })
  const [proxyBusy, setProxyBusy] = useState(false)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const proxySectionRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    const bridge = agentAuthBridge()

    if (!bridge) {
      return
    }

    setChecking(true)

    try {
      const result = await bridge.status()
      setStatuses({ claude: result.claude, codex: result.codex })
    } catch {
      // Leave the last-known statuses; a transient status read failure is not
      // itself a login problem, so we do not flip anything to an error state.
    } finally {
      setChecking(false)
    }
  }, [])

  const loadProxy = useCallback(async () => {
    const bridge = agentProxyBridge()

    if (!bridge) {
      return
    }

    try {
      const result = await bridge.get()
      setProxyMode(result.mode)
      setCustomUrl(result.customUrl)
      setDetected(result.detected)
    } catch {
      // best effort
    }
  }, [])

  useEffect(() => {
    void refresh()
    void loadProxy()
  }, [refresh, loadProxy])

  // Stop any in-flight OAuth status poll on unmount.
  useEffect(
    () => () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
      }
    },
    []
  )

  // After a connect that opened the browser, poll status until the family turns
  // ready (or we give up). Only ever narrows a `waiting` banner — never claims
  // success on its own.
  const startPolling = useCallback(
    (family: DesktopAgentFamily) => {
      const bridge = agentAuthBridge()

      if (!bridge) {
        return
      }

      if (pollRef.current) {
        clearInterval(pollRef.current)
      }

      setWaiting(family)
      let ticks = 0

      pollRef.current = setInterval(async () => {
        ticks += 1

        try {
          const result = await bridge.status()
          setStatuses({ claude: result.claude, codex: result.codex })

          if (result[family].state === 'ready' || ticks >= POLL_MAX_TICKS) {
            if (pollRef.current) {
              clearInterval(pollRef.current)
              pollRef.current = null
            }

            setWaiting(current => (current === family ? null : current))

            if (result[family].state === 'ready') {
              notify({ kind: 'success', title: copy.title, message: copy.completed })
            }
          }
        } catch {
          // keep polling until the tick budget is spent
        }
      }, POLL_INTERVAL_MS)
    },
    [copy]
  )

  const handleConnect = useCallback(
    async (family: DesktopAgentFamily) => {
      const bridge = agentAuthBridge()

      if (!bridge || connecting) {
        return
      }

      setConnecting(family)
      setGuide(null)

      try {
        const result = await bridge.connect(family)

        if (result.mode === 'guide' || result.mode === 'no_cli') {
          setGuide({ family, command: result.guideCommand })
        } else if (result.mode === 'completed') {
          await refresh()
        } else {
          // browser / started — the loopback captures the callback; poll status.
          startPolling(family)
        }
      } catch {
        notify({ kind: 'error', title: copy.title, message: copy.stateUnknown })
      } finally {
        setConnecting(null)
      }
    },
    [connecting, copy, refresh, startPolling]
  )

  const focusProxy = useCallback(() => {
    proxySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  const copyCommand = useCallback(
    async (command: string) => {
      try {
        await writeClipboardText(command)
        notify({ kind: 'success', title: copy.title, message: copy.copied })
      } catch {
        // ignore — nothing lost, the command is still visible to copy manually
      }
    },
    [copy]
  )

  const persistProxy = useCallback(
    async (mode: DesktopAgentProxyMode, url: string) => {
      const bridge = agentProxyBridge()

      if (!bridge) {
        return
      }

      setProxyBusy(true)

      try {
        const result = await bridge.set({ mode, customUrl: url })
        setProxyMode(result.mode)
        setCustomUrl(result.customUrl)
        setDetected(result.detected)
        notify({ kind: 'success', title: copy.proxyTitle, message: copy.saved })
      } catch {
        notify({ kind: 'error', title: copy.proxyTitle, message: copy.proxyInvalid })
      } finally {
        setProxyBusy(false)
      }
    },
    [copy]
  )

  const handleModeChange = useCallback(
    (mode: DesktopAgentProxyMode) => {
      setProxyMode(mode)

      // auto/off take effect immediately; custom waits for a valid URL + Save.
      if (mode !== 'custom') {
        void persistProxy(mode, customUrl)
      }
    },
    [customUrl, persistProxy]
  )

  const stateLabel = useCallback(
    (result: DesktopAgentAuthResult) => {
      switch (result.state) {
        case 'ready':
          return result.email ? copy.stateReadyEmail(result.email) : copy.stateReady

        case 'logged_out':
          return copy.stateLoggedOut

        case 'unreachable':
          return copy.stateUnreachable

        case 'no_cli':
          return copy.stateNoCli

        default:
          return copy.stateUnknown
      }
    },
    [copy]
  )

  const proxyDetectedLine = useMemo(() => {
    if (proxyMode === 'off') {
      return copy.proxyModeOffHint
    }

    return detected.active && detected.url ? copy.proxyDetected(detected.url) : copy.proxyNone
  }, [copy, detected, proxyMode])

  // Not the Electron shell (web build) → the bridge is absent; render nothing.
  if (!agentAuthBridge()) {
    return null
  }

  return (
    <section className="mb-5 grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <SettingsCategoryHeading icon={KeyRound} title={copy.title} />
        <Button disabled={checking} onClick={() => void refresh()} size="xs" type="button" variant="ghost">
          {checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          {copy.refresh}
        </Button>
      </div>
      <p className="p5-section-intro -mt-1">{copy.intro}</p>

      <div className="grid gap-3 rounded-[8px] border border-border/40 p-3">
        {FAMILIES.map(family => {
          const result = statuses?.[family.id]
          const state = result?.state ?? 'unknown'
          const { Icon, tone } = stateVisual(state)
          const isConnecting = connecting === family.id
          const isWaiting = waiting === family.id
          const showConnect = state === 'logged_out' || state === 'unreachable' || state === 'unknown'

          return (
            <div className="grid gap-1.5" data-testid={`agent-auth-${family.id}`} key={family.id}>
              <div className="flex items-center justify-between gap-3">
                <div className="grid gap-0.5">
                  <div className="text-[length:var(--conversation-text-font-size)] font-medium">{family.name}</div>
                  <div className={`flex items-center gap-1.5 text-[length:var(--conversation-caption-font-size)] ${tone}`}>
                    {statuses ? <Icon className="size-3.5 shrink-0" /> : <Loader2 className="size-3.5 shrink-0 animate-spin" />}
                    <span>{statuses ? stateLabel(result as DesktopAgentAuthResult) : copy.checking}</span>
                  </div>
                </div>

                {state === 'unreachable' ? (
                  <Button onClick={focusProxy} size="sm" type="button" variant="outline">
                    <Globe className="size-3.5" />
                    {copy.fixNetwork}
                  </Button>
                ) : state === 'no_cli' ? null : showConnect ? (
                  <Button disabled={isConnecting} onClick={() => void handleConnect(family.id)} size="sm" type="button" variant="outline">
                    {isConnecting ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
                    {copy.connect}
                  </Button>
                ) : state === 'ready' ? (
                  <Button
                    className="text-muted-foreground"
                    disabled={isConnecting}
                    onClick={() => void handleConnect(family.id)}
                    size="xs"
                    type="button"
                    variant="ghost"
                  >
                    {copy.reconnect}
                  </Button>
                ) : null}
              </div>

              {state === 'no_cli' ? (
                <div className="flex items-center justify-between gap-2 rounded-[6px] bg-muted/40 px-2.5 py-1.5">
                  <code className="truncate text-[length:var(--conversation-caption-font-size)] text-muted-foreground">{family.install}</code>
                  <Button onClick={() => void copyCommand(family.install)} size="xs" type="button" variant="ghost">
                    <Copy className="size-3" />
                    {copy.copyCommand}
                  </Button>
                </div>
              ) : null}

              {isWaiting ? (
                <p className="text-[length:var(--conversation-caption-font-size)] text-muted-foreground">{copy.waitingBrowser}</p>
              ) : null}

              {guide && guide.family === family.id ? (
                <div className="grid gap-1 rounded-[6px] border border-border/40 p-2">
                  <p className="text-[length:var(--conversation-caption-font-size)] text-muted-foreground">{copy.guideIntro}</p>
                  <div className="flex items-center justify-between gap-2 rounded-[4px] bg-muted/40 px-2.5 py-1.5">
                    <code className="truncate text-[length:var(--conversation-caption-font-size)]">{guide.command}</code>
                    <Button onClick={() => void copyCommand(guide.command)} size="xs" type="button" variant="ghost">
                      <Copy className="size-3" />
                      {copy.copyCommand}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}

        {/* Network proxy autopilot — the fix for the `unreachable` state. */}
        <div className="grid gap-2 border-t border-border/40 pt-3" ref={proxySectionRef}>
          <div className="flex items-center gap-1.5">
            <Globe className="size-3.5 text-muted-foreground" />
            <span className="text-[length:var(--conversation-text-font-size)] font-medium">{copy.proxyTitle}</span>
          </div>
          <p className="text-[length:var(--conversation-caption-font-size)] text-muted-foreground">{copy.proxyIntro}</p>

          <div className="flex items-center gap-2">
            <Select disabled={proxyBusy} onValueChange={value => handleModeChange(value as DesktopAgentProxyMode)} value={proxyMode}>
              <SelectTrigger className="w-40" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{copy.proxyModeAuto}</SelectItem>
                <SelectItem value="custom">{copy.proxyModeCustom}</SelectItem>
                <SelectItem value="off">{copy.proxyModeOff}</SelectItem>
              </SelectContent>
            </Select>
            {proxyMode === 'auto' ? (
              <span className="text-[length:var(--conversation-caption-font-size)] text-muted-foreground">{copy.proxyModeAutoHint}</span>
            ) : null}
          </div>

          {proxyMode === 'custom' ? (
            <div className="flex items-end gap-2">
              <label className="grid flex-1 gap-1">
                <span className="text-[length:var(--conversation-caption-font-size)] text-muted-foreground">{copy.proxyCustomLabel}</span>
                <Input
                  onChange={event => setCustomUrl(event.target.value)}
                  placeholder={copy.proxyCustomPlaceholder}
                  value={customUrl}
                />
              </label>
              <Button disabled={proxyBusy || !customUrl.trim()} onClick={() => void persistProxy('custom', customUrl)} size="sm" type="button">
                {proxyBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {copy.save}
              </Button>
            </div>
          ) : null}

          <p className="text-[length:var(--conversation-caption-font-size)] text-muted-foreground">{proxyDetectedLine}</p>
        </div>
      </div>
    </section>
  )
}
