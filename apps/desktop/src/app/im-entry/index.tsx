import type * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { StatusDot, type StatusTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import type { DesktopImEntryBinding } from '@/global'
import { getMessagingPlatforms } from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { CheckCircle2, Loader2, Plus, Trash2 } from '@/lib/icons'
import { IM_ENTRY_CHANNELS, type ImEntryChannel } from '@/lib/im-entry-catalog'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'

import { PlatformAvatar } from '../messaging/platform-icon'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { ImEntryBindingDialog } from './binding-dialog'

interface ImEntryViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

function imEntryBridge() {
  return typeof window !== 'undefined' ? window.hermesDesktop?.imEntry : undefined
}

// Map a live /api/messaging/platforms state to a tone + label for a bound
// channel. Unknown/absent (e.g. mid-restart, or the platform not yet reported)
// reads as "connecting".
function liveStatus(state: string | undefined, copy: Translations['imEntry']): { tone: StatusTone; label: string } {
  switch (state) {
    case 'connected':
      return { tone: 'good', label: copy.liveState.connected }

    case 'error':
    case 'fatal':
    case 'startup_failed':
      return { tone: 'bad', label: copy.liveState.error }

    case 'pending_restart':
      return { tone: 'warn', label: copy.liveState.pending }

    default:
      return { tone: 'warn', label: copy.liveState.connecting }
  }
}

export function ImEntryView({ setStatusbarItemGroup: _setStatusbarItemGroup, ...props }: ImEntryViewProps) {
  const { t } = useI18n()
  const copy = t.imEntry
  const [bound, setBound] = useState<DesktopImEntryBinding[] | null>(null)
  const [liveStates, setLiveStates] = useState<Record<string, string>>({})
  const [dialogChannel, setDialogChannel] = useState<null | string>(null)
  const [busyChannel, setBusyChannel] = useState<null | string>(null)

  const refresh = useCallback(async () => {
    const bridge = imEntryBridge()

    if (bridge) {
      try {
        const result = await bridge.list()
        setBound(result.channels)
      } catch {
        setBound([])
      }
    } else {
      // Web build / older shell — no local bindings to show.
      setBound([])
    }

    // Live connection health is owned by the gateway; read it separately so a
    // stopped gateway just leaves the status "connecting" instead of failing.
    try {
      const result = await getMessagingPlatforms()
      const next: Record<string, string> = {}

      for (const platform of result.platforms) {
        next[platform.id] = platform.state ?? ''
      }

      setLiveStates(next)
    } catch {
      // Gateway not up yet — keep whatever we had.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Poll live status while the page is visible so a channel flips to "connected"
  // without a manual refresh after its gateway restart completes.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) {
        void refresh()
      }
    }, 6000)

    return () => window.clearInterval(id)
  }, [refresh])

  const boundById = useMemo(() => {
    const map = new Map<string, DesktopImEntryBinding>()

    for (const binding of bound ?? []) {
      map.set(binding.channelId, binding)
    }

    return map
  }, [bound])

  const handleUnbind = useCallback(
    async (channelId: string, name: string) => {
      const bridge = imEntryBridge()

      if (!bridge || busyChannel) {
        return
      }

      if (!window.confirm(copy.unbindConfirm(name))) {
        return
      }

      setBusyChannel(channelId)

      try {
        await bridge.unbind(channelId)
        // The main process restarts the backend + reloads the window; the toast
        // confirms intent until the reload lands.
        notify({ kind: 'info', title: copy.unbindDoneTitle, message: copy.unbindDoneMessage })
      } catch (error) {
        notifyError(error, copy.unbindDoneTitle)
        setBusyChannel(null)
      }
    },
    [busyChannel, copy]
  )

  if (!bound) {
    return <PageLoader label={copy.loading} />
  }

  return (
    <section className="h-full min-h-0 overflow-y-auto" {...props}>
      <div className="mx-auto max-w-2xl px-5 py-6">
        <header className="mb-5">
          <h2 className="text-[1.05rem] font-semibold tracking-tight">{copy.title}</h2>
          <p className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
            {copy.intro}
          </p>
        </header>

        <div className="grid gap-2.5 sm:grid-cols-2">
          {IM_ENTRY_CHANNELS.map(channel => (
            <ChannelCard
              binding={boundById.get(channel.id) ?? null}
              busy={busyChannel === channel.id}
              channel={channel}
              key={channel.id}
              liveState={liveStates[channel.id]}
              onConnect={() => setDialogChannel(channel.id)}
              onUnbind={name => void handleUnbind(channel.id, name)}
            />
          ))}
        </div>
      </div>

      {dialogChannel && (
        <ImEntryBindingDialog
          channelId={dialogChannel}
          onOpenChange={open => {
            if (!open) {
              setDialogChannel(null)
              void refresh()
            }
          }}
          open={Boolean(dialogChannel)}
        />
      )}
    </section>
  )
}

function ChannelCard({
  binding,
  busy,
  channel,
  liveState,
  onConnect,
  onUnbind
}: {
  binding: DesktopImEntryBinding | null
  busy: boolean
  channel: ImEntryChannel
  liveState: string | undefined
  onConnect: () => void
  onUnbind: (name: string) => void
}) {
  const { t } = useI18n()
  const copy = t.imEntry
  const channelCopy = copy.channels[channel.id]
  const name = channelCopy?.name ?? channel.id
  const isBound = binding !== null

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border p-3 transition-colors',
        isBound ? 'border-primary/30 bg-primary/5' : 'border-border/50',
        !channel.available && !isBound && 'opacity-70'
      )}
    >
      <div className="flex items-start gap-2.5">
        <PlatformAvatar platformId={channel.brand} platformName={name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{name}</span>
            {isBound && <CheckCircle2 className="size-3.5 shrink-0 text-primary" />}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{channelCopy?.tagline}</p>
        </div>
      </div>

      {isBound ? (
        <BoundFooter
          busy={busy}
          liveState={liveState}
          onUnbind={() => onUnbind(name)}
          when={binding?.boundAt ?? null}
        />
      ) : channel.available ? (
        <div className="mt-auto flex justify-end pt-1">
          <Button onClick={onConnect} size="sm" type="button">
            <Plus className="size-3.5" />
            {copy.connect}
          </Button>
        </div>
      ) : (
        <div className="mt-auto flex justify-end pt-1">
          <span className="rounded-full bg-muted px-2 py-0.5 text-[0.66rem] font-medium text-muted-foreground">
            {copy.comingSoon}
          </span>
        </div>
      )}
    </div>
  )
}

function BoundFooter({
  busy,
  liveState,
  onUnbind,
  when
}: {
  busy: boolean
  liveState: string | undefined
  onUnbind: () => void
  when: number | null
}) {
  const { t } = useI18n()
  const copy = t.imEntry
  const status = liveStatus(liveState, copy)
  const whenLabel = when ? copy.connectedOn(new Date(when).toLocaleDateString()) : copy.connectedBadge

  return (
    <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/40 pt-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[0.7rem] font-medium">
          <StatusDot tone={status.tone} />
          {status.label}
        </span>
        <span className="truncate text-[0.66rem] text-muted-foreground">{whenLabel}</span>
      </div>
      <Button
        className="shrink-0 hover:text-destructive"
        disabled={busy}
        onClick={onUnbind}
        size="sm"
        type="button"
        variant="ghost"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        {copy.unbind}
      </Button>
    </div>
  )
}
