/**
 * Copy for hc-1087 (多助手二期 R2): the relay (接力) screens as prototype v2
 * artboards ⑩–⑫ word them — our `@` list, the confirm card, the relay card on
 * the sender's side, 「X 交来的活」 on the receiver's side and the sidebar line.
 *
 * Kept beside the main catalogs (they are past the code-health size cap). Each
 * locale is a whole typed object, so a missing zh string is a type error rather
 * than an English fallback; zh, zh-hant and en are complete, ja and ar read en.
 */

import type {
  HandoffCancelReason,
  HandoffFailureKind,
  HandoffPrompt,
  HandoffQueueReason
} from '@/store/single-thread-handoff'
import type { StartHandoffRefusal } from '@/store/single-thread-handoff'

import { useI18n } from './context'
import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

/** What goes along with a relay, counted for one line. */
export interface HandoffCarryCount {
  /** Code points of the previous result carried; 0 when none. */
  chars: number
  truncated: boolean
  files: number
  links: number
}

export interface SingleThreadHandoffCopy {
  // ── the @ list (⑩) ──
  pickerTitle: string
  pickerFoot: string
  /** APEX's line in the list (its 「分工」 is everything). */
  apexRole: string
  /** An assistant whose SOUL has no 「分工」 yet. */
  noRole: string
  /** After the role: the assistant is working on another relay, this one would queue. */
  busyHint: string
  noMatch: string
  /** The assistant on screen is itself working on a relay: it cannot hand on (L3). */
  nestedNote: (name: string, from: string) => string

  // ── the confirm card (⑫) ──
  confirmTitle: (name: string) => string
  askLabel: string
  carryLine: (count: HandoffCarryCount) => string
  /** Files and links past the ones listed. */
  moreItems: (count: number) => string
  /** The first sign-in check has not said whose account it is yet: nothing can start (hc-1086). */
  accountPending: string
  confirm: string
  notNow: string
  refusal: (reason: StartHandoffRefusal, name: string) => string

  // ── the relay card, sender's side (⑩ ⑫) ──
  cardTitle: (name: string) => string
  queuedChip: (position: number) => string
  runningChip: string
  waitingChip: string
  returnedChip: (took: string) => string
  failedChip: string
  interruptedChip: string
  platformBusyChip: string
  stoppedChip: string
  cancelledChip: string
  queueNote: (reason: HandoffQueueReason | null, name: string) => string
  carried: (count: HandoffCarryCount) => string
  waitingNote: (name: string, question: string) => string
  /** hc-1107: the chip and the note while the relay's turn waits on a yes/no (an approval) rather than a choice. */
  confirmChip: string
  confirmNote: (name: string, question: string) => string
  failure: (kind: HandoffFailureKind, name: string) => string
  stoppedNote: string
  cancelled: (reason: HandoffCancelReason, name: string) => string
  seeWork: string
  stop: string
  stopQueued: string
  answer: string
  openThread: (name: string) => string
  retry: string
  close: string
  seconds: (s: number) => string
  minutes: (m: number, s: number) => string

  // ── the receiver's side (⑪) ──
  receivedTitle: (from: string) => string
  backTo: (from: string) => string
  receivedNote: (from: string) => string
  previousLabel: (from: string) => string
  receivedQueued: string
  handedBack: (from: string, hhmm: string) => string

  // ── the sidebar line ──
  helping: (from: string, ask: string) => string
  helpingWaiting: (from: string) => string
  /** hc-1107: the same while the relay's turn waits on a yes/no (an approval). */
  helpingConfirm: (from: string) => string
  queuedFor: (from: string) => string
  waitingFor: (name: string) => string
}

/** 「the reply above (96 characters), 2 files」, '' when nothing but the sentence goes. */
function enCarried({ chars, files, links, truncated }: HandoffCarryCount): string {
  return [
    chars ? `the reply above (${truncated ? 'first ' : ''}${chars} characters)` : '',
    files ? `${files} file${files === 1 ? '' : 's'}` : '',
    links ? `${links} link${links === 1 ? '' : 's'}` : ''
  ]
    .filter(Boolean)
    .join(', ')
}

