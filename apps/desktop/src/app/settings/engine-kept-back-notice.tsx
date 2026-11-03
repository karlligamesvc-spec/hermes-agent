import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { EngineHoldersNote } from '@/app/chat/sidebar/engine-holders-note'
import { Button } from '@/components/ui/button'
import type { DesktopEngineHolder } from '@/global'
import { useI18n } from '@/i18n'
import { describeDesktopUpdateError, desktopUpdateCopyNow } from '@/i18n/desktop-update'
import { useEngineKeptBackCopy } from '@/i18n/engine-kept-back'
import { formatEngineDisplayVersion } from '@/lib/engine-display'
import { AlertTriangle, Loader2 } from '@/lib/icons'
import { $runtimeVersion, switchToBundledEngine } from '@/store/runtime-update'

/**
 * hc-1033: the engine did not update with the app. Before this, the only trace was one desktop.log
 * line, so a machine could run a weeks-old engine under every new app version without anyone knowing.
 */
export function EngineKeptBackNotice() {
  const { t } = useI18n()
  const copy = useEngineKeptBackCopy()
  const keptBack = useStore($runtimeVersion)?.keptBack
  const [switching, setSwitching] = useState(false)
  const [note, setNote] = useState<null | string>(null)
  // hc-1094: a switch waiting on engine holders the gate named says who they are.
  const [holders, setHolders] = useState<DesktopEngineHolder[] | null>(null)

  if (!keptBack) {
    return null
  }

  const bundled = formatEngineDisplayVersion(keptBack.bundledVersion, null, t.common.engineVersionPrefix)

  const onSwitch = async () => {
    setSwitching(true)
    setNote(null)
    setHolders(null)
    const result = await switchToBundledEngine()

    // Armed (or already the shipped engine): the reload runs the install.
    if (result.ok && !result.deferred) {
      window.location.reload()

      return
    }

    setSwitching(false)
    setHolders(result.deferred && result.reason === 'engine_holders' && result.holders?.length ? result.holders : null)
    setNote(result.deferred ? copy.deferred : describeDesktopUpdateError(desktopUpdateCopyNow(), result.error || 'apply_failed'))
  }

  return (
    <div
      className="p5-panel mb-2 flex items-start gap-2 px-4 py-3 text-sm text-destructive"
      data-reason={keptBack.reason}
      data-testid="engine-kept-back-banner"
      data-tone="error"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium">{copy.title}</p>
        <p className="mt-1 text-xs">{copy.detail[keptBack.reason](bundled)}</p>
        <Button className="mt-2" disabled={switching} onClick={() => void onSwitch()} size="sm">
          {switching ? <Loader2 className="size-3 animate-spin" /> : null}
          {switching ? copy.switching : copy.switchAction}
        </Button>
        {holders ? (
          <div className="mt-1 flex flex-col items-start gap-1 text-xs">
            <EngineHoldersNote holders={holders} onEnded={onSwitch} then="switch" />
          </div>
        ) : (
          note && <p className="mt-1 text-xs">{note}</p>
        )}
      </div>
    </div>
  )
}
