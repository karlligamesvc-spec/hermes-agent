/**
 * hc-1116: the timeline rows the engine writes, in single-thread product mode.
 *
 * A model or personality switch, a turn resumed after a crash, and background
 * work that ended come back as their own rows when a conversation is opened
 * again. Upstream labels them in English ("resumed interrupted turn") or shows
 * the engine's English line, which names the command ("Background Process
 * Finished: ffmpeg …"). In product mode they read in the app's language and
 * name no command; the report under a background row is unchanged. Developer
 * mode and single_thread off keep upstream's labels.
 */

import { singleThreadUpstreamCopyNow } from '@/i18n/single-thread-upstream-copy'
import { isSingleThreadMode } from '@/store/single-thread'
import type { SessionMessage } from '@/types/hermes'

/** The row's label in product mode; undefined anywhere else, and for any other row. */
export function productTimelineLabel(
  kind: SessionMessage['display_kind'],
  taskCount: () => number | undefined
): string | undefined {
  if (!kind || !isSingleThreadMode()) {
    return undefined
  }

  const copy = singleThreadUpstreamCopyNow().timeline

  switch (kind) {
    case 'model_switch':
      return copy.modelSwitch

    case 'auto_continue':
      return copy.autoContinue

    case 'personality_switch':
      return copy.personalitySwitch

    case 'async_delegation_complete':
      return copy.backgroundTasks(taskCount())

    case 'process_complete':
      return copy.backgroundProcess

    default:
      return undefined
  }
}
