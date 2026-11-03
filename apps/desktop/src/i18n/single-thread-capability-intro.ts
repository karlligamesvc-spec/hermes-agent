/**
 * Copy for hc-1108 首启能力介绍 (C2): what APEX says right after the three
 * first-open cards — one lead line, then one short
 * first-person message per thing it can do, each with its button, and the
 * closing tip without its first sentence (the first message already says to
 * paste a link).
 *
 * Its own file because the main catalogs are at their size cap. Each locale is
 * a whole typed object; zh, zh-hant and en are complete, ja and ar read en,
 * the same as single-thread-first-open.ts.
 */

import { useI18n } from './context'
import type { Locale } from './types'

export interface CapabilityIntroCopy {
  /** Before the messages; two when WeChat is already connected and its message is left out. */
  lead: (count: number) => string
  paste: {
    text: string
    button: string
    /** Under the message when the clipboard held no video link the tools can read. */
    hint: string
  }
  video: {
    text: string
    button: string
    /** Put in the composer, never sent: the user says what to shoot. */
    draft: string
  }
  wechat: {
    text: string
    connect: string
    later: string
    /** After 稍后再说: where to find it again (the sidebar row's own title). */
    laterNote: (row: string) => string
  }
  /** The first-open tip minus its first sentence. */
  tip: string
}

const en: CapabilityIntroCopy = {
  lead: count => `Here are ${count === 2 ? 'two' : 'three'} things I can do for you:`,
  paste: {
    text: 'Seen a video take off? Paste its link here. I can turn it into a transcript, break down why it worked, and rewrite it as your own script.',
    button: 'Paste one',
    hint: 'In Douyin, tap Share › Copy link, then come back and tap this again.'
  },
  video: {
    text: 'Tell me in one line what you want to shoot. I’ll make a 5-second sample first, and once you like it, the full 15-second video.',
    button: 'Make one',
    draft: 'Make me a 15-second short video of:'
  },
  wechat: {
    text: 'While this computer is on, you can find me on WeChat too. Scan once to connect.',
    connect: 'Scan to connect',
    later: 'Maybe later',
    laterNote: row => `OK. When you want to connect, click “${row}” at the bottom of the sidebar.`
  },
  tip: 'If you’d rather not type, tap the round button at the bottom right and talk to me. We keep talking in this one conversation, so there is nothing new to open.'
}

const zh: CapabilityIntroCopy = {
  lead: count => `我能帮你做的，先说${count === 2 ? '两' : '三'}件：`,
  paste: {
    text: '看到火的视频，把链接贴给我。我能转成逐字稿、拆它为什么火，再仿写成你的脚本。',
    button: '粘一条试试',
    hint: '在抖音点「分享 › 复制链接」，回来再点一次就行。'
  },
  video: {
    text: '说一句想拍什么，我先出 5 秒样片给你看，满意了再出 15 秒成片。',
    button: '出一条',
    draft: '帮我做一条 15 秒的短视频，拍：'
  },
  wechat: {
    text: '这台电脑开着的时候，微信里也能找我，扫一下码就连上。',
    connect: '扫码连上',
    later: '稍后再说',
    laterNote: row => `好，想连的时候点侧栏最下面的「${row}」。`
  },
  tip: '懒得打字的话，点右下角那个圆按钮跟我说。我们就在这一个对话里聊，不用开新的。'
}

const zhHant: CapabilityIntroCopy = {
  lead: count => `我能幫你做的，先說${count === 2 ? '兩' : '三'}件：`,
  paste: {
    text: '看到紅的影片，把連結貼給我。我能轉成逐字稿、拆它為什麼紅，再仿寫成你的腳本。',
    button: '貼一條試試',
    hint: '在抖音點「分享 › 複製連結」，回來再點一次就行。'
  },
  video: {
    text: '說一句想拍什麼，我先出 5 秒樣片給你看，滿意了再出 15 秒成片。',
    button: '出一條',
    draft: '幫我做一條 15 秒的短影音，拍：'
  },
  wechat: {
    text: '這台電腦開著的時候，微信裡也能找我，掃一下碼就連上。',
    connect: '掃碼連上',
    later: '稍後再說',
    laterNote: row => `好，想連的時候點側欄最下面的「${row}」。`
  },
  tip: '懶得打字的話，點右下角那個圓按鈕跟我說。我們就在這一個對話裡聊，不用開新的。'
}

export const CAPABILITY_INTRO_COPY: Readonly<Record<Locale, CapabilityIntroCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useCapabilityIntroCopy(): CapabilityIntroCopy {
  return CAPABILITY_INTRO_COPY[useI18n().locale]
}
