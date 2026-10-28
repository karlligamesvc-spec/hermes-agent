/**
 * Copy for hc-1091 (多助手二期 R6): the relay plan card (一条龙接力) as
 * prototype v2 artboard ⑬ words it. The relay's own sentences (a baton
 * queued, waiting on the user, failed, a refusal) are hc-1087's
 * (i18n/single-thread-handoff.ts); this holds only what a plan adds.
 *
 * Kept beside the main catalogs (they are past the code-health size cap). Each
 * locale is a whole typed object; zh, zh-hant and en are written out, ja and ar
 * read en.
 */

import type { HandoffPlanEnd } from '@/store/handoff-plan'

import { useI18n } from './context'
import type { Locale } from './types'

/** Why a proposed plan cannot start as written. */
export type HandoffPlanProblem =
  { kind: 'over_cap'; legs: number } | { kind: 'self'; name: string } | { kind: 'unknown'; name: string }

export interface HandoffPlanCopy {
  /** 「接力 · 3 棒」 */
  title: (legs: number) => string
  /** A baton's line: who, what. */
  leg: (name: string, label: string) => string
  haveChip: string
  /** Under a relay baton before it starts. */
  oneMoreTurn: string
  notStartedChip: string
  afterPreviousChip: string
  notRunChip: string
  runningChip: string
  /** Held at baton `n` (1-based, 「已有」 counted). */
  heldChip: (n: number) => string
  doneChip: (took: string) => string
  endedChip: string
  start: string
  edit: string
  /** What 「改一下」 puts in the composer. */
  editDraft: string
  stop: string
  cancelRest: string
  retry: string
  /** 「剩下的不做了」 while a baton is on its way. */
  restCancelledNote: string
  planRunning: string
  problem: (problem: HandoffPlanProblem, planner: string) => string
  /** The planner is on another assistant's job: the next baton waits. */
  heldNested: (planner: string) => string
  doneNote: (turns: number) => string
  ended: (end: HandoffPlanEnd, n: number) => string
}

const en: HandoffPlanCopy = {
  title: legs => `Relay · ${legs} ${legs === 1 ? 'step' : 'steps'}`,
  leg: (name, label) => `${name}: ${label}`,
  haveChip: 'Done already',
  oneMoreTurn: '1 more turn',
  notStartedChip: 'Not started',
  afterPreviousChip: 'After the last step',
  notRunChip: 'Not run',
  runningChip: 'Running',
  heldChip: n => `Stopped at step ${n}`,
  doneChip: took => (took ? `Done · took ${took}` : 'Done'),
  endedChip: 'Stopped',
  start: 'Start',
  edit: 'Change it',
  editDraft: 'Change the relay plan: ',
  stop: 'Stop',
  cancelRest: 'Skip the rest',
  retry: 'Try again',
  restCancelledNote: 'This step finishes; nothing after it runs.',
  planRunning: 'Another relay is running. Start this one when it is done.',
  problem: (problem, planner) =>
    problem.kind === 'over_cap'
      ? `A relay has at most 3 steps; this one has ${problem.legs}. Ask ${planner} to make it shorter.`
      : problem.kind === 'self'
        ? `${planner} can’t hand a step to itself. Ask ${planner} to change it.`
        : `None of your assistants is called “${problem.name}”. Ask ${planner} to change it.`,
  heldNested: planner => `${planner} is doing a job for another assistant. The next step starts once that is back.`,
  doneNote: turns =>
    `${turns} more ${turns === 1 ? 'turn' : 'turns'} in all. Each step is in that assistant’s own chat.`,
  ended: (end, n) =>
    ({
      account_changed: 'This relay belonged to another account.',
      baton_cancelled: `Stopped at step ${n}: this relay was cancelled.`,
      baton_gone: `Stopped at step ${n}: the step was closed.`,
      rest_cancelled: `Skipped the rest after step ${n}.`,
      stopped: `You stopped it at step ${n}. Nothing after it ran.`
    })[end]
}

