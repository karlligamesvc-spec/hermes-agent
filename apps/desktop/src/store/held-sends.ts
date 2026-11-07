/**
 * hc-1146 发消息半天没反应: messages sent while an assistant's conversation is
 * still opening, held until it is on screen. With several assistants on, the
 * single-thread middleware (app/single-thread/composer-middleware.ts) holds a
 * plain send here instead of handing it back to the composer;
 * app/single-thread/held-send-release.ts sends each one once the thread can
 * take it, and the composer shows them meanwhile (held-sends-strip.tsx).
 *
 * Each message belongs to the assistant that was on screen when it was sent.
 * Switching to another one leaves them waiting for it: they show again, and go
 * out, when that assistant is back on screen. They live in this window's
 * memory only.
 */

import { atom } from 'nanostores'

import type { ComposerAttachment } from '@/store/composer'

export interface HeldSend {
  attachments: readonly ComposerAttachment[]
  /** Epoch ms of the send. */
  at: number
  id: string
  /** The assistant (profile key) it was sent to. */
  profile: string
  text: string
}

/** Every held message, oldest first. */
export const $heldSends = atom<readonly HeldSend[]>([])

let sequence = 0

export function holdSend(
  profile: string,
  draft: { attachments?: readonly ComposerAttachment[]; text: string }
): HeldSend {
  sequence += 1

  const held: HeldSend = {
    attachments: draft.attachments ?? [],
    at: Date.now(),
    id: `held-${sequence}`,
    profile,
    text: draft.text
  }

  $heldSends.set([...$heldSends.get(), held])

  return held
}

/** `profile`'s held messages, oldest first. */
export function heldSendsFor(list: readonly HeldSend[], profile: string): readonly HeldSend[] {
  return list.filter(held => held.profile === profile)
}

/** Take one message out (sent, or withdrawn by the user). Null when it is no longer held. */
export function takeHeldSend(id: string): HeldSend | null {
  const list = $heldSends.get()
  const held = list.find(item => item.id === id) ?? null

  if (held) {
    $heldSends.set(list.filter(item => item.id !== id))
  }

  return held
}

/** Put a message back at the head of its assistant's line (a send that could not go out yet). */
export function rehold(held: HeldSend): void {
  $heldSends.set([held, ...$heldSends.get().filter(item => item.id !== held.id)])
}

/** Drop the messages of assistants that no longer exist (deleted: their thread went with them). */
export function dropHeldSendsOutside(profiles: ReadonlySet<string>): void {
  const list = $heldSends.get()
  const kept = list.filter(held => profiles.has(held.profile))

  if (kept.length !== list.length) {
    $heldSends.set(kept)
  }
}

export function resetHeldSendsForTest(): void {
  $heldSends.set([])
}
