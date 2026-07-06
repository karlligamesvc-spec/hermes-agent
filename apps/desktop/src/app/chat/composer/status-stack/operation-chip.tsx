import { useStore } from '@nanostores/react'
import { memo } from 'react'

import { Button } from '@/components/ui/button'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { AlertTriangle, Globe, Monitor, Square } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $activeOperationBySession } from '@/store/active-operation'

interface OperationChipProps {
  sessionId: null | string
  /** Interrupt the running turn — the only real stop the runtime exposes
   *  (session.interrupt). Halting the turn halts the browser/desktop activity. */
  onStop?: () => void
}

/**
 * Global "the agent is driving a real surface" indicator (hc-418).
 *
 * Pinned at the top of the status stack whenever a browser_* or computer_use
 * tool is live for this session. Two severities:
 *   • browser  — a neutral accent chip (the agent is acting in a headless page)
 *   • computer — a loud amber warning bar (the agent is controlling the REAL
 *     desktop; higher stakes, so it gets a stronger visual + a warning line).
 *
 * The Stop control maps to the existing turn interrupt — the runtime has no
 * per-tool cancel, so stopping the turn is how you stop the operation. When no
 * operation is live the component renders nothing (⑤ zero-noise when idle).
 */
export const OperationChip = memo(function OperationChip({ onStop, sessionId }: OperationChipProps) {
  const { t } = useI18n()
  const copy = t.operationStatus
  const opBySession = useStore($activeOperationBySession)
  const op = sessionId ? opBySession[sessionId] : undefined

  if (!op) {
    return null
  }

  const isComputer = op.surface === 'computer'
  const label = isComputer ? copy.computerActive : copy.browserActive
  const detail = op.target

  return (
    <div
      className={cn(
        'mx-1 my-0.5 flex items-center gap-2 rounded-lg border px-2.5 py-1.5',
        isComputer
          ? 'border-amber-500/50 bg-amber-500/12 text-amber-900 dark:text-amber-100'
          : 'border-sky-500/35 bg-sky-500/10 text-sky-900 dark:text-sky-100'
      )}
      data-slot="operation-chip"
      data-surface={op.surface}
      role="status"
    >
      <span aria-hidden className="grid size-4 shrink-0 place-items-center">
        {isComputer ? (
          <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
        ) : (
          <Globe className="size-4 text-sky-600 dark:text-sky-400" />
        )}
      </span>

      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="flex items-center gap-1.5 text-[0.73rem] font-medium">
          {label}
          <GlyphSpinner
            ariaLabel={copy.running}
            className={cn('text-[0.8rem]', isComputer ? 'text-amber-600/80' : 'text-sky-600/80')}
            spinner="braille"
          />
        </span>
        {detail && (
          <span className="min-w-0 truncate text-[0.66rem] opacity-80" title={detail}>
            {isComputer ? <Monitor aria-hidden className="mr-1 inline size-3 align-[-1px]" /> : null}
            {detail}
          </span>
        )}
        {isComputer && <span className="text-[0.62rem] font-semibold opacity-90">{copy.computerWarning}</span>}
      </div>

      {onStop && (
        <Tip label={copy.stop}>
          <Button
            aria-label={copy.stop}
            className={cn(
              '-my-0.5 h-6 shrink-0 gap-1 rounded-md px-2 text-[0.68rem] font-medium',
              isComputer
                ? 'bg-amber-600/15 text-amber-800 hover:bg-amber-600/25 dark:text-amber-100'
                : 'bg-sky-600/15 text-sky-800 hover:bg-sky-600/25 dark:text-sky-100'
            )}
            onClick={event => {
              event.stopPropagation()
              onStop()
            }}
            size="xs"
            type="button"
            variant="ghost"
          >
            <Square className="size-3" />
            {copy.stop}
          </Button>
        </Tip>
      )}
    </div>
  )
})