const zh: HandoffPlanCopy = {
  title: legs => `接力 · ${legs} 棒`,
  leg: (name, label) => `${name} ${label}`,
  haveChip: '已有',
  oneMoreTurn: '多跑 1 个回合',
  notStartedChip: '等开始',
  afterPreviousChip: '等上一棒',
  notRunChip: '没跑',
  runningChip: '进行中',
  heldChip: n => `停在第 ${n} 棒`,
  doneChip: took => (took ? `做完了 · 用时 ${took}` : '做完了'),
  endedChip: '停了',
  start: '开始',
  edit: '改一下',
  editDraft: '接力计划改一下：',
  stop: '停下',
  cancelRest: '剩下的不做了',
  retry: '再试一次',
  restCancelledNote: '这一棒做完就收，后面的不跑。',
  planRunning: '已经有一个接力在跑，等它做完再开始。',
  problem: (problem, planner) =>
    problem.kind === 'over_cap'
      ? `一次接力最多 3 棒，这个排了 ${problem.legs} 棒。让${planner}拆短一点再开始。`
      : problem.kind === 'self'
        ? `${planner}不能把一棒交给自己。让${planner}改一下。`
        : `你的助手里没有「${problem.name}」，这一棒交不出去。让${planner}改一下。`,
  heldNested: planner => `${planner}手上正接着别的助手交来的活，做完就接着跑下一棒。`,
  doneNote: turns => `一共多跑了 ${turns} 个回合。每一棒的过程在各自的对话里。`,
  ended: (end, n) =>
    ({
      account_changed: '这个接力是另一个账号的。',
      baton_cancelled: `停在第 ${n} 棒：这次接力取消了。`,
      baton_gone: `停在第 ${n} 棒：这一棒的记录关掉了。`,
      rest_cancelled: `做到第 ${n} 棒，剩下的不做了。`,
      stopped: `你在第 ${n} 棒停下了，后面的没跑。`
    })[end]
}

const zhHant: HandoffPlanCopy = {
  title: legs => `接力 · ${legs} 棒`,
  leg: (name, label) => `${name} ${label}`,
  haveChip: '已有',
  oneMoreTurn: '多跑 1 個回合',
  notStartedChip: '等開始',
  afterPreviousChip: '等上一棒',
  notRunChip: '沒跑',
  runningChip: '進行中',
  heldChip: n => `停在第 ${n} 棒`,
  doneChip: took => (took ? `做完了 · 用時 ${took}` : '做完了'),
  endedChip: '停了',
  start: '開始',
  edit: '改一下',
  editDraft: '接力計畫改一下：',
  stop: '停下',
  cancelRest: '剩下的不做了',
  retry: '再試一次',
  restCancelledNote: '這一棒做完就收，後面的不跑。',
  planRunning: '已經有一個接力在跑，等它做完再開始。',
  problem: (problem, planner) =>
    problem.kind === 'over_cap'
      ? `一次接力最多 3 棒，這個排了 ${problem.legs} 棒。讓${planner}拆短一點再開始。`
      : problem.kind === 'self'
        ? `${planner}不能把一棒交給自己。讓${planner}改一下。`
        : `你的助手裡沒有「${problem.name}」，這一棒交不出去。讓${planner}改一下。`,
  heldNested: planner => `${planner}手上正接著別的助手交來的活，做完就接著跑下一棒。`,
  doneNote: turns => `一共多跑了 ${turns} 個回合。每一棒的過程在各自的對話裡。`,
  ended: (end, n) =>
    ({
      account_changed: '這個接力是另一個帳號的。',
      baton_cancelled: `停在第 ${n} 棒：這次接力取消了。`,
      baton_gone: `停在第 ${n} 棒：這一棒的記錄關掉了。`,
      rest_cancelled: `做到第 ${n} 棒，剩下的不做了。`,
      stopped: `你在第 ${n} 棒停下了，後面的沒跑。`
    })[end]
}

export const HANDOFF_PLAN_COPY: Readonly<Record<Locale, HandoffPlanCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useHandoffPlanCopy(): HandoffPlanCopy {
  return HANDOFF_PLAN_COPY[useI18n().locale]
}
