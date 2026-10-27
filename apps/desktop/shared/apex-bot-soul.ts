/**
 * hc-1078 (multi-bot M2): the SOUL.md a new assistant starts with in single-thread product mode. It is
 * the APEX identity (apex-default-soul.ts) with the assistant's own name on the first line, so a new
 * assistant knows who it is before anything else is written. Upstream's create would seed the English
 * Bot Mode SOUL instead.
 *
 * The name has two homes: `ui_meta.apex.name` in profile.yaml (what the sidebar shows, and the
 * authority) and this first line (what the engine reads when hc-1082's prompt section is off: switch
 * off, developer mode). Two writers keep them together — this module's TypeScript and hc-1082's Python
 * rename tool — so the line's format is pinned once, in `apex-bot-soul-cases.json`, which both test
 * suites read. After every name write, the writer re-renders the line from `ui_meta.apex.name`
 * whenever the line still has this shape, whatever name it holds; a hand-edited line is left alone.
 *
 * Extension point: `sections` are appended after the identity, one `## heading` block each. hc-1079
 * (the first-open questions) adds the assistant's 「分工」 there.
 */
import { APEX_DESKTOP_DEFAULT_SOUL } from './apex-default-soul'

export interface ApexBotSoulSection {
  heading: string
  body: string
}

/** The first line of a new assistant's SOUL; `{name}` is its name. Pinned in apex-bot-soul-cases.json. */
export const APEX_BOT_SOUL_NAME_LINE =
  'You are {name}, an AI assistant from ApexNodes HK, working alongside APEX for the same person.'

const [LINE_HEAD, LINE_TAIL] = APEX_BOT_SOUL_NAME_LINE.split('{name}') as [string, string]

/** The sentence of APEX's identity that names it; everything after it is shared with every assistant. */
const APEX_NAME_SENTENCE = 'You are APEX, an intelligent AI assistant from ApexNodes HK. '

/** APEX's identity without the sentence that names it (pinned by test: the default must start with it). */
export const APEX_BOT_SOUL_BODY = APEX_DESKTOP_DEFAULT_SOUL.startsWith(APEX_NAME_SENTENCE)
  ? APEX_DESKTOP_DEFAULT_SOUL.slice(APEX_NAME_SENTENCE.length)
  : APEX_DESKTOP_DEFAULT_SOUL

const SHARED_MEMORY_LINE =
  "APEX is this person's main assistant. You and APEX share what you both know about them, " +
  'so never ask them to introduce themselves again.'

/** Concatenated, never `String.replace`: a name like `$&` must land as typed. */
export function apexBotSoulNameLine(name: string): string {
  return LINE_HEAD + name + LINE_TAIL
}

export function composeApexBotSoul({
  name,
  sections = []
}: {
  name: string
  sections?: readonly ApexBotSoulSection[]
}): string {
  const blocks = [apexBotSoulNameLine(name), APEX_BOT_SOUL_BODY, SHARED_MEMORY_LINE]

  for (const section of sections) {
    blocks.push(`## ${section.heading.trim()}\n${section.body.trim()}`)
  }

  return `${blocks.join('\n\n')}\n`
}

function unifiedLines(soul: string): string {
  return soul.replace(/\r\n?/g, '\n')
}

/** The name on a SOUL's first line, or null when that line is not this module's shape. */
export function apexBotNameFromSoul(soul: string): null | string {
  const first = unifiedLines(soul).split('\n', 1)[0] ?? ''

  if (!first.startsWith(LINE_HEAD) || !first.endsWith(LINE_TAIL)) {
    return null
  }

  const name = first.slice(LINE_HEAD.length, first.length - LINE_TAIL.length)

  return name.trim() ? name : null
}

/**
 * The SOUL (line endings unified to \n) with the assistant called `next`, or null when its first line
 * is not this module's shape: someone wrote their own, and their words stay.
 */
export function renameInApexBotSoul(soul: string, next: string): null | string {
  if (apexBotNameFromSoul(soul) === null) {
    return null
  }

  const unified = unifiedLines(soul)
  const newline = unified.indexOf('\n')

  return apexBotSoulNameLine(next) + (newline === -1 ? '' : unified.slice(newline))
}
