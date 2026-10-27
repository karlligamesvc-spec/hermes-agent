/**
 * hc-1078 (multi-bot M2): the SOUL.md a new assistant starts with in single-thread product mode. It is
 * the APEX identity (apex-default-soul.ts) with the assistant's own name on the first line, so a new
 * assistant knows who it is before anything else is written. Upstream's create would seed the English
 * Bot Mode SOUL instead.
 *
 * The first line is the only place the name lives in the file, and its shape is fixed (see
 * `apexBotSoulNameLine`): a rename rewrites that line and leaves every other line alone. hc-1082's
 * in-chat rename tool matches the same line.
 *
 * Extension point: `sections` are appended after the identity, one `## heading` block each. hc-1079
 * (the first-open questions) adds the assistant's 「分工」 there.
 */
import { APEX_DESKTOP_DEFAULT_SOUL } from './apex-default-soul'

export interface ApexBotSoulSection {
  heading: string
  body: string
}

/** The sentence of APEX's identity that names it; everything after it is shared with every assistant. */
const APEX_NAME_SENTENCE = 'You are APEX, an intelligent AI assistant from ApexNodes HK. '

/** APEX's identity without the sentence that names it (pinned by test: the default must start with it). */
export const APEX_BOT_SOUL_BODY = APEX_DESKTOP_DEFAULT_SOUL.startsWith(APEX_NAME_SENTENCE)
  ? APEX_DESKTOP_DEFAULT_SOUL.slice(APEX_NAME_SENTENCE.length)
  : APEX_DESKTOP_DEFAULT_SOUL

const SHARED_MEMORY_LINE =
  "APEX is this person's main assistant. You and APEX share what you both know about them, " +
  'so never ask them to introduce themselves again.'

export function apexBotSoulNameLine(name: string): string {
  return `You are ${name}, an AI assistant from ApexNodes HK, working alongside APEX for the same person.`
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

/**
 * The same SOUL with the assistant called `next`, or null when its first line is not the one this
 * module wrote for `previous` (someone edited it by hand: their words stay).
 */
export function renameInApexBotSoul(soul: string, previous: string, next: string): null | string {
  const unified = soul.replace(/\r\n?/g, '\n')
  const line = apexBotSoulNameLine(previous)

  if (unified !== line && !unified.startsWith(`${line}\n`)) {
    return null
  }

  return apexBotSoulNameLine(next) + unified.slice(line.length)
}
