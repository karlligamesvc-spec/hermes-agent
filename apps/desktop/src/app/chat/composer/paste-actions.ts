/**
 * Paste-to-act (WP4): a short-video link in the composer — pasted, often inside
 * the app's share text — or a local video dropped on it offers three one-click
 * requests above the input: 转逐字稿 / 拆它为什么火 / 仿写成我的脚本. Each one is
 * a preset sentence the existing tools already answer (`social_download` →
 * `media_transcribe`, the `video-script-breakdown` skill); nothing here calls a
 * backend.
 *
 * The host list mirrors the server's own share-link parsers, so a chip is never
 * offered for a link the download tool cannot read:
 *  - apex-nodes `app/services/douyin_media.py` — DOUYIN_URL_RE, XHS_URL_RE,
 *    KUAISHOU_URL_RE, BILIBILI_URL_RE (what `social_download` resolves);
 *  - apex-nodes `app/services/analysis_video_links.py` — 视频号 shares are
 *    `weixin.qq.com/sph/<id>` and `upload_required` (no downloadable stream),
 *    so for those the assistant asks for the video file instead.
 * Paths are narrowed to one-video shapes: a profile, a live room or a search
 * page has nothing to transcribe.
 */
import type { ComposerAttachment } from '@/store/composer'

export type ShortVideoPlatform = 'bilibili' | 'channels' | 'douyin' | 'kuaishou' | 'xiaohongshu'

export interface ShortVideoLink {
  platform: ShortVideoPlatform
  /** The text as it sits in the draft (scheme and all, or none). */
  raw: string
  /** What the request carries: the raw link, with `https://` added when the
   *  paste had no scheme (the server parsers require one). */
  url: string
}

type PathRule = (path: string, query: URLSearchParams) => boolean

const SHORT_CODE: PathRule = path => /^\/[A-Za-z0-9_-]+\/?$/.test(path)

// One host → which paths on it name a single video.
const HOST_RULES: Record<string, { platform: ShortVideoPlatform; video: PathRule }> = {
  'v.douyin.com': { platform: 'douyin', video: SHORT_CODE },
  'www.douyin.com': {
    platform: 'douyin',
    video: (path, query) => /^\/(?:video|note)\/\d+\/?$/.test(path) || /^\d+$/.test(query.get('modal_id') ?? '')
  },
  'iesdouyin.com': { platform: 'douyin', video: path => /^\/share\/(?:video|note|slides)\/\d+\/?$/.test(path) },
  'v.iesdouyin.com': { platform: 'douyin', video: SHORT_CODE },
  'www.iesdouyin.com': { platform: 'douyin', video: path => /^\/share\/(?:video|note|slides)\/\d+\/?$/.test(path) },
  // Share links come as /a/<code>, /m/<code>, /o/<code> or a bare /<code>.
  'xhslink.com': { platform: 'xiaohongshu', video: path => /^\/(?:[a-z]\/)?[A-Za-z0-9_-]+\/?$/.test(path) },
  'www.xhslink.com': { platform: 'xiaohongshu', video: path => /^\/(?:[a-z]\/)?[A-Za-z0-9_-]+\/?$/.test(path) },
  'xhslink.cn': { platform: 'xiaohongshu', video: path => /^\/(?:[a-z]\/)?[A-Za-z0-9_-]+\/?$/.test(path) },
  'xiaohongshu.com': { platform: 'xiaohongshu', video: path => /^\/(?:explore|discovery\/item)\/\w+\/?$/.test(path) },
  'www.xiaohongshu.com': {
    platform: 'xiaohongshu',
    video: path => /^\/(?:explore|discovery\/item)\/\w+\/?$/.test(path)
  },
  'channels.weixin.qq.com': { platform: 'channels', video: path => /^\/web\/pages\/feed\/?$/.test(path) },
  'weixin.qq.com': { platform: 'channels', video: path => /^\/sph\/[A-Za-z0-9_-]+\/?$/.test(path) },
  'v.kuaishou.com': { platform: 'kuaishou', video: SHORT_CODE },
  'kuaishou.com': {
    platform: 'kuaishou',
    video: path => /^\/(?:short-video\/\w+|f\/[\w-]+|fw\/photo\/\w+)\/?$/.test(path)
  },
  'www.kuaishou.com': {
    platform: 'kuaishou',
    video: path => /^\/(?:short-video\/\w+|f\/[\w-]+|fw\/photo\/\w+)\/?$/.test(path)
  },
  'v.m.chenzhongtech.com': { platform: 'kuaishou', video: path => /^\/fw\/(?:photo|long-video)\/\w+\/?$/.test(path) },
  'b23.tv': { platform: 'bilibili', video: SHORT_CODE },
  'bili2233.cn': { platform: 'bilibili', video: SHORT_CODE },
  'www.bilibili.com': {
    platform: 'bilibili',
    video: path => /^\/video\/(?:BV[0-9A-Za-z]{10}|av\d+)\/?$/i.test(path)
  },
  'm.bilibili.com': { platform: 'bilibili', video: path => /^\/video\/(?:BV[0-9A-Za-z]{10}|av\d+)\/?$/i.test(path) }
}

