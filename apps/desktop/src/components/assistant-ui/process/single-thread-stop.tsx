'use client'

import { useStore } from '@nanostores/react'
import type { FC } from 'react'

import { useThreadSessionStatus } from '@/components/assistant-ui/thread/status'
import { Tip } from '@/components/ui/tooltip'
import { useSingleThreadComposerCopy } from '@/i18n/single-thread-composer'
import { $threadStop } from '@/store/single-thread-stop'

/**
 * hc-1060 (N5, Kael 2026-10-26): the small 「停」 at the end of the activity
 * line. In single-thread mode the composer keeps taking messages while APEX
 * works, so the Stop button that used to take the Send slot lives here. It
 * halts the turn exactly as that button did (the main composer publishes the
 * halt, store/single-thread-stop.ts); Esc and 「停一下」 do the same. The
 * background-task strip and its own stop are G5's.
 */
export const SingleThreadStopButton: FC = () => {
  const copy = useSingleThreadComposerCopy()
  const stop = useStore($threadStop)
  const { busy } = useThreadSessionStatus()

  if (!busy || !stop) {
    return null
  }

  return (
    <Tip label={copy.stopLabel}>
      <button
        aria-label={copy.stopLabel}
        className="ml-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground"
        data-single-thread-stop=""
        onClick={stop}
        type="button"
      >
        <span aria-hidden="true" className="block size-2 rounded-[2px] bg-current" />
        <span>{copy.stop}</span>
      </button>
    </Tip>
  )
}
