/**
 * hc-1130 拿到结果: the words on a result card in single-thread product mode, and
 * in the process area where a file edit's contents now live. Download and
 * 「在访达中显示」 reuse `fileMenu`, so they read the same as every file menu.
 *
 * Kept beside the main catalogs instead of inside them: those files are past
 * the code-health size cap. Each locale is a whole typed object, so a missing
 * zh string is a type error; zh, zh-hant and en are complete, ja and ar read en.
 */

import type { MediaKind } from '@/lib/media'

import { useI18n } from './context'
import type { Locale } from './types'

export interface ResultCopy {
  hideContents: string
  /** What a card says while its file loads. */
  loading: string
  /** The title of a file nobody named. */
  kinds: Record<MediaKind, string>
  /** The file was moved or cleaned up after the turn. */
  missing: string
  showContents: string
  /** The player cannot play the file; the actions below still work. */
  unplayable: string
}

const en: ResultCopy = {
  hideContents: 'Hide the contents',
  kinds: { audio: 'Audio', file: 'File', image: 'Image', video: 'Video' },
  loading: 'Opening…',
  missing: 'This file is no longer there. It may have been moved or cleaned up.',
  showContents: 'See the contents',
  unplayable: 'This file won’t play here. You can still download it.'
}

const zh: ResultCopy = {
  hideContents: '收起内容',
  kinds: { audio: '音频', file: '文件', image: '图片', video: '视频' },
  loading: '正在打开…',
  missing: '这个文件已经不在原来的位置了，可能被移走或清理了。',
  showContents: '看内容',
  unplayable: '这个文件在这里放不了，可以下载下来看。'
}

const zhHant: ResultCopy = {
  hideContents: '收起內容',
  kinds: { audio: '音訊', file: '檔案', image: '圖片', video: '影片' },
  loading: '正在開啟…',
  missing: '這個檔案已經不在原來的位置了，可能被移走或清理了。',
  showContents: '看內容',
  unplayable: '這個檔案在這裡放不了，可以下載下來看。'
}

const RESULT_COPY: Readonly<Record<Locale, ResultCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function useResultCopy(): ResultCopy {
  return RESULT_COPY[useI18n().locale] ?? en
}
