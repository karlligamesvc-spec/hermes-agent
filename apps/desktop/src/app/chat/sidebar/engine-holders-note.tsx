import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { DesktopEngineHolder, DesktopShellUpdateState } from '@/global'
import { type DesktopUpdateCopy, type EngineHoldersThen, useDesktopUpdateCopy } from '@/i18n/desktop-update'
import { applyDesktopUpdates } from '@/store/desktop-update'
import { endEngineLeftovers } from '@/store/shell-update'

function holderName(copy: DesktopUpdateCopy, holder: DesktopEngineHolder): string {
  return holder.kind === 'other' ? copy.holders.names.other(holder.name) : copy.holders.names[holder.kind]
}

/** Each name once, in the order the gate reported its holders, with the PIDs it covers. */
function namedGroups(copy: DesktopUpdateCopy, holders: DesktopEngineHolder[]): Map<string, number[]> {
  const groups = new Map<string, number[]>()

  for (const holder of holders) {
    const name = holderName(copy, holder)
    groups.set(name, [...(groups.get(name) ?? []), holder.pid])
  }

  return groups
}

/** Ending helps only when every holder is APEX's own leftover with a known start time. */
function allEndable(holders: DesktopEngineHolder[]): boolean {
  return holders.length > 0 && holders.every(holder => holder.endable && holder.created !== null)
}

function endedCleanly(result: { ended?: Record<string, string>; ok: boolean }): boolean {
  return result.ok && !Object.values(result.ended ?? {}).some(outcome => outcome === 'denied' || outcome === 'survived')
}

/**
 * hc-1094: what holds the APEX engine while an update or engine switch waits, by kind. When all
 * of it is APEX's own leftover, offer to end it: a confirmation lists each process, then the main
 * process ends exactly those (by PID and start time) and `then` runs again through the gate.
 */
export function EngineHoldersNote({
  className,
  holders,
  layer,
  onEnded,
  then
}: {
  className?: string
  holders: DesktopEngineHolder[]
  layer?: number
  onEnded: () => Promise<unknown>
  then: EngineHoldersThen
}) {
  const copy = useDesktopUpdateCopy()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const groups = namedGroups(copy, holders)
  const names = [...groups.keys()]
  const many = names.length > 1
  const endable = allEndable(holders)

  const hint = endable
    ? copy.holders.endable(many)
    : holders.some(holder => holder.kind === 'terminal_hermes')
      ? copy.holders.terminal
      : ''

  const listed = copy.holders.join([...groups].map(([name, pids]) => copy.holders.withPids(name, pids)))

  const gatewayNote = holders.some(holder => holder.kind === 'leftover_gateway')
    ? `${copy.holders.gap}${copy.holders.gatewayNote}`
    : ''

  const onConfirm = async () => {
    if (!endedCleanly(await endEngineLeftovers(holders))) {
      throw new Error(copy.holders.endFailed)
    }

    await onEnded()
  }

  return (
    <>
      <span
        className={className}
        data-holders={holders.map(holder => holder.kind).join(' ')}
        data-testid="desktop-update-deferred"
      >
        {copy.holders.waiting(copy.holders.join(names), many)}
        {hint && `${copy.holders.gap}${hint}`}
      </span>
      {endable && (
        <>
          <Button
            className="self-start"
            data-testid="engine-holders-end"
            onClick={() => setConfirmOpen(true)}
            size="sm"
            type="button"
            variant="textStrong"
          >
            {copy.holders.endAction[then]}
          </Button>
          <ConfirmDialog
            busyLabel={copy.holders.ending}
            confirmLabel={copy.holders.endAction[then]}
            description={`${copy.holders.confirmBody(listed, then)}${gatewayNote}`}
            layer={layer}
            onClose={() => setConfirmOpen(false)}
            onConfirm={onConfirm}
            open={confirmOpen}
            title={copy.holders.confirmTitle}
          />
        </>
      )}
    </>
  )
}

/** The holders a requested app install waits on, when the gate named them; null otherwise. */
export function shellUpdateHolders(shell: DesktopShellUpdateState | null): DesktopEngineHolder[] | null {
  return shell?.deferred && shell.deferredReason === 'engine_holders' && shell.deferredHolders?.length
    ? shell.deferredHolders
    : null
}

/**
 * The About page's update section names the holders too. It shows no other wait, as before
 * hc-1094; the sidebar entry says those.
 */
export function ShellUpdateHoldersNote({ layer, shell }: { layer?: number; shell: DesktopShellUpdateState | null }) {
  const holders = shellUpdateHolders(shell)

  if (!holders) {
    return null
  }

  return (
    <div className="mt-2 flex flex-col items-start gap-1 text-xs text-muted-foreground">
      <EngineHoldersNote holders={holders} layer={layer} onEnded={() => applyDesktopUpdates()} then="install" />
    </div>
  )
}