const enDuration = {
  minutes: (m: number, s: number) => (s ? `${m} min ${s} s` : `${m} min`),
  seconds: (s: number) => `${s} s`
}

const en: SingleThreadHandoffCopy = {
  pickerTitle: 'Hand it to',
  pickerFoot: 'It takes along the reply above and what you write',
  apexRole: 'Main assistant: anything',
  noRole: 'No role set yet',
  busyHint: 'busy, it will queue',
  noMatch: 'No assistant by that name',
  nestedNote: (name, from) => `${name} is doing a job for ${from}. Hand things on once it is back.`,

  confirmTitle: name => `Hand this to ${name}?`,
  askLabel: 'Asks it to',
  carryLine: count => {
    const parts = enCarried(count)

    return `${parts ? `Takes ${parts} and what you wrote` : 'Takes what you wrote'}. It already knows “About you”.`
  },
  moreItems: count => `and ${count} more`,
  accountPending: 'Still checking which account you’re signed in to. Hand it over in a moment.',
  confirm: 'Hand it over',
  notNow: 'Not now',
  refusal: (reason, name) =>
    ({
      empty: 'Say what it should do first.',
      nested: `${name} is doing a job for another assistant; it can’t hand work on.`,
      off: 'Handing work to other assistants is off.',
      self: 'That is the assistant you are talking to.',
      too_many_batons: 'One relay goes through at most 3 assistants.',
      unknown_continues: 'The previous step hasn’t come back yet.',
      unknown_receiver: `${name} is no longer here.`
    })[reason],

  cardTitle: name => `Handed to ${name}`,
  queuedChip: position => `#${position} in line`,
  runningChip: 'Working',
  waitingChip: 'Needs you',
  returnedChip: took => (took ? `Back · took ${took}` : 'Back'),
  failedChip: 'Didn’t finish',
  interruptedChip: 'Interrupted',
  platformBusyChip: 'Platform busy',
  stoppedChip: 'Stopped',
  cancelledChip: 'Cancelled',
  queueNote: (reason, name) =>
    reason === 'receiver_busy'
      ? `${name} is finishing another job. It starts right after, without cutting that one short.`
      : reason === 'running_cap'
        ? 'Two relays are already running. This one starts when one of them is done.'
        : reason === 'pool_full'
          ? 'Too many assistants are open on this computer. It starts when one frees up.'
          : reason === 'unreachable'
            ? `Couldn’t reach ${name} yet. Trying again shortly.`
            : reason === 'platform_busy_retry'
              ? 'The platform is busy. Trying again automatically in a moment.'
              : 'Starting now.',
  carried: count => {
    const parts = enCarried(count)

    return `Took ${parts ? `${parts} and what you wrote` : 'what you wrote'}.`
  },
  waitingNote: (name, question) =>
    question ? `${name} needs your decision: ${question}` : `${name} needs your decision.`,
  confirmChip: 'Needs your OK',
  confirmNote: (name, question) => (question ? `${name} needs your OK: ${question}` : `${name} needs your OK.`),
  failure: (kind, name) =>
    ({
      interrupted: 'It was cut off: the app closed before it finished.',
      no_reply: `${name} finished but didn’t say anything.`,
      platform_busy: 'The platform stayed busy, even after one automatic retry.',
      turn_error: `${name} couldn’t finish this time.`,
      unreachable: `Couldn’t reach ${name}.`
    })[kind],
  stoppedNote: 'You stopped this relay.',
  cancelled: (reason, name) =>
    reason === 'receiver_deleted' ? `“${name}” was deleted, so this relay was cancelled.` : 'This relay was cancelled.',
  seeWork: 'See what it’s doing',
  stop: 'Stop',
  stopQueued: 'Don’t wait',
  answer: 'Go answer',
  openThread: name => `Open the chat with ${name}`,
  retry: 'Try again',
  close: 'Dismiss',
  ...enDuration,

  receivedTitle: from => `From ${from}`,
  backTo: from => `Back to ${from}`,
  receivedNote: from => `Brought over from the chat with ${from} · goes back when done`,
  previousLabel: from => `${from}’s last result`,
  receivedQueued: 'Starts as soon as the job in hand is done',
  handedBack: (from, hhmm) => `Handed back to ${from} · ${hhmm}`,

  helping: (from, ask) => `Helping ${from}: ${ask}`,
  helpingWaiting: from => `Needs your decision (for ${from})`,
  helpingConfirm: from => `Needs your OK (for ${from})`,
  queuedFor: from => `A job from ${from} is waiting`,
  waitingFor: name => `Waiting for ${name}`
}

