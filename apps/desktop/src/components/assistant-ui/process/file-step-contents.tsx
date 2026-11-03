'use client'

import { useStore } from '@nanostores/react'
import { type FC, useEffect, useMemo } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import {
  buildToolView,
  clampForDisplay,
  fileEditBasename,
  fileEditPath,
  inlineDiffFromResult,
  isFileEditTool,
  isPreviewableTarget,
  stripInlineDiffChrome,
  type ToolPart
} from '@/components/assistant-ui/tool/fallback-model'
import { FileDiffPanel } from '@/components/chat/diff-lines'
import { ResultActions } from '@/components/chat/result-actions'
import { FileTypeIcon } from '@/components/ui/file-type-icon'
import { useResultCopy } from '@/i18n/single-thread-results'
import { toolResultRecord, type ToolResultSource } from '@/lib/tool-result-metadata'
import { recordPreviewArtifact } from '@/store/preview-status'
import { $toolInlineDiff } from '@/store/tool-diffs'

import type { ProcessCall, ProcessStep } from './turn-process'
import { useTurnView } from './turn-state'

/**
 * hc-1130: where a file edit goes in single-thread product mode.
 *
 * The chat keeps the result and what the assistant says about it. What it wrote
 * and changed on the way stays one deliberate click away, under the step in the
 * process area: 「看过程」, then 「看内容」. Only edits that landed are listed: a
 * failed one changed nothing, and its step already says it failed.
 */

export function stepFileCalls(step: ProcessStep): ProcessCall[] {
  return step.calls.filter(call => call.state === 'done' && isFileEditTool(call.toolName))
}

/** What a call that came back without a diff wrote. A reloaded `write_file`
 *  keeps only its arguments, and that still is what went into the file. */
function writtenText(args: Record<string, unknown>): string {
  const text = [args.content, args.new_string, args.patch].find(value => typeof value === 'string' && value.trim())

  return typeof text === 'string' ? text : ''
}

const StepFile: FC<{ call: ProcessCall }> = ({ call }) => {
  const copy = useResultCopy()
  const sideDiff = useStore($toolInlineDiff(call.id))
  const result = toolResultRecord(call.part as ToolResultSource)
  const diff = stripInlineDiffChrome(sideDiff) || inlineDiffFromResult(result)
  const path = fileEditPath(call.args, result)
  const name = fileEditBasename(path) || copy.kinds.file
  const text = diff ? '' : writtenText(call.args)

  return (
    <div
      className="grid min-w-0 overflow-hidden rounded-[0.3125rem] border border-(--ui-stroke-tertiary)"
      data-process-file=""
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5">
        <FileTypeIcon className="shrink-0 text-(--ui-text-tertiary)" path={name} size="0.875rem" />
        <span className="min-w-0 flex-1 truncate text-xs text-(--ui-text-secondary)" data-process-file-name="">
          {name}
        </span>
        {path && <ResultActions className="mt-0" kind="file" path={path} />}
      </div>
      {diff && (
        // The same padding a tool row gives its diff: the panel bleeds into it to show its change bars.
        <div className="grid min-w-0 overflow-hidden border-t border-(--ui-stroke-tertiary) p-1.5">
          <FileDiffPanel className="-mt-1.5" diff={diff} path={name} />
        </div>
      )}
      {text && (
        <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap wrap-anywhere border-t border-(--ui-stroke-tertiary) px-2 py-1.5 font-mono text-[0.7rem] leading-relaxed text-(--ui-text-secondary)">
          {clampForDisplay(text)}
        </pre>
      )}
    </div>
  )
}

export const StepFileContents: FC<{ calls: readonly ProcessCall[] }> = ({ calls }) => (
  <div className="ms-5 grid min-w-0 gap-1.5" data-process-files="">
    {calls.map(call => (
      <StepFile call={call} key={call.id || call.toolName} />
    ))}
  </div>
)

/**
 * A file edit's row is what notes an HTML page it wrote for the composer's
 * preview row, and a folded edit has no row. A page the assistant made is a
 * result, so this keeps that chip. Renders nothing.
 */
export const FoldedEditPreviews: FC = () => {
  const steps = useTurnView()?.process.steps
  const { $cwd, $runtimeId } = useSessionView()

  const targets = useMemo(
    () =>
      (steps ?? [])
        .flatMap(stepFileCalls)
        .map(call => buildToolView(call.part as ToolPart, '').previewTarget ?? '')
        .filter(target => target && isPreviewableTarget(target)),
    [steps]
  )

  useEffect(() => {
    const sessionId = $runtimeId.get()

    if (sessionId) {
      targets.forEach(target => recordPreviewArtifact(sessionId, target, $cwd.get() || ''))
    }
  }, [$cwd, $runtimeId, targets])

  return null
}
