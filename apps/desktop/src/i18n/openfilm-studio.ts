/**
 * Copy for the editor (OpenFilm Studio, lib/openfilm-studio.ts). hc-1176: an
 * agent's film.html opened before the editor is installed plays as it always
 * did, and `preparing` says the editor is on its way and takes over by itself.
 * hc-1188: the editor's tab is named for what it is, an editor, never after
 * the page Studio serves. hc-1201: the titlebar's 剪辑 opens it by hand and
 * hides it again, and the first time checks this computer and installs what
 * the editor needs (`setup`). Never the editor's upstream name: APEX ships a
 * build of its own. Each locale is a whole typed object; ja and ar read en.
 */

import { getRuntimeI18nLocale } from './runtime'
import type { Locale } from './types'

/** The first-run check by the titlebar's 剪辑 (hc-1201, app/shell/openfilm-editor-tool.tsx). */
export interface OpenfilmSetupCopy {
  /** The account may use the editor (the button shows only then). */
  account: string
  checking: string
  /** Free space where APEX keeps its data is enough. */
  diskEnough: (free: string) => string
  /** …and when it is not, what installing takes. */
  diskShort: (free: string, needed: string) => string
  diskHint: string
  downloading: (done: string, total: string) => string
  /** The editor itself (its toolkit). */
  editor: string
  /** Nothing to open yet. */
  empty: string
  failed: string
  /** Downloaded, being unpacked and checked. */
  installing: string
  ready: string
  recheck: string
  /** The browser the editor draws frames in, to show and to export. */
  renderer: string
  retry: string
  title: string
  waiting: string
}

export interface OpenfilmStudioCopy {
  /** The titlebar's 剪辑 while the editor is showing (hc-1201). */
  hideEditor: string
  /** The titlebar's 剪辑 otherwise (hc-1201). */
  openEditor: string
  /** Shown once when a film opens while the editor is still being installed. */
  preparing: string
  setup: OpenfilmSetupCopy
  /** The editor's tab in the preview pane. */
  tab: string
}

const en: OpenfilmStudioCopy = {
  hideEditor: 'Hide the editor',
  openEditor: 'Open the editor',
  preparing:
    'The editor is still getting ready, so this plays the film for now. It switches over by itself once ready.',
  setup: {
    account: 'This account can use the editor',
    checking: 'Checking…',
    diskEnough: free => `Enough disk space (${free} free)`,
    diskShort: (free, needed) => `Not enough disk space: ${free} free, ${needed} needed`,
    diskHint: 'Free up some disk space, then check again.',
    downloading: (done, total) => `Downloading ${done} / ${total}`,
    editor: 'The editor',
    empty: 'Nothing to edit yet. Ask the assistant for a short video, and it brings a project you can edit here.',
    failed: 'The download did not finish. The network may be unstable.',
    installing: 'Installing',
    ready: 'Ready',
    recheck: 'Check again',
    renderer: 'What renders the video',
    retry: 'Try again',
    title: 'First time in the editor: checking this computer',
    waiting: 'Waiting to download'
  },
  tab: 'Editor'
}

const zh: OpenfilmStudioCopy = {
  hideEditor: '隐藏剪辑',
  openEditor: '打开剪辑',
  preparing: '编辑器还在准备，先放成片；好了会自动切过去。',
  setup: {
    account: '账号可以使用剪辑',
    checking: '正在检查…',
    diskEnough: free => `磁盘空间够用（还剩 ${free}）`,
    diskShort: (free, needed) => `磁盘空间不够：还剩 ${free}，需要 ${needed}`,
    diskHint: '空出一些磁盘空间后，再检查一次。',
    downloading: (done, total) => `下载中 ${done} / ${total}`,
    editor: '剪辑编辑器',
    empty: '还没有可以剪的工程。让助手做一条短视频，就会生成可以在这里改的工程。',
    failed: '下载没有完成，可能是网络不稳定。',
    installing: '正在安装',
    ready: '已就绪',
    recheck: '重新检查',
    renderer: '出片用的渲染组件',
    retry: '重试',
    title: '第一次使用剪辑，先检查一下环境',
    waiting: '等待下载'
  },
  tab: '剪辑'
}

const zhHant: OpenfilmStudioCopy = {
  hideEditor: '隱藏剪輯',
  openEditor: '打開剪輯',
  preparing: '編輯器還在準備，先放成片；好了會自動切過去。',
  setup: {
    account: '帳號可以使用剪輯',
    checking: '正在檢查…',
    diskEnough: free => `磁碟空間夠用（還剩 ${free}）`,
    diskShort: (free, needed) => `磁碟空間不夠：還剩 ${free}，需要 ${needed}`,
    diskHint: '空出一些磁碟空間後，再檢查一次。',
    downloading: (done, total) => `下載中 ${done} / ${total}`,
    editor: '剪輯編輯器',
    empty: '還沒有可以剪的工程。讓助手做一條短影片，就會產生可以在這裡改的工程。',
    failed: '下載沒有完成，可能是網路不穩定。',
    installing: '正在安裝',
    ready: '已就緒',
    recheck: '重新檢查',
    renderer: '出片用的渲染元件',
    retry: '重試',
    title: '第一次使用剪輯，先檢查一下環境',
    waiting: '等待下載'
  },
  tab: '剪輯'
}

export const OPENFILM_STUDIO_COPY: Readonly<Record<Locale, OpenfilmStudioCopy>> = {
  ar: en,
  en,
  ja: en,
  zh,
  'zh-hant': zhHant
}

export function openfilmStudioCopyNow(): OpenfilmStudioCopy {
  return OPENFILM_STUDIO_COPY[getRuntimeI18nLocale()] ?? en
}
