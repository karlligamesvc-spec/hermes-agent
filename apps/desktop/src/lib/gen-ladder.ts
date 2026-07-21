// Generation-ladder card protocol (`gen-ladder/1`) — the semantic wire contract
// the desktop renders. The platform's `gen_ladder` tool returns one card per
// step as its result; this module models that contract on the client side.
//
// The ladder is a multi-turn generation flow that runs *inside the chat*:
// streaming prose and cards interleave, and each card is a "parking point" where
// a paid step waits for the user to confirm. Spending only ever happens when the
// user taps a priced button. The render layer's whole job is to (1) draw the
// card and (2) send the click back to the agent as an `{action, payload}` — it
// never reprices, never advances the ladder on its own, never surfaces the
// agent-private `directive`/`internal` envelope fields.
//
// This module is the pure (React-free) half: types, tolerant parsing, the
// action→callback mapping (matching the cloud state machine exactly), and the
// protocol-language → desktop-locale mapping. It is unit-tested in isolation.

// The protocol family this build speaks. We render `gen-ladder/1` and, forward-
// compatibly, any later `gen-ladder/N` (added fields degrade gracefully — see
// `isGenLadderProtocol` and the card renderer's generic fallback).
export const GEN_LADDER_PROTOCOL = 'gen-ladder/1'
const GEN_LADDER_PROTOCOL_FAMILY = 'gen-ladder/'

// Protocol languages (5) vs. the desktop UI's 4 locales — `ko` has no desktop
// copy and falls back to the server's zh reference text.
export type GenLadderLanguage = 'zh' | 'zh-TW' | 'en' | 'ja' | 'ko'
export type GenLadderLocale = 'en' | 'zh' | 'zh-hant' | 'ja'

export type GenLadderActionKind = 'free' | 'spend' | 'select' | 'confirm_sensitive'

// The "priced button" money shape. `estimated` distinguishes a placeholder
// quote (shown verbatim with its 「示意」marker, never as a firm charge) from an
// authoritative price. The render layer only ever displays `display` — it never
// computes a price.
export interface GenLadderPrice {
  kind?: string
  amount_cents?: number
  currency?: string
  estimated?: boolean
  display?: string
  unit?: string
}

export interface GenLadderAction {
  id: string
  label: string
  kind: GenLadderActionKind
  // spend → the stage this priced button confirms to.
  target_stage?: string
  // select (draft) → which draft index.
  index?: number
  // select (entry) → which entry modality.
  entry_mode?: string
  desc?: string
  hint?: string
  price?: GenLadderPrice
  // Final-video model choices (provider-agnostic labels from the platform's
  // model catalog); when present the card offers a model picker folded into
  // confirm.
  model_options?: string[]
}

export interface GenLadderStep {
  key: string
  label: string
  status: 'done' | 'current' | 'todo'
}

export interface GenLadderMedia {
  kind?: 'image' | 'video'
  ref?: string
  url?: string
  label?: string
  index?: number
}

export interface GenLadderField {
  id: string
  key: string
  label: string
  value: unknown
  editable?: boolean
  highlight?: boolean
}

export interface GenLadderLanguageOverride {
  id: string
  supported?: boolean
  current?: string
  options?: string[]
  hint?: string
}

export interface GenLadderEditSlot {
  id: string
  supported?: boolean
  implemented?: boolean
  hint?: string
  applies_to?: string[]
}

export interface GenLadderGate {
  status?: string
  reason?: string
  guidance?: string
  matched?: unknown[]
  severity?: string
  acknowledged?: boolean
}

export interface GenLadderReferenceFlag {
  id?: string
  value?: boolean
  label?: string
  available?: boolean
}

export interface GenLadderReference {
  more_like_original?: GenLadderReferenceFlag
  gate?: GenLadderGate
}

export interface GenLadderBill {
  ladder_total_cents?: number
  ladder_total_display?: string
  naive_total_cents?: number
  naive_total_display?: string
  attempts?: number
  note?: string
}

