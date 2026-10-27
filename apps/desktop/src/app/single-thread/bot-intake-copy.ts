/**
 * Copy for hc-1079 (多助手第一期 M3, prototype ⑧ BotIntake): the first open of
 * an assistant the user made next to APEX. It greets, asks three questions as
 * cards — what it mainly does, how it talks, which platform — and says what it
 * wrote down. The account's own three questions (what you make, where you post,
 * what is hardest) are shared by every assistant and are not asked again (K4).
 *
 * `soul` is what lands in that assistant's SOUL.md 「分工」 section (K1: its own
 * file, never the shared memory ledger), so the model reads it on every new
 * session. Each locale is a whole typed object; zh, zh-hant and en are
 * complete, ja and ar read en.
 */

import { useI18n } from '@/i18n'
import type { Locale } from '@/i18n/types'

export type BotIntakeStep = 'platform' | 'role' | 'style'

/** The prototype's order. */
export const BOT_INTAKE_STEPS: readonly BotIntakeStep[] = ['role', 'style', 'platform']

export type BotIntakeRole = 'breakdown' | 'copywriting' | 'editing' | 'other' | 'sales_script'
export type BotIntakeStyle = 'brief' | 'detailed' | 'friendly'

/** The role card's taps, in the prototype's order; 「别的，我直接说」 is the typed row after them. */
export const BOT_INTAKE_ROLES: readonly Exclude<BotIntakeRole, 'other'>[] = [
  'copywriting',
  'breakdown',
  'editing',
  'sales_script'
]

export const BOT_INTAKE_STYLES: readonly BotIntakeStyle[] = ['brief', 'detailed', 'friendly']

export interface BotIntakeSoulCopy {
  /** The section's heading line. Every locale's heading is recognised when the section is replaced. */
  heading: string
  intro: string
  role: (answer: string) => string
  style: (style: BotIntakeStyle) => string
  sameAsApex: string
  platforms: (names: string) => string
}

export interface BotIntakeCopy {
  greeting: (name: string) => string
  intro: string
  /** The card's 「1 / 3」. */
  progress: (step: number, total: number) => string
  questions: Record<BotIntakeStep, string>
  roles: Record<Exclude<BotIntakeRole, 'other'>, string>
  /** What a role reads as inside a sentence: 「管剪辑出片」, 「以后剪辑出片的活」. */
  roleWork: Record<Exclude<BotIntakeRole, 'other'>, string>
  roleOtherPlaceholder: string
  styles: Record<BotIntakeStyle, string>
  /** The platform card's first option: the account's answer, carried over (null while it is not known). */
  sameAsApex: (platforms: null | string) => string
  /** The assistant's line after the role answer. */
  roleAck: (answer: string) => string
  /** Its line before the last card. */
  lastQuestion: string
  saving: string
  saveFailed: string
  noted: (name: string, parts: string[]) => string
  notedRole: (work: string) => string
  undo: string
  undone: string
  undoFailed: string
  closing: (work: string) => string
  closingUndone: string
  soul: BotIntakeSoulCopy
}

const en: BotIntakeCopy = {
  greeting: name => `Hi, I’m ${name}. APEX already told me about your account, so no need to say it again.`,
  intro: 'First, 3 quick questions to settle what I handle. Just tap an answer, or type it.',
  progress: (step, total) => `${step} / ${total}`,
  questions: {
    role: 'What should I mainly help you with?',
    style: 'How should I talk?',
    platform: 'Which platform is it mainly for?'
  },
  roles: {
    copywriting: 'Titles and captions',
    breakdown: 'Breaking down hits, finding topics',
    editing: 'Editing videos',
    sales_script: 'Sales scripts'
  },
  roleWork: {
    copywriting: 'titles and captions',
    breakdown: 'breaking down hits and finding topics',
    editing: 'editing videos',
    sales_script: 'sales scripts'
  },
  roleOtherPlaceholder: 'Something else (type it)',
  styles: { brief: 'Short and direct', detailed: 'A bit more detail', friendly: 'Like a friend' },
  sameAsApex: platforms => (platforms ? `Same as APEX: ${platforms}` : 'Same as APEX'),
  roleAck: answer => `${answer}, got it.`,
  lastQuestion: 'OK, last one.',
  saving: 'Saving…',
  saveFailed: 'That didn’t save. Tap it again.',
  noted: (name, parts) => `${name} noted: ${parts.join(' · ')}`,
  notedRole: work => `handles ${work}`,
  undo: 'Undo',
  undone: 'Undone. I won’t keep those 3.',
  undoFailed: 'Couldn’t undo. Tap Undo again.',
  closing: work =>
    `All set. Bring ${work} straight to me, and everything else to APEX. We share what we know about you, so you never have to introduce yourself again.`,
  closingUndone: 'OK, nothing settled for now. Tell me any time what you want me to handle.',
  soul: {
    heading: '## What you handle',
    intro:
      'What the user picked the first time they opened you (if they ask for something different now, go with that):',
    role: answer => `- Mainly help with: ${answer}`,
    style: style =>
      ({
        brief: '- Tone: short and direct. Lead with the answer, skip the preamble.',
        detailed: '- Tone: a bit more detail. Explain the reasons and the steps, with an example when it helps.',
        friendly: '- Tone: like a friend. Casual and relaxed, never stiff.'
      })[style],
    sameAsApex: '- Main platform: same as APEX, the platforms in the user profile',
    platforms: names => `- Main platform: ${names}`
  }
}

