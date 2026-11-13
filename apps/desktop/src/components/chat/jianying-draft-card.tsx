import { useState } from 'react'

import { jianyingSteps, useJianyingDraftCopy } from '@/i18n/jianying-draft'
import { Video } from '@/lib/icons'
import {
  canOpenInJianying,
  type JianyingDraftCard as Draft,
  type JianyingOpenResult,
  jianyingVersionVerified,
  openInJianying
} from '@/lib/jianying-draft'

import { RESULT_ACTION_CLASS } from './result-actions'

/**
 * hc-1219 the 剪映 draft the agent wrote: its name, how long it is, and the one
 * thing left to do — open it in 剪映 and export it there. The folder path never
 * shows. A draft 剪映 did not take in says so and offers no button; a 剪映
 * version APEX has not tried says that too, and still opens (prompt, don't block).
 */
export function JianyingDraftCard({ draft }: { draft: Draft }) {
  const copy = useJianyingDraftCopy()
  const [state, setState] = useState<'idle' | 'opening' | JianyingOpenResult>('idle')
  const notTaken = draft.registered === false
  const canOpen = !notTaken && canOpenInJianying()

  const open = async () => {
    setState('opening')
    setState(await openInJianying(draft.folder))
  }

  const outcome =
    state === 'opening'
      ? copy.opening
      : state === 'idle'
        ? null
        : state.ok
          ? state.listed
            ? copy.opened
            : copy.notListed
          : copy.failed[state.reason]

  return (
    <div
      className="my-3 block max-w-2xl rounded-xl border border-(--ui-stroke-tertiary) bg-muted/35 p-3"
      data-slot="aui_jianying-draft"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Video className="size-3.5 shrink-0" />
        <span className="truncate" data-slot="aui_jianying-draft-title">
          {copy.title(draft.name)}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{copy.meta(draft.seconds, draft.shots, draft.subtitles)}</p>
      {notTaken ? (
        <p className="mt-2 text-sm text-foreground" data-slot="aui_jianying-draft-problem">
          {copy.notTaken}
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-foreground">{jianyingSteps(copy, draft.platform)}</p>
          {draft.registered === null && <p className="mt-1 text-xs text-muted-foreground">{copy.closed}</p>}
          {!jianyingVersionVerified(draft.platform, draft.version) && (
            <p className="mt-1 text-xs text-muted-foreground" data-slot="aui_jianying-draft-unverified">
              {copy.unverified(draft.version)}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{copy.oneWay}</p>
        </>
      )}
      {canOpen && (
        <span className="mt-2 flex flex-wrap items-center gap-2">
          <button
            className={RESULT_ACTION_CLASS}
            disabled={state === 'opening'}
            onClick={() => void open()}
            type="button"
          >
            <Video className="size-3" />
            {copy.open}
          </button>
          {outcome && (
            <span className="text-xs text-muted-foreground" data-slot="aui_jianying-draft-outcome" role="status">
              {outcome}
            </span>
          )}
        </span>
      )}
    </div>
  )
}
