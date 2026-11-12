/**
 * hc-1219 the words on a 剪映 draft's card (components/chat/jianying-draft-card.tsx).
 *
 * Kept beside the main catalogs: those files are past the code-health size cap.
 * Each locale is a whole typed object, so a missing string is a type error; zh,
 * zh-hant and en are complete, ja and ar read en. 「导出」 is 剪映's own word on
 * its menu and button, so each locale names it as 剪映 shows it.
 */

import type { JianyingOpenResult } from '@/lib/jianying-draft'

import { useI18n } from './context'
import type { Locale } from './types'

type Failure = Extract<JianyingOpenResult, { ok: false }>['reason']

export interface JianyingDraftCopy {
  /** 剪映 was closed when the draft was written; it shows up when 剪映 starts. */
  closed: string
  failed: Record<Failure, string>
  meta: (seconds: number, shots: number, subtitles: number) => string
  notListed: string
  /** 剪映 was open and did not take the draft in. */
  notTaken: string
  oneWay: string
  open: string
  opened: string
  opening: string
  /** How to export, by platform (process.platform); others read darwin's. */
  steps: Record<string, string>
  title: (name: string) => string
  unverified: (version: string) => string
}

const seconds = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1))

const zh: JianyingDraftCopy = {
  closed: '剪映现在没开，打开后这份草稿会出现在首页。',
  failed: {
    launch_failed: '剪映没能打开，可以自己打开剪映，在首页找这份草稿。',
    not_a_draft: '这份草稿已经不在剪映的草稿文件夹里了。',
    not_installed: '这台电脑上没找到剪映专业版。',
    unsupported: '这台电脑上不能打开剪映。'
  },
  meta: (s, shots, subtitles) => `${seconds(s)} 秒 · ${shots} 个镜头${subtitles ? ` · ${subtitles} 条字幕` : ''}`,
  notListed: '剪映打开了，但首页还没有这份草稿。等几秒再看；还没有的话，告诉 APEX。',
  notTaken: '剪映没有认出这份草稿，它可能打不开。成片照常能用。',
  oneWay: '在剪映里改的不会回到 APEX。之后要 APEX 改，它会另写一份新草稿。',
  open: '在剪映中打开',
  opened: '剪映已经打开，草稿在首页。',
  opening: '正在打开剪映…',
  steps: {
    darwin: '在剪映首页点开这份草稿，剪好后点菜单「文件 › 导出」，再点「导出」。',
    win32: '在剪映首页点开这份草稿，剪好后点右上角「导出」，再点「导出」。'
  },
  title: name => `剪映草稿「${name}」`,
  unverified: version => `APEX 还没在${version ? `剪映 ${version} ` : '这个版本的剪映'}上试过草稿，打不开的话告诉 APEX。`
}

const zhHant: JianyingDraftCopy = {
  closed: '剪映現在沒開，打開後這份草稿會出現在首頁。',
  failed: {
    launch_failed: '剪映沒能打開，可以自己打開剪映，在首頁找這份草稿。',
    not_a_draft: '這份草稿已經不在剪映的草稿資料夾裡了。',
    not_installed: '這台電腦上沒找到剪映專業版。',
    unsupported: '這台電腦上不能打開剪映。'
  },
  meta: (s, shots, subtitles) => `${seconds(s)} 秒 · ${shots} 個鏡頭${subtitles ? ` · ${subtitles} 條字幕` : ''}`,
  notListed: '剪映打開了，但首頁還沒有這份草稿。等幾秒再看；還沒有的話，告訴 APEX。',
  notTaken: '剪映沒有認出這份草稿，它可能打不開。成片照常能用。',
  oneWay: '在剪映裡改的不會回到 APEX。之後要 APEX 改，它會另寫一份新草稿。',
  open: '在剪映中打開',
  opened: '剪映已經打開，草稿在首頁。',
  opening: '正在打開剪映…',
  steps: {
    darwin: '在剪映首頁點開這份草稿，剪好後點選單「文件 › 导出」，再點「导出」。',
    win32: '在剪映首頁點開這份草稿，剪好後點右上角「导出」，再點「导出」。'
  },
  title: name => `剪映草稿「${name}」`,
  unverified: version => `APEX 還沒在${version ? `剪映 ${version} ` : '這個版本的剪映'}上試過草稿，打不開的話告訴 APEX。`
}

const en: JianyingDraftCopy = {
  closed: 'JianyingPro isn’t open. The draft will be on its home page when it starts.',
  failed: {
    launch_failed: 'JianyingPro didn’t open. Open it yourself and find the draft on its home page.',
    not_a_draft: 'This draft is no longer in JianyingPro’s draft folder.',
    not_installed: 'JianyingPro isn’t installed on this computer.',
    unsupported: 'JianyingPro can’t be opened on this computer.'
  },
  meta: (s, shots, subtitles) =>
    `${seconds(s)} s · ${shots} shot${shots === 1 ? '' : 's'}${subtitles ? ` · ${subtitles} subtitles` : ''}`,
  notListed: 'JianyingPro is open, but the draft isn’t on its home page yet. Give it a few seconds, then tell APEX.',
  notTaken: 'JianyingPro didn’t recognise this draft, so it may not open. The finished video works as usual.',
  oneWay: 'Changes made in JianyingPro don’t come back to APEX. For more changes, APEX writes a new draft.',
  open: 'Open in JianyingPro',
  opened: 'JianyingPro is open. The draft is on its home page.',
  opening: 'Opening JianyingPro…',
  steps: {
    darwin: 'Open the draft from JianyingPro’s home page. When it’s ready, choose 文件 › 导出 (File › Export), then 导出.',
    win32: 'Open the draft from JianyingPro’s home page. When it’s ready, click 导出 (Export) at the top right, then 导出.'
  },
  title: name => `JianyingPro draft “${name}”`,
  unverified: version =>
    `APEX hasn’t tried drafts on JianyingPro ${version || 'this version'} yet. If it doesn’t open, tell APEX.`
}

const COPY: Readonly<Record<Locale, JianyingDraftCopy>> = { ar: en, en, ja: en, zh, 'zh-hant': zhHant }

export function useJianyingDraftCopy(): JianyingDraftCopy {
  return COPY[useI18n().locale] ?? en
}

export function jianyingSteps(copy: JianyingDraftCopy, platform: string): string {
  return copy.steps[platform] ?? copy.steps.darwin
}