const zh: BotIntakeCopy = {
  greeting: name => `你好，我是${name}。你的账号情况 APEX 已经告诉我了，不用再说一遍。`,
  intro: '先问 3 个小问题，定一下我管什么。点一下就行，也可以直接打字。',
  progress: (step, total) => `${step} / ${total}`,
  questions: { role: '我主要帮你做什么？', style: '我说话什么风格？', platform: '主要给哪个平台做？' },
  roles: { copywriting: '写标题和文案', breakdown: '拆爆款、找选题', editing: '剪辑出片', sales_script: '带货脚本' },
  roleWork: { copywriting: '标题和文案', breakdown: '拆爆款和找选题', editing: '剪辑出片', sales_script: '带货脚本' },
  roleOtherPlaceholder: '别的，我直接说',
  styles: { brief: '简短直接', detailed: '详细一点', friendly: '像朋友聊天' },
  sameAsApex: platforms => (platforms ? `跟 APEX 一样：${platforms}` : '跟 APEX 一样'),
  roleAck: answer => `${answer}，明白。`,
  lastQuestion: '好，最后一个。',
  saving: '正在记…',
  saveFailed: '没记上，请再点一次。',
  noted: (name, parts) => `${name} 记下了：${parts.join(' · ')}`,
  notedRole: work => `管${work}`,
  undo: '撤销',
  undone: '已撤销，这三条不记',
  undoFailed: '没撤销成功，请再点一次撤销。',
  closing: work =>
    `好了。以后${work}的活直接找我，别的事还是找 APEX。我们记得的「关于你」是同一份，你不用再介绍一遍自己。`,
  closingUndone: '好，先不定分工。想让我管什么，随时跟我说。',
  soul: {
    heading: '## 分工',
    intro: '用户第一次打开你时定的（用户这次说的不一样时以这次为准）：',
    role: answer => `- 主要帮用户：${answer}`,
    style: style =>
      ({
        brief: '- 说话风格：简短直接。先说结论，少铺垫。',
        detailed: '- 说话风格：详细一点。把理由和步骤讲清楚，需要时举个例子。',
        friendly: '- 说话风格：像朋友聊天。口语、轻松，别端着。'
      })[style],
    sameAsApex: '- 主要给哪个平台做：跟 APEX 一样，按用户画像里的主要发布平台',
    platforms: names => `- 主要给哪个平台做：${names}`
  }
}

const zhHant: BotIntakeCopy = {
  greeting: name => `你好，我是${name}。你的帳號情況 APEX 已經告訴我了，不用再說一遍。`,
  intro: '先問 3 個小問題，定一下我管什麼。點一下就行，也可以直接打字。',
  progress: (step, total) => `${step} / ${total}`,
  questions: { role: '我主要幫你做什麼？', style: '我說話什麼風格？', platform: '主要給哪個平台做？' },
  roles: { copywriting: '寫標題和文案', breakdown: '拆爆款、找選題', editing: '剪輯出片', sales_script: '帶貨腳本' },
  roleWork: { copywriting: '標題和文案', breakdown: '拆爆款和找選題', editing: '剪輯出片', sales_script: '帶貨腳本' },
  roleOtherPlaceholder: '別的，我直接說',
  styles: { brief: '簡短直接', detailed: '詳細一點', friendly: '像朋友聊天' },
  sameAsApex: platforms => (platforms ? `跟 APEX 一樣：${platforms}` : '跟 APEX 一樣'),
  roleAck: answer => `${answer}，明白。`,
  lastQuestion: '好，最後一個。',
  saving: '正在記…',
  saveFailed: '沒記上，請再點一次。',
  noted: (name, parts) => `${name} 記下了：${parts.join(' · ')}`,
  notedRole: work => `管${work}`,
  undo: '撤銷',
  undone: '已撤銷，這三條不記',
  undoFailed: '沒撤銷成功，請再點一次撤銷。',
  closing: work =>
    `好了。以後${work}的活直接找我，別的事還是找 APEX。我們記得的「關於你」是同一份，你不用再介紹一遍自己。`,
  closingUndone: '好，先不定分工。想讓我管什麼，隨時跟我說。',
  soul: {
    heading: '## 分工',
    intro: '用戶第一次打開你時定的（用戶這次說的不一樣時以這次為準）：',
    role: answer => `- 主要幫用戶：${answer}`,
    style: style =>
      ({
        brief: '- 說話風格：簡短直接。先說結論，少鋪墊。',
        detailed: '- 說話風格：詳細一點。把理由和步驟講清楚，需要時舉個例子。',
        friendly: '- 說話風格：像朋友聊天。口語、輕鬆，別端著。'
      })[style],
    sameAsApex: '- 主要給哪個平台做：跟 APEX 一樣，按用戶畫像裡的主要發佈平台',
    platforms: names => `- 主要給哪個平台做：${names}`
  }
}

export const BOT_INTAKE_COPY: Readonly<Record<Locale, BotIntakeCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useBotIntakeCopy(): BotIntakeCopy {
  return BOT_INTAKE_COPY[useI18n().locale]
}
