/**
 * hc-1219 剪映 drafts: the engine's `jianying_draft` tool writes the finished cut
 * as a draft in 剪映专业版; its result becomes a card with 「在剪映中打开」
 * (components/chat/jianying-draft-card.tsx). This file reads that result, from
 * the tool part directly (live) or through the `tool_call` bridge (a reloaded
 * transcript keeps the bridge the model called), and knows which 剪映 versions
 * APEX has checked a draft on.
 */

import { isRemoteGateway } from '@/lib/media'

export const JIANYING_TOOL = 'jianying_draft'

/**
 * 剪映 versions a draft was opened and exported on, per platform. Another
 * version still gets its card and button (hc-1219: prompt, don't block);
 * the card only says APEX has not checked it there. Add a version only after
 * that real test: the draft format is 剪映's own and changes without notice.
 */
export const VERIFIED_JIANYING_VERSIONS: Readonly<Record<string, readonly string[]>> = {
  darwin: ['11.7.0'],
  win32: []
}

export interface JianyingDraftCard {
  folder: string
  name: string
  platform: string
  /** Why 剪映 did not take the draft in, when it was open and did not. */
  problem: string | null
  /** True: on 剪映's home page. False: 剪映 was open and did not list it. Null: 剪映 was closed. */
  registered: boolean | null
  seconds: number
  shots: number
  subtitles: number
  version: string
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value))
    } catch {
      return {}
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Whether a tool part is a `jianying_draft` call, direct or as the one call through `tool_call`. */
export function isJianyingDraftCall(toolName: string | undefined, args: unknown): boolean {
  if (toolName === JIANYING_TOOL) {
    return true
  }

  if (toolName !== 'tool_call') {
    return false
  }

  const bridge = record(args)
  const calls = Array.isArray(bridge.calls) ? bridge.calls : [bridge]

  return calls.length === 1 && record(calls[0]).name === JIANYING_TOOL
}

/** The card a written draft gets, or null for an error, a pending call or anything else. */
export function jianyingDraftFromResult(result: unknown): JianyingDraftCard | null {
  const body = record(result)
  const draft = record(body.draft)
  const app = record(body.jianying)

  if (body.status !== 'written' || typeof draft.name !== 'string' || typeof draft.folder !== 'string') {
    return null
  }

  const registered = app.registered === true ? true : app.registered === false ? false : null

  return {
    folder: draft.folder,
    name: draft.name,
    platform: typeof app.platform === 'string' ? app.platform : '',
    problem: typeof body.problem === 'string' && body.problem ? body.problem : null,
    registered,
    seconds: Number(draft.seconds) || 0,
    shots: Number(draft.shots) || 0,
    subtitles: Number(draft.subtitles) || 0,
    version: typeof app.version === 'string' ? app.version : ''
  }
}

export function jianyingVersionVerified(platform: string, version: string): boolean {
  return Boolean(version) && (VERIFIED_JIANYING_VERSIONS[platform] ?? []).includes(version)
}

export type JianyingOpenResult =
  | { ok: true; listed: boolean }
  | { ok: false; reason: 'launch_failed' | 'not_a_draft' | 'not_installed' | 'unsupported' }

interface JianyingBridge {
  openInJianying?: (folder: string) => Promise<JianyingOpenResult>
}

function bridge(): JianyingBridge | undefined {
  return window.hermesDesktop as unknown as JianyingBridge | undefined
}

/** The draft is on this computer and main can start 剪映: not for a remote engine's drafts. */
export function canOpenInJianying(): boolean {
  return typeof bridge()?.openInJianying === 'function' && !isRemoteGateway()
}

export async function openInJianying(folder: string): Promise<JianyingOpenResult> {
  const open = bridge()?.openInJianying

  if (!open) {
    return { ok: false, reason: 'unsupported' }
  }

  try {
    return await open(folder)
  } catch {
    return { ok: false, reason: 'launch_failed' }
  }
}