const zh: SingleThreadHandoffCopy = {
  pickerTitle: '交给哪个助手',
  pickerFoot: '交过去会带上：上面那条结果和你这句话',
  apexRole: '主助手：什么都能做',
  noRole: '还没定分工',
  busyHint: '手上有活，会排队',
  noMatch: '没有叫这个名字的助手',
  nestedNote: (name, from) => `${name}正在帮${from}做事，接手的不能再往外交，交回之后再说`,

  confirmTitle: name => `交给 ${name}？`,
  askLabel: '要它做',
  carryLine: ({ chars, files, links, truncated }) => {
    const parts = [
      chars ? `上面那条结果（${truncated ? '前 ' : ''}${chars} 字）` : '',
      files ? `${files} 个文件` : '',
      links ? `${links} 个链接` : ''
    ].filter(Boolean)

    return `会带上：${parts.length ? `${parts.join('、')}和你这句话` : '你这句话'}。「关于你」不用带，它本来就知道。`
  },
  moreItems: count => `等 ${count} 个`,
  accountPending: '还在确认你登录的账号，稍等一下再交。',
  confirm: '交给它',
  notNow: '先不',
  refusal: (reason, name) =>
    ({
      empty: '先说要它做什么。',
      nested: `${name}正在帮别的助手做事，接手的不能再往外交。`,
      off: '接力已经关了。',
      self: '这就是你正在说话的助手。',
      too_many_batons: '一次接力最多 3 棒。',
      unknown_continues: '上一棒还没交回来。',
      unknown_receiver: `${name}已经不在了。`
    })[reason],

  cardTitle: name => `交给 ${name}`,
  queuedChip: position => `排第 ${position}`,
  runningChip: '在做',
  waitingChip: '在等你决定',
  returnedChip: took => (took ? `交回了 · 用时 ${took}` : '交回了'),
  failedChip: '没做成',
  interruptedChip: '被打断',
  platformBusyChip: '平台忙',
  stoppedChip: '已停下',
  cancelledChip: '已取消',
  queueNote: (reason, name) =>
    reason === 'receiver_busy'
      ? `${name}手上还有一个活，做完马上接，不打断它。`
      : reason === 'running_cap'
        ? '已经有 2 棒在跑，前面的做完就接。'
        : reason === 'pool_full'
          ? '这台电脑上开着的助手满了，等一个空下来就接。'
          : reason === 'unreachable'
            ? `暂时没连上${name}，等会儿自动再试。`
            : reason === 'platform_busy_retry'
              ? '平台忙，稍后自动再试一次。'
              : '马上开始。',
  carried: ({ chars, files, links, truncated }) => {
    const parts = [
      chars ? `上面这条结果（${truncated ? '前 ' : ''}${chars} 字）` : '',
      files ? `${files} 个文件` : '',
      links ? `${links} 个链接` : ''
    ].filter(Boolean)

    return `带过去的：${parts.length ? `${parts.join('、')}和你这句话` : '你这句话'}。`
  },
  waitingNote: (name, question) => (question ? `${name}在等你决定：${question}` : `${name}在等你决定。`),
  confirmChip: '在等你确认',
  confirmNote: (name, question) => (question ? `${name}在等你确认：${question}` : `${name}在等你确认。`),
  failure: (kind, name) =>
    ({
      interrupted: '被打断了：App 关掉时它还没做完。',
      no_reply: `${name}做完了，但什么也没说。`,
      platform_busy: '平台一直忙，自动再试了一次也没成。',
      turn_error: `${name}这次没做成。`,
      unreachable: `没连上${name}。`
    })[kind],
  stoppedNote: '你停下了这次接力。',
  cancelled: (reason, name) =>
    reason === 'receiver_deleted' ? `「${name}」已删除，这次接力取消了。` : '这次接力取消了。',
  seeWork: '看它在做什么',
  stop: '停下',
  stopQueued: '不等了',
  answer: '去回答',
  openThread: name => `打开${name}的对话`,
  retry: '再试一次',
  close: '不看了',
  minutes: (m, s) => (s ? `${m} 分 ${s} 秒` : `${m} 分`),
  seconds: s => `${s} 秒`,

  receivedTitle: from => `${from} 交来的活`,
  backTo: from => `回到 ${from}`,
  receivedNote: from => `从 ${from} 的对话带过来的 · 做完会自动交回去`,
  previousLabel: from => `${from} 上一条结果`,
  receivedQueued: '手上这个做完就接',
  handedBack: (from, hhmm) => `已交回 ${from} · ${hhmm}`,

  helping: (from, ask) => `在帮 ${from}：${ask}`,
  helpingWaiting: from => `在等你决定（${from} 交来的活）`,
  helpingConfirm: from => `在等你确认（${from} 交来的活）`,
  queuedFor: from => `${from} 交来的活排着`,
  waitingFor: name => `等${name}交回`
}

