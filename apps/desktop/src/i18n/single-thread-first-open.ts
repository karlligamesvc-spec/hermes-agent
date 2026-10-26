/**
 * Copy for hc-1063 (prototype v2 「第一次打开」): what an empty single thread
 * says — the greeting with the rename line, the three intake questions asked
 * as cards inside the conversation, the 「APEX 记下了」 line, today's ideas and
 * the closing tip.
 *
 * Its own file so the parallel prototype tickets do not edit the same lines of
 * single-thread-chat.ts, and because the main catalogs are at their size cap.
 * Each locale is a whole typed object; zh, zh-hant and en are complete, ja and
 * ar read en. The option labels are the hc-991 ones (creator-intake-copy.ts),
 * which the Start page cards and Settings › 个性化 show too: one wording per
 * answer everywhere.
 */

import type { DesktopCreatorIntakeStep } from '@/global'

import { useI18n } from './context'
import type { Locale } from './types'

export interface SingleThreadFirstOpenCopy {
  /** The greeting bubble: single-thread-chat's greeting plus that the name can be changed (decision 4). */
  greeting: (greeting: string) => string
  intro: string
  /** The card's 「1 / 3」. */
  progress: (step: number, total: number) => string
  questions: Record<DesktopCreatorIntakeStep, string>
  /** The platform card's one-tap answer for both of the two big platforms. */
  douyinAndXiaohongshu: string
  otherPlaceholder: string
  /** APEX's line after the content-type answer. */
  contentTypeAck: (answer: string) => string
  /** APEX's line before the last card. */
  lastQuestion: string
  saving: string
  saveFailed: string
  /** One centred line once the third card is answered: what went into the profile. */
  noted: (name: string, parts: string[]) => string
  notedPainPoint: (answer: string) => string
  undo: string
  undone: (count: number) => string
  undoFailed: string
  /** Before today's ideas: what the cards were picked from. */
  ideasLead: { hot: (count: number) => string; profile: (count: number) => string; plain: (count: number) => string }
  ideasGroup: string
  tip: string
}

const en: SingleThreadFirstOpenCopy = {
  greeting: greeting => `${greeting} If you’d like to call me something else, just tell me any time.`,
  intro: 'First, 3 quick questions so I know how to help. Just tap an answer, or type it.',
  progress: (step, total) => `${step} / ${total}`,
  questions: {
    content_type: 'What do you mostly make?',
    platforms: 'Where do you mostly post?',
    pain_point: 'What’s the hardest part right now?'
  },
  douyinAndXiaohongshu: 'Both Douyin and Xiaohongshu',
  otherPlaceholder: 'Something else (type it)',
  contentTypeAck: answer => `${answer}, got it.`,
  lastQuestion: 'OK, last one.',
  saving: 'Saving…',
  saveFailed: 'That didn’t save. Tap it again.',
  noted: (name, parts) => `${name} noted: ${parts.join(' · ')}`,
  notedPainPoint: answer => `hardest: ${answer}`,
  undo: 'Undo',
  undone: count => (count === 1 ? 'Undone. I won’t keep that one.' : `Undone. I won’t keep those ${count}.`),
  undoFailed: 'Couldn’t undo. You can change it in Settings › Personalization.',
  ideasLead: {
    hot: count => `Let me get today’s shoots ready. These ${count} are picked from your niche and today’s trends:`,
    profile: count => `Let me get today’s shoots ready. These ${count} are picked from your niche:`,
    plain: count => `Let me get today’s shoots ready. Anyone can shoot these ${count}:`
  },
  ideasGroup: 'Ideas for today',
  tip: 'From now on, just paste a link. If you’d rather not type, tap the round button at the bottom right and talk to me. We keep talking in this one conversation, so there is nothing new to open.'
}

const zh: SingleThreadFirstOpenCopy = {
  greeting: greeting => `${greeting}这个名字不喜欢的话，随时跟我说一声就能改。`,
  intro: '先问 3 个小问题，答完我就知道怎么帮你。点一下就行，也可以直接打字。',
  progress: (step, total) => `${step} / ${total}`,
  questions: {
    content_type: '你主要做什么内容？',
    platforms: '主要发在哪？',
    pain_point: '现在最头疼的是？'
  },
  douyinAndXiaohongshu: '抖音和小红书都发',
  otherPlaceholder: '其他（自己写）',
  contentTypeAck: answer => `${answer}，懂了。`,
  lastQuestion: '好，最后一个。',
  saving: '正在记…',
  saveFailed: '没记上，请再点一次。',
  noted: (name, parts) => `${name} 记下了：${parts.join(' · ')}`,
  notedPainPoint: answer => `最头疼${answer}`,
  undo: '撤销',
  undone: count => `已撤销，这${count === 1 ? '一' : count === 2 ? '两' : '三'}条不记`,
  undoFailed: '没撤销成功，可以去「设置 › 个性化」里改。',
  ideasLead: {
    hot: count => `那我先把今天能拍的备好。这 ${count} 个是按你的赛道和今天的热点挑的：`,
    profile: count => `那我先把今天能拍的备好。这 ${count} 个是按你的赛道挑的：`,
    plain: count => `那我先把今天能拍的备好。这 ${count} 个谁都能拍：`
  },
  ideasGroup: '今天能拍的',
  tip: '以后直接贴链接就行。懒得打字的话，点右下角那个圆按钮跟我说。我们就在这一个对话里聊，不用开新的。'
}

const zhHant: SingleThreadFirstOpenCopy = {
  greeting: greeting => `${greeting}這個名字不喜歡的話，隨時跟我說一聲就能改。`,
  intro: '先問 3 個小問題，答完我就知道怎麼幫你。點一下就行，也可以直接打字。',
  progress: (step, total) => `${step} / ${total}`,
  questions: {
    content_type: '你主要做什麼內容？',
    platforms: '主要發在哪？',
    pain_point: '現在最頭痛的是？'
  },
  douyinAndXiaohongshu: '抖音和小紅書都發',
  otherPlaceholder: '其他（自己寫）',
  contentTypeAck: answer => `${answer}，懂了。`,
  lastQuestion: '好，最後一個。',
  saving: '正在記…',
  saveFailed: '沒記上，請再點一次。',
  noted: (name, parts) => `${name} 記下了：${parts.join(' · ')}`,
  notedPainPoint: answer => `最頭痛${answer}`,
  undo: '撤銷',
  undone: count => `已撤銷，這${count === 1 ? '一' : count === 2 ? '兩' : '三'}條不記`,
  undoFailed: '沒撤銷成功，可以去「設定 › 個性化」裡改。',
  ideasLead: {
    hot: count => `那我先把今天能拍的備好。這 ${count} 個是按你的賽道和今天的熱點挑的：`,
    profile: count => `那我先把今天能拍的備好。這 ${count} 個是按你的賽道挑的：`,
    plain: count => `那我先把今天能拍的備好。這 ${count} 個誰都能拍：`
  },
  ideasGroup: '今天能拍的',
  tip: '以後直接貼連結就行。懶得打字的話，點右下角那個圓按鈕跟我說。我們就在這一個對話裡聊，不用開新的。'
}

export const SINGLE_THREAD_FIRST_OPEN_COPY: Readonly<Record<Locale, SingleThreadFirstOpenCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useSingleThreadFirstOpenCopy(): SingleThreadFirstOpenCopy {
  return SINGLE_THREAD_FIRST_OPEN_COPY[useI18n().locale]
}
