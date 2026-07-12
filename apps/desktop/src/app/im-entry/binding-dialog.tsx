import { useCallback, useEffect, useReducer, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2 } from '@/lib/icons'
import { imEntryChannel } from '@/lib/im-entry-catalog'
import { cn } from '@/lib/utils'
import { notify } from '@/store/notifications'

import { PlatformAvatar } from '../messaging/platform-icon'

import {
  type DeviceCodeErrorReason,
  deviceCodeReduce,
  initialDeviceCodeState
} from './device-code-machine'

// The main-process IM 入口 bridge; absent on the web build / an older shell.
function imEntryBridge() {
  return typeof window !== 'undefined' ? window.hermesDesktop?.imEntry : undefined
}

function openExternal(url: string) {
  if (typeof window !== 'undefined' && window.hermesDesktop?.openExternal && url) {
    void window.hermesDesktop.openExternal(url)
  }
}

// Map a failed issue/poll result to a machine error reason. NOT_SIGNED_IN /
// SESSION_EXPIRED → sign_in; SERVICE_UNAVAILABLE → service_unavailable; anything
// else is transient.
function failReason(result: { needsSignIn?: boolean; message?: string }): 'request_failed' | 'service_unavailable' | 'sign_in' {
  if (result.needsSignIn || result.message === 'NOT_SIGNED_IN' || result.message === 'SESSION_EXPIRED') {
    return 'sign_in'
  }

  if (result.message === 'SERVICE_UNAVAILABLE') {
    return 'service_unavailable'
  }

  return 'request_failed'
}