const zhHant: SingleThreadHandoffCopy = {
  pickerTitle: '交給哪個助手',
  pickerFoot: '交過去會帶上：上面那條結果和你這句話',
  apexRole: '主助手：什麼都能做',
  noRole: '還沒定分工',
  busyHint: '手上有活，會排隊',
  noMatch: '沒有叫這個名字的助手',
  nestedNote: (name, from) => `${name}正在幫${from}做事，接手的不能再往外交，交回之後再說`,

  confirmTitle: name => `交給 ${name}？`,
  askLabel: '要它做',
  carryLine: ({ chars, files, links, truncated }) => {
    const parts = [
      chars ? `上面那條結果（${truncated ? '前 ' : ''}${chars} 字）` : '',
      files ? `${files} 個檔案` : '',
      links ? `${links} 個連結` : ''
    ].filter(Boolean)

    return `會帶上：${parts.length ? `${parts.join('、')}和你這句話` : '你這句話'}。「關於你」不用帶，它本來就知道。`
  },
  moreItems: count => `等 ${count} 個`,
  accountPending: '還在確認你登入的帳號，稍等一下再交。',
  confirm: '交給它',
  notNow: '先不',
  refusal: (reason, name) =>
    ({
      empty: '先說要它做什麼。',
      nested: `${name}正在幫別的助手做事，接手的不能再往外交。`,
      off: '接力已經關了。',
      self: '這就是你正在說話的助手。',
      too_many_batons: '一次接力最多 3 棒。',
      unknown_continues: '上一棒還沒交回來。',
      unknown_receiver: `${name}已經不在了。`
    })[reason],

  cardTitle: name => `交給 ${name}`,
  queuedChip: position => `排第 ${position}`,
  runningChip: '在做',
  waitingChip: '在等你決定',
  returnedChip: took => (took ? `交回了 · 用時 ${took}` : '交回了'),
  failedChip: '沒做成',
  interruptedChip: '被打斷',
  platformBusyChip: '平台忙',
  stoppedChip: '已停下',
  cancelledChip: '已取消',
  queueNote: (reason, name) =>
    reason === 'receiver_busy'
      ? `${name}手上還有一個活，做完馬上接，不打斷它。`
      : reason === 'running_cap'
        ? '已經有 2 棒在跑，前面的做完就接。'
        : reason === 'pool_full'
          ? '這台電腦上開著的助手滿了，等一個空下來就接。'
          : reason === 'unreachable'
            ? `暫時沒連上${name}，等會兒自動再試。`
            : reason === 'platform_busy_retry'
              ? '平台忙，稍後自動再試一次。'
              : '馬上開始。',
  carried: ({ chars, files, links, truncated }) => {
    const parts = [
      chars ? `上面這條結果（${truncated ? '前 ' : ''}${chars} 字）` : '',
      files ? `${files} 個檔案` : '',
      links ? `${links} 個連結` : ''
    ].filter(Boolean)

    return `帶過去的：${parts.length ? `${parts.join('、')}和你這句話` : '你這句話'}。`
  },
  waitingNote: (name, question) => (question ? `${name}在等你決定：${question}` : `${name}在等你決定。`),
  confirmChip: '在等你確認',
  confirmNote: (name, question) => (question ? `${name}在等你確認：${question}` : `${name}在等你確認。`),
  failure: (kind, name) =>
    ({
      interrupted: '被打斷了：App 關掉時它還沒做完。',
      no_reply: `${name}做完了，但什麼也沒說。`,
      platform_busy: '平台一直忙，自動再試了一次也沒成。',
      turn_error: `${name}這次沒做成。`,
      unreachable: `沒連上${name}。`
    })[kind],
  stoppedNote: '你停下了這次接力。',
  cancelled: (reason, name) =>
    reason === 'receiver_deleted' ? `「${name}」已刪除，這次接力取消了。` : '這次接力取消了。',
  seeWork: '看它在做什麼',
  stop: '停下',
  stopQueued: '不等了',
  answer: '去回答',
  openThread: name => `打開${name}的對話`,
  retry: '再試一次',
  close: '不看了',
  minutes: (m, s) => (s ? `${m} 分 ${s} 秒` : `${m} 分`),
  seconds: s => `${s} 秒`,

  receivedTitle: from => `${from} 交來的活`,
  backTo: from => `回到 ${from}`,
  receivedNote: from => `從 ${from} 的對話帶過來的 · 做完會自動交回去`,
  previousLabel: from => `${from} 上一條結果`,
  receivedQueued: '手上這個做完就接',
  handedBack: (from, hhmm) => `已交回 ${from} · ${hhmm}`,

  helping: (from, ask) => `在幫 ${from}：${ask}`,
  helpingWaiting: from => `在等你決定（${from} 交來的活）`,
  helpingConfirm: from => `在等你確認（${from} 交來的活）`,
  queuedFor: from => `${from} 交來的活排著`,
  waitingFor: name => `等${name}交回`
}

