'use client'

import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useState } from 'react'

import type { DesktopCreatorTip } from '@/global'
import { useI18n } from '@/i18n'
import { Lightbulb, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $creatorTipByTurn,
  $creatorTipsCatalog,
  $creatorTipsTurnedOffIn,
  claimCreatorTip,
  CREATOR_TIP_DELAY_MS,
  dismissCreatorTip,
  loadCreatorTips
} from '@/store/creator-tips'
import { $tipsEnabled, setTipsEnabled } from '@/store/tips'

import { CREATOR_TIP_COPY, creatorTipText } from './creator-tip-copy'
import { isSlowTool, type ProcessStep, type TurnProcess } from './turn-process'

/**
 * hc-995: a creator tip under the process status line, where the slow-step
 * hint sits.
 *
 * Once the step in progress has run 6 seconds, the turn claims a tip for it
 * (store/creator-tips.ts decides which, and whether one is left today). The tip
 * stays with its turn: it carries on through later steps and, quieter, after
 * the task is done; a stuck task shows its failure card alone. ✕ closes it in
 * this turn; 「不再显示小贴士」 is the 应用内提示 switch. Developer mode, tips
 * off, no catalog or no tip for these steps: the slow-step hint as before.
 */

interface CreatorTipSlotProps {
  current: null | ProcessStep
  devMode: boolean
  /** The process block's link-button and caption styles, so the row matches its neighbours. */
  linkClassName: string
  noteClassName: string
  process: TurnProcess
  slowHint: string
  turnKey: string
}

export function CreatorTipSlot({
  current,
  devMode,
  linkClassName,
  noteClassName,
  process,
  slowHint,
  turnKey
}: CreatorTipSlotProps) {
  const enabled = useStore($tipsEnabled)
  const catalog = useStore($creatorTipsCatalog)
  const claimed = useStore($creatorTipByTurn)[turnKey]
  const turnedOffHere = useStore($creatorTipsTurnedOffIn) === turnKey
  const runningKey = process.phase === 'running' && current?.state === 'running' ? current.key : null
  const [ripeKey, setRipeKey] = useState<null | string>(null)
  const ripe = runningKey !== null && ripeKey === runningKey

  const steps = useMemo(
    () => (process.current === null ? [] : process.steps.slice(0, process.current + 1).map(step => step.toolName)),
    [process]
  )

  useEffect(() => {
    void loadCreatorTips()
  }, [])

  useEffect(() => {
    if (!runningKey) {
      return undefined
    }

    const timer = window.setTimeout(() => setRipeKey(runningKey), CREATOR_TIP_DELAY_MS)

    return () => window.clearTimeout(timer)
  }, [runningKey])

  useEffect(() => {
    if (ripe && enabled && !devMode && catalog.length > 0) {
      claimCreatorTip(turnKey, steps)
    }
  }, [catalog, devMode, enabled, ripe, steps, turnKey])

  const shown =
    !devMode && enabled && claimed && !claimed.dismissed && (process.phase === 'running' || process.phase === 'done')
      ? catalog.find(tip => tip.id === claimed.tipId)
      : undefined

  if (turnedOffHere && !enabled) {
    return <TurnedOffNote noteClassName={noteClassName} />
  }

  if (shown) {
    return (
      <CreatorTipRow
        linkClassName={linkClassName}
        live={process.phase === 'running'}
        noteClassName={noteClassName}
        tip={shown}
        turnKey={turnKey}
      />
    )
  }

  if (process.phase === 'running' && current && isSlowTool(current.toolName)) {
    return (
      <p className={cn(noteClassName, 'm-0 ps-5')} data-process-slow-hint="">
        {slowHint}
      </p>
    )
  }

  return null
}

function CreatorTipRow({
  linkClassName,
  live,
  noteClassName,
  tip,
  turnKey
}: {
  linkClassName: string
  live: boolean
  noteClassName: string
  tip: DesktopCreatorTip
  turnKey: string
}) {
  const { locale } = useI18n()
  const copy = CREATOR_TIP_COPY[locale]

  return (
    <div
      className={cn('flex min-w-0 items-start gap-1.5 ps-5', !live && 'opacity-75')}
      data-creator-tip={tip.id}
      data-state={live ? 'live' : 'settled'}
    >
      <Lightbulb aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-(--ui-text-tertiary)" />
      <p className={cn(noteClassName, 'm-0 min-w-0 flex-1')}>
        <span className="font-medium text-(--ui-text-secondary)">{copy.label}</span> {creatorTipText(tip, locale)}
      </p>
      <button
        className={linkClassName}
        onClick={() => {
          $creatorTipsTurnedOffIn.set(turnKey)
          setTipsEnabled(false)
        }}
        type="button"
      >
        {copy.turnOffAll}
      </button>
      <button
        aria-label={copy.close}
        className="grid size-5 shrink-0 place-items-center rounded-sm text-(--ui-text-tertiary) transition-colors hover:text-(--ui-text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onClick={() => dismissCreatorTip(turnKey)}
        type="button"
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </div>
  )
}

function TurnedOffNote({ noteClassName }: { noteClassName: string }) {
  const { locale, t } = useI18n()
  const path = [t.settings.title, t.settings.sections.appearance, t.settings.appearance.tipsTitle].join(' › ')

  return (
    <p className={cn(noteClassName, 'm-0 ps-5')} data-creator-tips-off="" role="status">
      {CREATOR_TIP_COPY[locale].turnedOff(path)}
    </p>
  )
}