// Cheap gate before the full scan: the detector runs on every draft change.
const HOST_HINT = /douyin|xhslink|xiaohongshu|weixin\.qq|kuaishou|chenzhongtech|b23\.tv|bili(?:bili|2233)/i

// A link ends at whitespace, a quote or bracket, curly quotes and other general
// punctuation, or the first CJK character or full-width mark — share text runs
// straight on ("…/AbCd，复制本条信息").
const LINK_RE =
  /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s<>"'`()[\]{}\u2010-\u206f\u3000-\u303f\u3400-\u9fff\uff00-\uffef]*)?/gi

/** The first short-video link in `text` that the download tools can read, or
 *  null. Share text around it is fine; a lookalike host never matches. */
export function detectShortVideoLink(text: string): null | ShortVideoLink {
  if (!HOST_HINT.test(text)) {
    return null
  }

  for (const match of text.matchAll(LINK_RE)) {
    // `a@v.douyin.com` and `x.v.douyin.com` are not the link they contain.
    const before = text[(match.index ?? 0) - 1] ?? ''

    if (/[\w@.-]/.test(before)) {
      continue
    }

    const raw = match[0].replace(/[.,;:!?]+$/, '')
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    const link = parseShortVideoUrl(url)

    if (link) {
      return { platform: link, raw, url }
    }
  }

  return null
}

function parseShortVideoUrl(url: string): null | ShortVideoPlatform {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const rule = HOST_RULES[parsed.hostname.toLowerCase()]

  if (!rule || parsed.username || parsed.password || parsed.port) {
    return null
  }

  return rule.video(parsed.pathname, parsed.searchParams) ? rule.platform : null
}

/** The formats the Desktop's own video analysis accepts (analysis-page-copy
 *  `videoFileUnsupported`): MP4、MOV、M4V、WebM、MKV、AVI、FLV. */
const LOCAL_VIDEO_RE = /\.(?:mp4|mov|m4v|webm|mkv|avi|flv)$/i

/** A dropped or picked video on disk: it lands as a `file` chip (`@file:`). */
export function isLocalVideoAttachment(attachment: ComposerAttachment): boolean {
  return attachment.kind === 'file' && LOCAL_VIDEO_RE.test(attachment.path || attachment.label)
}

export type PasteActionId = 'breakdown' | 'remix' | 'transcribe'

export const PASTE_ACTIONS: readonly PasteActionId[] = ['transcribe', 'breakdown', 'remix']

export type PasteActionSource = { kind: 'link'; link: ShortVideoLink } | { kind: 'video' }

/** What the chips act on: a link in the draft first (the words the user is
 *  looking at), else a local video among the attachments. */
export function pasteActionSource(draft: string, attachments: readonly ComposerAttachment[]): null | PasteActionSource {
  const link = detectShortVideoLink(draft)

  if (link) {
    return { kind: 'link', link }
  }

  return attachments.some(isLocalVideoAttachment) ? { kind: 'video' } : null
}

export interface PasteActionPhrases {
  /** Joins a sentence and its link (`：` / `: `). */
  linkSeparator: string
  linkSentence: Record<PasteActionId, (platform: string) => string>
  platforms: Record<ShortVideoPlatform, string>
  videoSentence: Record<PasteActionId, string>
}

/**
 * The message a chip sends. The sentence names the job; a link rides after it
 * as plain text — never an `@url:` chip, which the gateway would fetch as a web
 * page before the turn (`context_references`), the slow path the download tool
 * exists to avoid. Whatever else the user typed follows on its own line so a
 * click never drops their words; the share text they pasted around the link
 * (`pasted`, when it is still in the draft) is left out — the link is the part
 * the tools need.
 */
export function pasteActionRequest(
  action: PasteActionId,
  source: PasteActionSource,
  phrases: PasteActionPhrases,
  { draft, pasted }: { draft: string; pasted?: null | string }
): string {
  let rest = draft
  let sentence = phrases.videoSentence[action]

  if (source.kind === 'link') {
    const { link } = source
    const shareText = pasted && pasted.includes(link.raw) && draft.includes(pasted) ? pasted : linkSpan(draft, link.raw)

    rest = draft.replace(shareText, ' ')
    sentence = `${phrases.linkSentence[action](phrases.platforms[link.platform])}${phrases.linkSeparator}${link.url}`
  }

  const note = rest
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()

  return note ? `${sentence}\n${note}` : sentence
}

/** The link as it sits in the draft: an older draft may hold it as an `@url:`
 *  chip, whose wrapper must leave with it. */
function linkSpan(draft: string, raw: string): string {
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return new RegExp(`@url:[\`"']?${escaped}[\`"']?`).exec(draft)?.[0] ?? raw
}

// The last share text pasted into each composer (by focus-bus target), so the
// request can drop the app's "复制打开抖音…" padding the user never typed.
const lastPaste = new Map<string, string>()

/** Record a paste that carries a short-video link; other pastes leave the
 *  previous one in place (it still matters while it sits in the draft). */
export function notePastedText(target: string, text: string): void {
  // A textarea stores line breaks as \n whatever the clipboard carried.
  const pasted = text.replace(/\r\n?/g, '\n').trim()

  if (detectShortVideoLink(pasted)) {
    lastPaste.set(target, pasted)
  }
}

export function pastedTextFor(target: string): null | string {
  return lastPaste.get(target) ?? null
}