export const SINGLE_THREAD_HANDOFF_COPY: Readonly<Record<Locale, SingleThreadHandoffCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useSingleThreadHandoffCopy(): SingleThreadHandoffCopy {
  return SINGLE_THREAD_HANDOFF_COPY[useI18n().locale]
}

/** For code outside React (the composer's `@` list source). */
export function singleThreadHandoffCopyNow(): SingleThreadHandoffCopy {
  return SINGLE_THREAD_HANDOFF_COPY[getRuntimeI18nLocale()]
}

/** hc-1107: a relay card's chip while its turn waits on the user — 「在等你确认」 on an approval, else 「在等你决定」. */
export function relayWaitingChip(copy: SingleThreadHandoffCopy, prompt: HandoffPrompt | null | undefined): string {
  return prompt?.kind === 'approval' ? copy.confirmChip : copy.waitingChip
}

/** hc-1107: the card's line under it — 「带货脚本在等你确认：转码」. */
export function relayWaitingNote(
  copy: SingleThreadHandoffCopy,
  name: string,
  prompt: HandoffPrompt | null | undefined
): string {
  const question = prompt?.question.trim() ?? ''

  return prompt?.kind === 'approval' ? copy.confirmNote(name, question) : copy.waitingNote(name, question)
}

/** 「48 秒」 / 「6 分 10 秒」; '' for no duration. */
export function handoffDuration(copy: SingleThreadHandoffCopy, ms: null | number): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return ''
  }

  const total = Math.max(1, Math.round(ms / 1000))

  return total < 60 ? copy.seconds(total) : copy.minutes(Math.floor(total / 60), total % 60)
}
