import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { type DesktopUpdateCopy, useDesktopUpdateCopy } from '@/i18n/desktop-update'
import { AlertTriangle } from '@/lib/icons'
import { $shellUpdate } from '@/store/shell-update'
import { $runtimeUpdateWait, desktopUpdateWait, type DesktopUpdateWait } from '@/store/update-wait'

import { allEndable, endHolders, endNotes, namedGroups, waitHolders } from './engine-holders-note'

/** Who the update waits for and what the user can do about it, as one paragraph. */
function waitSentences(copy: DesktopUpdateCopy, wait: DesktopUpdateWait): string {
  const holders = waitHolders(wait)
  const { gap } = copy.holders

  if (!holders) {
    return `${copy.deferred[wait.reason]}${gap}${copy.wait.next[wait.reason]}`
  }

  const groups = namedGroups(copy, holders)
  const names = [...groups.keys()]
  const waiting = copy.holders.waiting(copy.holders.join(names), names.length > 1)

  if (allEndable(holders)) {
    const listed = copy.holders.join([...groups].map(([name, pids]) => copy.holders.withPids(name, pids)))

    return `${waiting}${gap}${copy.holders.endable(names.length > 1)}${gap}${copy.holders.confirmBody(listed, 'install')}${endNotes(copy, holders)}`
  }

  const steps = [
    holders.some(holder => holder.kind === 'terminal_hermes') && copy.holders.terminal,
    holders.some(holder => holder.kind === 'other') && copy.wait.closeProgram
  ].filter(Boolean)

  return [waiting, ...(steps.length ? steps : [copy.wait.ownWork])].join(gap)
}

/**
 * hc-1117: the answer to a confirmed install that did not start. It follows the wait as the main
 * process retries, and goes away when the wait ends. When all that holds the engine is APEX's own
 * leftover, the listed PIDs make this the confirmation, and ending them asks to install again.
 */
function DesktopUpdateWaitDialog({ apply, layer, onClose, wait }: { apply: () => Promise<boolean>; layer?: number; onClose: () => void; wait: DesktopUpdateWait }) {
  const copy = useDesktopUpdateCopy()
  const [ending, setEnding] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const holders = waitHolders(wait)
  const endable = holders !== null && allEndable(holders)

  const onEnd = async () => {
    setEnding(true)
    setError(null)

    try {
      await endHolders(copy, holders ?? [])
    } catch (failure) {
      setEnding(false)
      setError(failure instanceof Error ? failure.message : copy.holders.endFailed)

      return
    }

    try {
      await apply()
    } catch {
      // The install overlay shows a failed update; this dialog has nothing to add.
      onClose()
    }

    setEnding(false)
  }

  return (
    <Dialog onOpenChange={value => !value && !ending && onClose()} open>
      <DialogContent className="max-w-md" data-testid="desktop-update-wait" layer={layer}>
        <DialogHeader>
          <DialogTitle>{copy.wait.title}</DialogTitle>
          <DialogDescription>{waitSentences(copy, wait)}</DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          <Button disabled={ending} onClick={onClose} type="button" variant={endable ? 'ghost' : 'default'}>
            {copy.wait.close}
          </Button>
          {endable && (
            <Button data-testid="desktop-update-wait-end" disabled={ending} onClick={() => void onEnd()} type="button">
              {ending ? copy.holders.ending : copy.holders.endAction.install}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The confirmation every update entry opens (sidebar, About page, command center). hc-1117: a
 * confirmed install can wait instead of starting, so it answers then with who it waits for.
 * `apply` asks for the update and says whether it waits.
 */
export function DesktopUpdateConfirmDialog({ apply, layer, onClose, open }: { apply: () => Promise<boolean>; layer?: number; onClose: () => void; open: boolean }) {
  const { t } = useI18n()
  const copy = t.sidebar.desktopUpdate
  const [asked, setAsked] = useState(false)
  const wait = desktopUpdateWait(useStore($shellUpdate), useStore($runtimeUpdateWait))

  const onConfirm = async () => {
    if (!(await apply())) {
      return
    }

    setAsked(true)
    onClose()

    return 'handled' as const
  }

  return (
    <>
      <ConfirmDialog
        busyLabel={copy.installing}
        cancelLabel={t.common.cancel}
        confirmLabel={copy.confirmApply}
        description={copy.confirmBody}
        layer={layer}
        onClose={onClose}
        onConfirm={onConfirm}
        open={open}
        title={copy.confirmTitle}
      />
      {asked && wait && <DesktopUpdateWaitDialog apply={apply} layer={layer} onClose={() => setAsked(false)} wait={wait} />}
    </>
  )
}