export interface GenLadderCard {
  protocol_version?: string
  type?: string
  stage?: string
  modality?: string | null
  language?: string
  ladder?: GenLadderStep[]
  language_override?: GenLadderLanguageOverride
  edit_action_slot?: GenLadderEditSlot
  status?: string
  title?: string
  body?: string
  actions?: GenLadderAction[]
  fields?: GenLadderField[]
  media?: GenLadderMedia[]
  selected?: GenLadderMedia
  reference?: GenLadderReference
  gate?: GenLadderGate
  guidance?: string
  bill?: GenLadderBill
  // Card-level quote on the "generating" skeleton (e.g. drafts in flight).
  price?: GenLadderPrice
  prompt_stage_price?: GenLadderPrice
  session_id?: string
}

// What the render layer sends back to the agent when a control is used. Mirrors
// the cloud state machine's `advance(action, payload)` contract exactly.
export interface GenLadderCallback {
  action: string
  payload: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// True for `gen-ladder/1` and any later `gen-ladder/N` — the version gate is
// deliberately lenient so a newer producer still renders through the generic
// path instead of being dropped.
export function isGenLadderProtocol(version: unknown): boolean {
  return typeof version === 'string' && version.startsWith(GEN_LADDER_PROTOCOL_FAMILY)
}

// Pull the card out of a `gen_ladder` tool result. Accepts (a) the full envelope
// `{ ok, session_id, card, directive, internal }` — taking only `card`, never
// the agent-private fields; (b) a bare card object; (c) a JSON string of either.
// Returns null when the result carries no renderable card (e.g. still pending).
export function genLadderCardFromResult(result: unknown): GenLadderCard | null {
  if (result === undefined || result === null) {
    return null
  }

  if (typeof result === 'string') {
    const trimmed = result.trim()

    if (!trimmed) {
      return null
    }

    try {
      return genLadderCardFromResult(JSON.parse(trimmed))
    } catch {
      return null
    }
  }

  if (!isRecord(result)) {
    return null
  }

  // Envelope → its `card`.
  if (isRecord(result.card)) {
    return result.card as GenLadderCard
  }

  // Bare card: recognizable by the protocol tag or a card `type`.
  if (isGenLadderProtocol(result.protocol_version) || typeof result.type === 'string') {
    return result as GenLadderCard
  }

  return null
}

// Map a card action to the `{action, payload}` the agent must replay into the
// `gen_ladder` tool. Money is only ever committed by a `spend` button →
// `confirm`; every other kind is free or a plain selection. `model` (final-video
// model pick) and `language` (in-flight language override) ride along when set.
export function genLadderCallback(
  action: GenLadderAction,
  extra: { model?: string; language?: string } = {}
): GenLadderCallback {
  const payload: Record<string, unknown> = {}

  if (extra.language) {
    payload.language = extra.language
  }

  switch (action.kind) {
    case 'spend': {
      if (action.target_stage) {
        payload.target_stage = action.target_stage
      }

      if (extra.model) {
        payload.model = extra.model
      }

      return { action: 'confirm', payload }
    }

    case 'select': {
      // Entry cards reuse `select` but carry an `entry_mode` → `start`.
      if (action.entry_mode) {
        payload.entry_mode = action.entry_mode

        return { action: 'start', payload }
      }

      if (typeof action.index === 'number') {
        payload.index = action.index
      }

      return { action: 'select', payload }
    }

    case 'confirm_sensitive':
      return { action: 'acknowledge_rights', payload }

    case 'free':
    default: {
      // Free actions round-trip via their own stable id (`edit_prompt`, `back`,
      // `restart`, …). `back` optionally carries the stage to return to.
      if (action.target_stage) {
        payload.target_stage = action.target_stage
      }

      return { action: action.id, payload }
    }
  }
}

// The dedicated language-override control (distinct from any action) →
// `set_language`.
export function genLadderSetLanguageCallback(language: string): GenLadderCallback {
  return { action: 'set_language', payload: { language } }
}

// Protocol language → desktop locale. `zh-TW` → `zh-hant`; `ko` (no desktop
// copy) falls back to `zh`, matching the server's zh reference text.
export function genLadderLocale(language?: string): GenLadderLocale {
  switch (language) {
    case 'en':
      return 'en'

    case 'ja':
      return 'ja'

    case 'zh-TW':

    case 'zh-hant':
      return 'zh-hant'

    case 'zh':

    case 'ko':

    default:
      return 'zh'
  }
}
