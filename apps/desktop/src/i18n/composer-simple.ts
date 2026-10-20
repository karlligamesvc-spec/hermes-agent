/**
 * Copy for the simple composer (WP4): the "+" menu with its 高级 fold, the
 * three chips a pasted short-video link or a dropped video offers, and the
 * save-it-first line a 视频号 link gets instead.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap (they may only shrink), and a key zh lacks there
 * falls back to English without a sound. Here each locale is a whole typed
 * object, so a missing zh string is a type error. zh, zh-hant and en are
 * complete; ja and ar read en like any missing key.
 *
 * The wake-word labels are here because zh and zh-hant never had them (the
 * voice menu read "APEX voice activation — off" in Chinese); en repeats en.ts
 * `composer.wakeWord*` word for word, and a test keeps the two equal.
 */

import type { PasteActionId, PasteActionPhrases } from '@/app/chat/composer/paste-actions'

import { useI18n } from './context'
import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

export interface ComposerSimpleCopy {
  /** The "+" button: attachments first, then generation and the 高级 fold. */
  addMenu: string
  addFiles: string
  addFolder: string
  addImages: string
  /** Everything that is not attach, voice or send. */
  advanced: string
  approval: string
  paste: PasteActionPhrases & {
    /** The chip group's accessible name. */
    group: string
    labels: Record<PasteActionId, string>
    /** Shown instead of the chips for a 视频号 link: it can't be downloaded. */
    saveFirst: string
  }
  /** Native picker titles (Windows shows them in the dialog's title bar). */
  pickFilesTitle: string
  pickFoldersTitle: string
  scenarios: string
  voiceSettings: string
  wakeWordListening: string
  wakeWordOff: string
  wakeWordPausedVoice: string
}

const en: ComposerSimpleCopy = {
  addMenu: 'Add images, files and more',
  addFiles: 'Add files or videos',
  addFolder: 'Add a folder',
  addImages: 'Add images',
  advanced: 'Advanced',
  approval: 'Approvals',
  paste: {
    group: 'What to do with this video',
    labels: { breakdown: 'Why it went viral', remix: 'Rewrite as my script', transcribe: 'Transcribe' },
    linkSentence: {
      breakdown: video => `Break down why this ${video} went viral`,
      remix: video => `Write a script of my own on the structure and pacing of this ${video}`,
      transcribe: video => `Transcribe this ${video}`
    },
    linkSeparator: ': ',
    saveFirst:
      "WeChat Channels videos can't be downloaded from the link. Save the video to your computer, then drag it in",
    platforms: {
      bilibili: 'Bilibili video',
      channels: 'WeChat Channels video',
      douyin: 'Douyin video',
      kuaishou: 'Kuaishou video',
      xiaohongshu: 'Xiaohongshu note'
    },
    videoSentence: {
      breakdown: 'Break down why this video went viral',
      remix: 'Write a script of my own on the structure and pacing of this video',
      transcribe: 'Transcribe this video'
    }
  },
  pickFilesTitle: 'Choose files or videos to add',
  pickFoldersTitle: 'Choose folders to add',
  scenarios: 'Scenarios…',
  voiceSettings: 'Voice settings',
  wakeWordListening: 'APEX voice activation — listening',
  wakeWordOff: 'APEX voice activation — off',
  wakeWordPausedVoice: 'APEX voice activation — paused during voice chat'
}

const zh: ComposerSimpleCopy = {
  addMenu: '添加图片、文件和更多',
  addFiles: '添加文件或视频',
  addFolder: '添加文件夹',
  addImages: '添加图片',
  advanced: '高级',
  approval: '审批方式',
  paste: {
    group: '用这条视频做什么',
    labels: { breakdown: '拆它为什么火', remix: '仿写成我的脚本', transcribe: '转逐字稿' },
    linkSentence: {
      breakdown: video => `拆解这条${video}为什么火`,
      remix: video => `照这条${video}的结构和节奏，仿写一个我的口播脚本`,
      transcribe: video => `把这条${video}转成逐字稿`
    },
    linkSeparator: '：',
    saveFirst: '视频号的视频没法从链接下载：先把视频存到电脑，再拖进来',
    platforms: {
      bilibili: '哔哩哔哩视频',
      channels: '视频号视频',
      douyin: '抖音视频',
      kuaishou: '快手视频',
      xiaohongshu: '小红书笔记'
    },
    videoSentence: {
      breakdown: '拆解这个视频为什么火',
      remix: '照这个视频的结构和节奏，仿写一个我的口播脚本',
      transcribe: '把这个视频转成逐字稿'
    }
  },
  pickFilesTitle: '选择要添加的文件或视频',
  pickFoldersTitle: '选择要添加的文件夹',
  scenarios: '场景…',
  voiceSettings: '语音设置',
  wakeWordListening: 'APEX 语音唤醒：正在听',
  wakeWordOff: 'APEX 语音唤醒：已关闭',
  wakeWordPausedVoice: 'APEX 语音唤醒：语音对话时暂停'
}

const zhHant: ComposerSimpleCopy = {
  addMenu: '新增圖片、檔案和更多',
  addFiles: '新增檔案或影片',
  addFolder: '新增資料夾',
  addImages: '新增圖片',
  advanced: '進階',
  approval: '審批方式',
  paste: {
    group: '用這個影片做什麼',
    labels: { breakdown: '拆它為什麼紅', remix: '仿寫成我的腳本', transcribe: '轉逐字稿' },
    linkSentence: {
      breakdown: video => `拆解這個${video}為什麼紅`,
      remix: video => `照這個${video}的結構和節奏，仿寫一個我的口播腳本`,
      transcribe: video => `把這個${video}轉成逐字稿`
    },
    linkSeparator: '：',
    saveFirst: '視訊號的影片沒辦法從連結下載：先把影片存到電腦，再拖進來',
    platforms: {
      bilibili: '嗶哩嗶哩影片',
      channels: '視訊號影片',
      douyin: '抖音影片',
      kuaishou: '快手影片',
      xiaohongshu: '小紅書筆記'
    },
    videoSentence: {
      breakdown: '拆解這個影片為什麼紅',
      remix: '照這個影片的結構和節奏，仿寫一個我的口播腳本',
      transcribe: '把這個影片轉成逐字稿'
    }
  },
  pickFilesTitle: '選擇要新增的檔案或影片',
  pickFoldersTitle: '選擇要新增的資料夾',
  scenarios: '場景…',
  voiceSettings: '語音設定',
  wakeWordListening: 'APEX 語音喚醒：正在聽',
  wakeWordOff: 'APEX 語音喚醒：已關閉',
  wakeWordPausedVoice: 'APEX 語音喚醒：語音對話時暫停'
}

export const COMPOSER_SIMPLE_COPY: Readonly<Record<Locale, ComposerSimpleCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

/** Simple-composer copy in the window's language. */
export function useComposerSimpleCopy(): ComposerSimpleCopy {
  return COMPOSER_SIMPLE_COPY[useI18n().locale] ?? en
}

/** The same outside React (a picker opened from a callback). */
export function composerSimpleCopyNow(): ComposerSimpleCopy {
  return COMPOSER_SIMPLE_COPY[getRuntimeI18nLocale()] ?? en
}
