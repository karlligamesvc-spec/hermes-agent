/**
 * Composer focus + external-insert bus.
 *
 * Mutations from outside the composer (sidebar attach, drag drop, terminal
 * Cmd+L, preview console, etc.) dispatch through here. Each composer subscribes
 * and routes the work back into its own ref/state.
 *
 * `dispatch` defers to a macrotask so synchronous click/keydown handlers
 * (react-arborist row focus, picker `node.select()`) finish first and don't
 * steal focus from the composer effect.
 */

import type { InlineRefInput } from './inline-refs'
import { RICH_INPUT_SLOT } from './rich-editor'

export type ComposerTarget = 'edit' | 'main'
export type ComposerInsertMode = 'block' | 'inline'

interface FocusDetail {
  target: ComposerTarget
}

interface InsertDetail {
  mode: ComposerInsertMode
  target: ComposerTarget
  text: string
}

interface InsertRefsDetail {
  refs: InlineRefInput[]
  target: ComposerTarget
}

interface SubmitDetail {
  text: string
}

const FOCUS_EVENT = 'hermes:composer-focus'
const INSERT_EVENT = 'hermes:composer-insert'
const INSERT_REFS_EVENT = 'hermes:composer-insert-refs'
const SUBMIT_EVENT = 'hermes:composer-submit'

let activeTarget: ComposerTarget = 'main'

const resolve = (target: ComposerTarget | 'active') => (target === 'active' ? activeTarget : target)

const dispatch = <T>(name: string, detail: T) => {
  if (typeof window === 'undefined') {
    return
  }

  window.setTimeout(() => window.dispatchEvent(new CustomEvent<T>(name, { detail })), 0)
}

const subscribe = <T>(name: string, handler: (detail: T) => void) => {
  if (typeof window === 'undefined') {
    return () => undefined
  }

  const listener = (event: Event) => {
    const detail = (event as CustomEvent<T>).detail

    if (detail) {
      handler(detail)
    }
  }

  window.addEventListener(name, listener)

  return () => window.removeEventListener(name, listener)
}

export const markActiveComposer = (target: ComposerTarget) => {
  activeTarget = target
}

export const requestComposerFocus = (target: ComposerTarget | 'active' = 'active') =>
  dispatch<FocusDetail>(FOCUS_EVENT, { target: resolve(target) })

export const requestComposerInsert = (
  text: string,
  { mode = 'block', target = 'active' }: { mode?: ComposerInsertMode; target?: ComposerTarget | 'active' } = {}
) => {
  const trimmed = text.trim()

  if (!trimmed) {
    return
  }

  dispatch<InsertDetail>(INSERT_EVENT, { mode, target: resolve(target), text: trimmed })
}

export const onComposerFocusRequest = (handler: (target: ComposerTarget) => void) =>
  subscribe<FocusDetail>(FOCUS_EVENT, ({ target }) => handler(target))

export const onComposerInsertRequest = (handler: (detail: InsertDetail) => void) =>
  subscribe<InsertDetail>(INSERT_EVENT, handler)

/** Insert typed ref chips (carrying a display label) into a composer — the
 * structured cousin of {@link requestComposerInsert}, used for session links. */
export const requestComposerInsertRefs = (
  refs: InlineRefInput[],
  { target = 'active' }: { target?: ComposerTarget | 'active' } = {}
) => {
  if (refs.length) {
    dispatch<InsertRefsDetail>(INSERT_REFS_EVENT, { refs, target: resolve(target) })
  }
}

export const onComposerInsertRefsRequest = (handler: (detail: InsertRefsDetail) => void) =>
  subscribe<InsertRefsDetail>(INSERT_REFS_EVENT, handler)

/**
 * Submit `text` as a fresh user turn from outside the composer — the send-now
 * cousin of {@link requestComposerInsert} (which only prefills). Used by inline
 * message-stream controls that stand in for the user, such as a generation
 * ladder card's priced button: tapping it *is* the turn, so it sends straight
 * through the active session's submit path rather than seeding the input.
 */
export const requestComposerSubmit = (text: string) => {
  const trimmed = text.trim()

  if (trimmed) {
    dispatch<SubmitDetail>(SUBMIT_EVENT, { text: trimmed })
  }
}

export const onComposerSubmitRequest = (handler: (text: string) => void) =>
  subscribe<SubmitDetail>(SUBMIT_EVENT, ({ text }) => handler(text))

/**
 * Focus a composer input across React commit + browser focus restore.
 *
 * The triple-call survives:
 *   - sync: contenteditable already mounted
 *   - rAF:  React just committed a `renderComposerContents` swap
 *   - 0ms:  browser focus reclaim from a click target inside an external panel
 */
export const focusComposerInput = (el: HTMLElement | null) => {
  if (!el) {
    return
  }

  const focus = () => el.focus({ preventScroll: true })

  focus()
  window.requestAnimationFrame(focus)
  window.setTimeout(focus, 0)
}

/** Drop focus from the main composer input (status-stack chrome, sidebar, etc.). */
export const blurComposerInput = () => {
  const el = document.querySelector(`[data-slot="${RICH_INPUT_SLOT}"]`) as HTMLElement | null

  if (el && document.activeElement === el) {
    el.blur()
  }
}
