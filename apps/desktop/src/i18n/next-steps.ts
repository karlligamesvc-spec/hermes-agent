/**
 * Copy for the 「下一步」 buttons under a result (apex-next/1, components/assistant-ui/next-steps).
 *
 * Kept beside the main catalogs instead of inside them, like account-team.ts: the four
 * catalog files are past the code-health size cap (they may only shrink). The button text
 * itself is the skill's own words from the block, never translated here; a failed result
 * reuses hc-973's three buttons (`assistant.tool.process.failure`). zh, zh-hant and en are
 * complete; ja and ar fall back to en like any missing key.
 */

import type { StartHandoffRefusal } from '@/store/single-thread-handoff'

import { useI18n } from './context'
import type { Locale } from './types'

export interface NextStepsCopy {
  /** Accessible name of the button row. */
  group: string
  /** Hover text: the sentence a click sends as the user's message. */
  sends: (message: string) => string
  /** hc-1089 「交给」 option: the button names the assistant that takes the work. */
  handoff: (name: string, label: string) => string
  /** hc-1089: hover text of a 「交给」 button, with what that assistant is asked to do. */
  handsOff: (name: string, message: string) => string
  /** hc-1089: why the relay did not take a 「交给」 click, in plain words (one per hc-1086 refusal). */
  refused: Readonly<Record<StartHandoffRefusal, (name: string) => string>>
}

const en: NextStepsCopy = {
  group: 'Next steps',
  handoff: (name, label) => `Hand to ${name}: ${label}`,
  handsOff: (name, message) => `Hands this to ${name}: ${message}`,
  refused: {
    empty: name => `There is nothing to ask ${name} to do.`,
    nested: name => `This job was handed to this assistant. Hand it back first, then pass it on to ${name} from there.`,
    off: name => `Handing work to other assistants is off right now, so this cannot go to ${name}.`,
    self: name => `${name} is the assistant you are talking to. Just tell it here.`,
    too_many_batons: name => `This relay already has 3 hand-offs, so it cannot go on to ${name}.`,
    unknown_continues: name => `The earlier hand-off is gone, so this cannot carry on to ${name}.`,
    unknown_receiver: name => `There is no assistant called "${name}" any more. It may have been deleted or renamed.`
  },
  sends: message => `Sends: ${message}`
}

const zh: NextStepsCopy = {
  group: '下一步',
  handoff: (name, label) => `交给${name}：${label}`,
  handsOff: (name, message) => `点一下交给${name}：${message}`,
  refused: {
    empty: name => `没说要${name}做什么，交不过去。`,
    nested: name => `这是别的助手交来的活，做完交回去以后，再从那边交给${name}。`,
    off: name => `现在没开接力，交不给${name}。`,
    self: name => `${name}就是现在这个助手，不用交，直接跟它说就行。`,
    too_many_batons: name => `这一条接力已经 3 棒了，不能再交给${name}。`,
    unknown_continues: name => `上一棒找不到了，没法接着交给${name}。`,
    unknown_receiver: name => `找不到「${name}」这个助手，可能已经删掉或改了名字。`
  },
  sends: message => `点一下就发：${message}`
}

const zhHant: NextStepsCopy = {
  group: '下一步',
  handoff: (name, label) => `交給${name}：${label}`,
  handsOff: (name, message) => `點一下交給${name}：${message}`,
  refused: {
    empty: name => `沒說要${name}做什麼，交不過去。`,
    nested: name => `這是別的助手交來的活，做完交回去以後，再從那邊交給${name}。`,
    off: name => `現在沒開接力，交不給${name}。`,
    self: name => `${name}就是現在這個助手，不用交，直接跟它說就行。`,
    too_many_batons: name => `這一條接力已經 3 棒了，不能再交給${name}。`,
    unknown_continues: name => `上一棒找不到了，沒法接著交給${name}。`,
    unknown_receiver: name => `找不到「${name}」這個助手，可能已經刪掉或改了名字。`
  },
  sends: message => `點一下就發：${message}`
}

export const NEXT_STEPS_COPY: Readonly<Record<Locale, NextStepsCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

/** Next-step copy in the window's language. */
export function useNextStepsCopy(): NextStepsCopy {
  return NEXT_STEPS_COPY[useI18n().locale] ?? en
}
