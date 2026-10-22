/**
 * hc-1016 记得你 v1: renderer-side types and helpers for the account's memory
 * ledger (electron/apex-memory-ledger.ts holds the main-process leg).
 *
 * The bridge is typed here rather than in global.d.ts, which is at its size cap.
 * Everything here is inert unless `desktop_features.single_thread` is on.
 */

import { loadSingleThreadFlag } from '@/store/single-thread'

export const MEMORY_KINDS = ['about_you', 'recent'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export interface DesktopMemoryEntry {
  content: string
  createdAt: string
  id: string
  kind: MemoryKind
  source: string
}

export interface DesktopMemoryLedger {
  aboutYou: DesktopMemoryEntry[]
  limits: { aboutYouMax: number; contentMaxChars: number; recentKeepDays: number; recentMax: number }
  recent: DesktopMemoryEntry[]
}

export type DesktopMemoryLedgerRequest =
  | { action: 'add'; content: string; kind: MemoryKind }
  | { action: 'edit'; content: string; id: string }
  | { action: 'get' }
  | { action: 'off' }
  | { action: 'remove'; id: string }

export interface DesktopMemoryLedgerResult {
  code?: string
  created?: boolean
  entry?: DesktopMemoryEntry
  ledger: DesktopMemoryLedger | null
  message?: 'FETCH_FAILED' | 'INVALID' | 'NOT_FOUND' | 'NOT_SIGNED_IN' | 'SESSION_EXPIRED'
  needsSignIn?: boolean
  ok: boolean
}

export type MemoryLedgerBridge = (request: DesktopMemoryLedgerRequest) => Promise<DesktopMemoryLedgerResult>

/** The main-process bridge, or undefined on an older main process (the feature then stays hidden). */
export function memoryLedgerBridge(): MemoryLedgerBridge | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  return (window.hermesDesktop?.managed as undefined | { memoryLedger?: MemoryLedgerBridge })?.memoryLedger
}

/**
 * Whether the one-thread assistant's switch is on (hc-1014's reader: the admin
 * client config's `desktop_features.single_thread`, or this install's
 * APEXNODES_SINGLE_THREAD). The ledger itself follows the switch; its visible
 * surfaces also stay out of 开发者模式 ($singleThreadMode). Never throws.
 */
export async function singleThreadOn(): Promise<boolean> {
  try {
    return await loadSingleThreadFlag()
  } catch {
    return false
  }
}

/** A newly remembered entry the assistant wrote this turn (a 记下了 line). */
export interface MemoryNote {
  content: string
  id: string
  kind: MemoryKind
}

interface ToolPartLike {
  args?: unknown
  result?: unknown
  toolName?: string
  type?: string
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

/** The apex_memory call a part carries: direct, or one call through the tool_call bridge. */
function memoryCallArgs(part: ToolPartLike): Record<string, unknown> | null {
  if (part.toolName === 'apex_memory') {
    return record(part.args)
  }

  if (part.toolName !== 'tool_call') {
    return null
  }

  const args = record(part.args)
  const calls = Array.isArray(args.calls) ? args.calls : [args]
  const call = calls.length === 1 ? record(calls[0]) : {}

  return call.name === 'apex_memory' ? record(call.arguments) : null
}

/**
 * The entries a message's tool parts newly remembered: successful apex_memory
 * adds whose result says `created` (a sentence already remembered is not news).
 */
export function memoryNotesFromParts(parts: readonly unknown[] | undefined): MemoryNote[] {
  const notes: MemoryNote[] = []

  for (const raw of parts ?? []) {
    const part = raw as ToolPartLike

    if (part?.type !== 'tool-call') {
      continue
    }

    const args = memoryCallArgs(part)
    const result = record(part.result)
    const entry = record(result.entry)
    const kind = MEMORY_KINDS.find(value => value === entry.kind)

    if (!args || args.action !== 'add' || result.ok !== true || result.created !== true || !kind) {
      continue
    }

    if (typeof entry.id === 'string' && typeof entry.content === 'string' && entry.content.trim()) {
      notes.push({ content: entry.content.trim(), id: entry.id, kind })
    }
  }

  return notes
}
