import { singleThreadProcessCopyNow } from '@/i18n/single-thread-process'
import type { StepCopy } from '@/i18n/types-process'
import { isSingleThreadMode } from '@/store/single-thread'
import { botNameForProfile, currentBotNameNow, withBotName } from '@/store/single-thread-bots'

import { approvalPurpose, callIntent, isLookTool, mergedLookTopics, stageProgress } from './step-intent'

/**
 * hc-1066: single-thread product mode names a step by what it is for.
 *
 * The step fold (`buildTurnSteps`) asks this module two things when the mode
 * is on: which consecutive calls are the same step — the same intent, or a run
 * of image looks — and what to call it. Everywhere else it is not asked, and
 * steps keep the tool's own name, grouped by tool, exactly as before.
 */

interface PlainCall {
  args: Record<string, unknown>
  toolName: string
}

/** Consecutive calls with the same key fold into one step. */
export function plainGroupKey(call: PlainCall): string {
  if (isLookTool(call.toolName)) {
    return 'look'
  }

  const intent = callIntent(call.toolName, call.args)

  return intent ? `intent:${intent}` : call.toolName
}

/** A step's words and intent id, or null when its arguments name no purpose. */
export function plainStep(calls: readonly PlainCall[]): null | { copy: StepCopy; intent: string } {
  const copy = singleThreadProcessCopyNow()
  const [first] = calls

  if (isLookTool(first.toolName)) {
    const questions = calls.map(call => (typeof call.args.question === 'string' ? call.args.question : ''))
    const topics = mergedLookTopics(questions).map(topic => copy.topics[topic])

    return topics.length > 0 ? { copy: copy.look(topics.join(copy.topicSeparator)), intent: 'look' } : null
  }

  const intent = callIntent(first.toolName, first.args)

  return intent ? { copy: copy.intents[intent], intent } : null
}

/** The stage progress line, once the task has moved past its first stage. */
export function plainStageLine(steps: readonly { intent?: string; toolName: string }[]): null | string {
  const progress = stageProgress(steps)

  if (!progress || (progress.done.length === 0 && progress.round < 2)) {
    return null
  }

  return singleThreadProcessCopyNow().stageLine(progress)
}

/** The sentence above a command or code waiting on the user's approval, naming
 *  the assistant asking (hc-1077: the one on screen unless `name` says another). */
export function plainApprovalSentence(command: string, description: string, name = currentBotNameNow()): string {
  const copy = singleThreadProcessCopyNow()
  const purpose = approvalPurpose(command, description)

  return withBotName(copy.approval(purpose, purpose.intent ? copy.intents[purpose.intent].title : null), name)
}

/** The body of an approval's system notification: the command itself, or in
 *  single-thread product mode the same sentence the approval bar says — by the
 *  assistant whose engine (`profile`) asked, which may be one in the background. */
export function approvalNotificationBody(command: string, description: string, profile?: string): string {
  return isSingleThreadMode()
    ? plainApprovalSentence(command, description, botNameForProfile(profile))
    : command || description
}