// The device-code flow hook: wires the pure state machine (device-code-machine.ts)
// to the main-process issue/poll IPC + the poll/expiry timers. The renderer owns
// the polling loop (per the hc-417 spike). On 'authorized' the main process has
// already stored the credential + is restarting the backend (which reloads this
// window), so we just rest in the success state until the reload lands.
function useDeviceCodeFlow(open: boolean) {
  const [state, dispatch] = useReducer(deviceCodeReduce, undefined, initialDeviceCodeState)

  const start = useCallback(async () => {
    dispatch({ type: 'START' })
    const bridge = imEntryBridge()

    if (!bridge) {
      dispatch({ type: 'ISSUE_FAILED', reason: 'service_unavailable' })

      return
    }

    try {
      const result = await bridge.feishuIssue()

      if (result.ok && result.deviceCode && result.scanUrl) {
        dispatch({
          type: 'ISSUED',
          deviceCode: result.deviceCode,
          scanUrl: result.scanUrl,
          qrUrl: result.qrUrl ?? '',
          intervalMs: result.intervalMs ?? 3000,
          expiresAt: Date.now() + (result.expiresInMs ?? 300_000)
        })
      } else {
        dispatch({ type: 'ISSUE_FAILED', reason: failReason(result) })
      }
    } catch {
      dispatch({ type: 'ISSUE_FAILED', reason: 'request_failed' })
    }
  }, [])

  // Auto-start on open; reset when the dialog closes so a reopen is a clean run.
  useEffect(() => {
    if (open) {
      if (state.phase === 'idle') {
        void start()
      }
    } else {
      dispatch({ type: 'RESET' })
    }
    // Only react to open toggling; start/phase are intentionally not deps (we
    // want a single kickoff per open, not a restart on every phase change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Poll loop — active only while awaiting confirmation.
  useEffect(() => {
    if (state.phase !== 'awaiting_scan') {
      return
    }

    const bridge = imEntryBridge()

    if (!bridge) {
      return
    }

    let cancelled = false

    const id = window.setInterval(async () => {
      if (cancelled) {
        return
      }

      try {
        const result = await bridge.feishuPoll(state.deviceCode)

        if (cancelled) {
          return
        }

        if (result.ok) {
          dispatch({ type: 'POLL_RESULT', status: result.status ?? 'pending' })
        } else if (result.message === 'KEYCHAIN_UNAVAILABLE') {
          dispatch({ type: 'FAIL', reason: 'keychain' })
        } else {
          dispatch({ type: 'POLL_FAILED', reason: failReason(result) })
        }
      } catch {
        if (!cancelled) {
          dispatch({ type: 'POLL_FAILED', reason: 'request_failed' })
        }
      }
    }, state.intervalMs)

    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [state.phase, state.deviceCode, state.intervalMs])

  // Expiry deadline.
  useEffect(() => {
    if (state.phase !== 'awaiting_scan' || !state.expiresAt) {
      return
    }

    const ms = state.expiresAt - Date.now()

    if (ms <= 0) {
      dispatch({ type: 'EXPIRE' })

      return
    }

    const id = window.setTimeout(() => dispatch({ type: 'EXPIRE' }), ms)

    return () => window.clearTimeout(id)
  }, [state.phase, state.expiresAt])

  return { state, start, reset: () => dispatch({ type: 'RESET' }) }
}

interface BindingDialogProps {
  channelId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

// The binding flow shell. Header carries the channel avatar/name; the body is one
// of two templates chosen by the channel's binding kind (a scan slot or a
// credential-input slot), or a "coming soon" panel for a not-yet-available
// channel. Deliberately jargon-free: the user scans a code or pastes one code.
export function ImEntryBindingDialog({ channelId, open, onOpenChange }: BindingDialogProps) {
  const { t } = useI18n()
  const copy = t.imEntry
  const channel = imEntryChannel(channelId)
  const channelCopy = copy.channels[channelId]
  const name = channelCopy?.name ?? channelId

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <PlatformAvatar platformId={channel?.brand ?? channelId} platformName={name} />
            <div className="min-w-0">
              <DialogTitle className="text-left text-[0.95rem]">{copy.dialog.connectTitle(name)}</DialogTitle>
              {channelCopy?.tagline && (
                <DialogDescription className="text-left text-xs">{channelCopy.tagline}</DialogDescription>
              )}
            </div>
          </div>
        </DialogHeader>

        {!channel?.available ? (
          <ComingSoonBody />
        ) : channel.bindingKind === 'device-code' ? (
          <DeviceCodeTemplate onDone={() => onOpenChange(false)} open={open} />
        ) : (
          <PasteCodeTemplate onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ComingSoonBody() {
  const { t } = useI18n()
  const copy = t.imEntry.dialog

  return (
    <div className="grid gap-1.5 rounded-lg border border-border/40 bg-muted/30 px-3 py-4 text-center">
      <div className="text-sm font-medium">{copy.comingSoonTitle}</div>
      <p className="text-xs text-muted-foreground">{copy.comingSoonBody}</p>
    </div>
  )
}

// ── Template A: device-code (scan slot) ─────────────────────────────────────
function DeviceCodeTemplate({ open, onDone }: { open: boolean; onDone: () => void }) {
  const { t } = useI18n()
  const copy = t.imEntry.dialog
  const { state, start } = useDeviceCodeFlow(open)

  // On success the main process is restarting + reloading the window; surface a
  // toast so the intent is confirmed even before the reload lands.
  useEffect(() => {
    if (state.phase === 'authorized') {
      notify({ kind: 'success', title: copy.authorizedTitle, message: copy.authorizedMessage })
    }
  }, [state.phase, copy])

  if (state.phase === 'error') {
    return (
      <ErrorBody
        onClose={onDone}
        onRetry={state.errorReason === 'sign_in' ? undefined : () => void start()}
        reason={state.errorReason}
      />
    )
  }

  if (state.phase === 'authorized') {
    return (
      <div className="grid justify-items-center gap-2 py-6 text-center">
        <CheckCircle2 className="size-8 text-primary" />
        <div className="text-sm font-medium">{copy.authorizedTitle}</div>
        <p className="text-xs text-muted-foreground">{copy.authorizedMessage}</p>
      </div>
    )
  }

  if (state.phase === 'issuing' || state.phase === 'idle') {
    return (
      <div className="grid justify-items-center gap-3 py-8 text-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <p className="text-xs text-muted-foreground">{copy.issuing}</p>
      </div>
    )
  }

  // awaiting_scan
  return (
    <div className="grid justify-items-center gap-3 py-2 text-center">
      <div className="text-sm font-medium">{copy.scanPrompt}</div>
      <div className="flex size-44 items-center justify-center overflow-hidden rounded-xl border border-border/50 bg-white p-2">
        {state.qrUrl ? (
          // The cloud renders the device-code QR; we display it as-is.
          <img alt="" className="size-full object-contain" src={state.qrUrl} />
        ) : (
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        )}
      </div>
      <p className={cn('text-xs', state.scanned ? 'font-medium text-primary' : 'text-muted-foreground')}>
        {state.scanned ? copy.scanned : copy.scanHint}
      </p>
      {state.scanUrl && (
        <Button onClick={() => openExternal(state.scanUrl)} size="sm" type="button" variant="ghost">
          <ExternalLink className="size-3.5" />
          {copy.openLink}
        </Button>
      )}
    </div>
  )
}

function ErrorBody({
  onClose,
  onRetry,
  reason
}: {
  onClose: () => void
  onRetry?: () => void
  reason: DeviceCodeErrorReason | null
}) {
  const { t } = useI18n()
  const copy = t.imEntry.dialog
  const message = reason ? copy.errors[reason] : copy.errors.request_failed

  return (
    <div className="grid gap-3">
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>{message}</span>
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} size="sm" type="button" variant="ghost">
          {copy.close}
        </Button>
        {onRetry && (
          <Button onClick={onRetry} size="sm" type="button">
            {copy.retry}
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Template B: paste-code (credential-input slot) ──────────────────────────
// The second binding template — paste one code, with the raw developer fields
// tucked behind an "advanced" disclosure so the default stays a single action.
// No channel uses this template yet (钉钉/企微 are coming-soon); it is the ready
// seam the next channel wires its submit into. Kept presentational + wired to a
// caller-supplied submit so it never ships a call to a not-yet-built endpoint.
function PasteCodeTemplate({ onDone }: { onDone: () => void }) {
  const { t } = useI18n()
  const copy = t.imEntry.dialog
  const [code, setCode] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <label className="text-xs font-medium" htmlFor="im-entry-paste">
          {copy.pasteLabel}
        </label>
        <Input
          id="im-entry-paste"
          onChange={event => setCode(event.target.value)}
          placeholder={copy.pastePlaceholder}
          value={code}
        />
      </div>

      <button
        className="flex items-center justify-between gap-2 py-0.5 text-left text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setShowAdvanced(value => !value)}
        type="button"
      >
        <span>{copy.advanced}</span>
        <DisclosureCaret open={showAdvanced} size="0.875rem" />
      </button>

      <div className="flex justify-end gap-2">
        <Button onClick={onDone} size="sm" type="button" variant="ghost">
          {copy.cancel}
        </Button>
        {/* No paste-code channel is available yet, so submit surfaces the
            coming-soon notice rather than calling an endpoint that isn't live. */}
        <Button
          disabled={!code.trim()}
          onClick={() => notify({ kind: 'info', title: copy.comingSoonTitle, message: copy.comingSoonBody })}
          size="sm"
          type="button"
        >
          {copy.pasteSubmit}
        </Button>
      </div>
    </div>
  )
}
