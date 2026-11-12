/**
 * Composer contribution surface — every seam of the composer is hook-into-able
 * through the SAME registry schema as every other surface (statusbar, titlebar,
 * panes, layouts):
 *
 *   render areas (`render`):  composer.top       — banner strip above the input
 *                             composer.bottom    — row below the input grid
 *                             composer.underside — floating strip BELOW the
 *                                                  whole composer (no chrome)
 *                             composer.leading   — inline after the "+" menu
 *                             composer.actions   — inline before the model pill
 *
 *   data kinds (`data`):      composer.middleware    (ComposerMiddleware)
 *                             composer.attachments   (ComposerAttachmentProvider)
 *                             composer.microActions  (ComposerMicroActionProvider)
 *
 * Core keeps ownership of the transcript, input, and submit engine — these
 * seams AUGMENT the composer, they never replace it. Middleware runs as an
 * ordered async chain around the app's onSubmit: each handler may rewrite the
 * draft, pass it through, or cancel the send by returning null.
 */

import { useMemo } from 'react'

import { useContributions } from '@/contrib/react/use-contributions'
import { registry } from '@/contrib/registry'
import type { TodoItem } from '@/lib/todos'
import type { ComposerAttachment } from '@/store/composer'
import type { ComposerAction } from '@/store/composer-actions'

export const COMPOSER_AREAS = {
  top: 'composer.top',
  bottom: 'composer.bottom',
  underside: 'composer.underside',
  leading: 'composer.leading',
  actions: 'composer.actions',
  middleware: 'composer.middleware',
  attachments: 'composer.attachments',
  microActions: 'composer.microActions',
  atCompletions: 'composer.atCompletions'
} as const

export interface ComposerDraft {
  text: string
  attachments?: ComposerAttachment[]
  /**
   * Set when the send carries more than its words to the app's submit — a
   * queued entry's target, a display kind or text, a voice-live turn. Such a
   * send can be rewritten, passed on or cancelled, never taken over
   * ({@link COMPOSER_SEND_TAKEN}): whoever sent it later would not have those.
   */
  bound?: true
}

/**
 * A middleware's answer for a send it took over: it keeps the words and sends
 * them itself later (or hands them back). The composer clears as for a sent
 * message; the rest of the chain and the app's submit do not run.
 */
export const COMPOSER_SEND_TAKEN: unique symbol = Symbol('composer-send-taken')

/**
 * hc-1226: a middleware's answer for a send it carried out itself (a command it
 * handles in place, such as the one thread's `/new`): nothing is left to send.
 * The composer clears as for a sent message and a queued entry leaves the
 * queue; the rest of the chain and the app's submit do not run. Unlike
 * {@link COMPOSER_SEND_TAKEN} it stands for a `bound` draft too: nobody sends
 * it later, so nothing its options carry is lost. A command that could not be
 * carried out is a cancel (null), which keeps its words where they were.
 */
export const COMPOSER_SEND_DONE: unique symbol = Symbol('composer-send-done')

export type ComposerMiddlewareResult = ComposerDraft | null | typeof COMPOSER_SEND_DONE | typeof COMPOSER_SEND_TAKEN

/** Payload of a `composer.middleware` data contribution. */
export interface ComposerMiddleware {
  /** Rewrite (return a draft), pass through (same draft), cancel (null), take it over, or carry it out. */
  handler: (draft: ComposerDraft) => ComposerMiddlewareResult | Promise<ComposerMiddlewareResult>
}

/** The submit options the composer passes beside the words alone; anything else makes a draft `bound`. */
const UNBOUND_SUBMIT_OPTIONS: ReadonlySet<string> = new Set(['attachments', 'composerScope'])

/** The draft a send's words and options give the middleware chain. */
export function composerDraftFor(text: string, options?: { attachments?: ComposerAttachment[] }): ComposerDraft {
  const bound = Object.entries(options ?? {}).some(
    ([key, value]) => value !== undefined && !UNBOUND_SUBMIT_OPTIONS.has(key)
  )

  return { text, attachments: options?.attachments, ...(bound ? { bound: true } : {}) }
}

/** One row a `composer.atCompletions` source offers for the current query. */
export interface ComposerAtCompletionItem {
  /** Text inserted into the draft when picked (e.g. `@researcher`). */
  insert: string
  /** Row label; defaults to `insert`. */
  display?: string
  /** Secondary line (e.g. "Bot · Homelab"). */
  meta?: string
  /** Icon slug understood by the completion popover; defaults to 'simple'. */
  icon?: string
}

/** Payload of a `composer.atCompletions` data contribution — an extra source
 *  merged into the composer's `@` popover ABOVE the path/reference results.
 *  `query` is the text typed after `@` (no leading `@`). Sources must be
 *  fast and synchronous-ish (called per keystroke after the debounce); slow
 *  lookups belong behind the source's own cache. */
export interface ComposerAtCompletionSource {
  provide: (query: string) => ComposerAtCompletionItem[]
}

export interface ComposerAttachmentContext {
  insertText: (text: string) => void
}

/** Payload of a `composer.attachments` data contribution — an entry in the
 *  composer's "+" attach menu. */
export interface ComposerAttachmentProvider {
  label: string
  /** Codicon name for the menu row. Defaults to `plug`. */
  icon?: string
  run: (ctx: ComposerAttachmentContext) => void | Promise<void>
}

/**
 * Run the ordered middleware chain over a draft. Contributions execute in
 * registry order (`order`, then registration order); the first `null` wins
 * and cancels the send, the first {@link COMPOSER_SEND_TAKEN} takes it over
 * (for a `bound` draft that is a cancel), the first {@link COMPOSER_SEND_DONE}
 * ends it as carried out. A throwing handler is treated as pass-through so a
 * broken plugin can't eat messages.
 */
export async function runComposerMiddleware(draft: ComposerDraft): Promise<ComposerMiddlewareResult> {
  let current = draft

  for (const contribution of registry.getArea(COMPOSER_AREAS.middleware)) {
    const middleware = contribution.data as ComposerMiddleware | undefined

    if (!middleware?.handler) {
      continue
    }

    try {
      const next = await middleware.handler(current)

      if (next === COMPOSER_SEND_DONE) {
        return next
      }

      if (next === COMPOSER_SEND_TAKEN) {
        return current.bound ? null : next
      }

      if (next === null) {
        return null
      }

      current = next
    } catch {
      // Pass-through: a faulty middleware must never swallow the message.
    }
  }

  return current
}

/**
 * A send through the chain, then the app's submit with the draft the chain
 * left: false when a middleware cancelled it; true, without submitting, when
 * one took it over (it sends it later itself) or carried it out, so the
 * composer clears.
 */
export async function submitThroughComposerMiddleware<Options extends { attachments?: ComposerAttachment[] }>(
  text: string,
  options: Options | undefined,
  submit: (text: string, options: Options & { attachments?: ComposerAttachment[] }) => Promise<boolean> | boolean
): Promise<boolean> {
  const draft = await runComposerMiddleware(composerDraftFor(text, options))

  if (draft === COMPOSER_SEND_TAKEN || draft === COMPOSER_SEND_DONE) {
    return true
  }

  if (!draft) {
    return false
  }

  return submit(draft.text, { ...(options as Options), attachments: draft.attachments })
}

/** Attach-menu entries contributed by plugins/core, with stable render keys. */
export function useComposerAttachmentProviders(): Array<ComposerAttachmentProvider & { key: string }> {
  return useContributions(COMPOSER_AREAS.attachments)
    .map(c => ({ key: `${c.source ?? 'core'}:${c.id}`, ...(c.data as ComposerAttachmentProvider) }))
    .filter(p => Boolean(p.label && p.run))
}

/**
 * Payload of a `composer.microActions` data contribution — the pill strip at
 * the top of the composer's overlay lane.
 *
 * `resolve` is called with the live session context and returns the badges to
 * show right now, or `[]` for "nothing from me". Returning a list rather than
 * a static badge is what lets a provider be conditional ("only while idle",
 * "only with unfinished tasks") without a reactive `when()`, which the
 * registry deliberately doesn't offer.
 */
export interface ComposerMicroActionProvider {
  resolve: (ctx: ComposerMicroActionContext) => ComposerAction[]
}

/** What a micro-action provider gets to branch on. Deliberately small: every
 *  field here is a standing compatibility promise to the plugins using it. */
export interface ComposerMicroActionContext {
  /** A turn is currently running in this session. */
  busy: boolean
  sessionId: string
  /** Live todo list for the session (empty when there is none). */
  todos: readonly TodoItem[]
}

/** Micro-action providers, memoised against the registry's own stable
 *  snapshot — the strip re-resolves on every composer render, so a fresh array
 *  here would defeat that. */
export function useComposerMicroActionProviders(): ComposerMicroActionProvider[] {
  const contributions = useContributions(COMPOSER_AREAS.microActions)

  return useMemo(
    () => contributions.map(c => c.data as ComposerMicroActionProvider).filter(p => typeof p?.resolve === 'function'),
    [contributions]
  )
}
