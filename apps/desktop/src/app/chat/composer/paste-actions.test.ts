import { describe, expect, it } from 'vitest'

import { COMPOSER_SIMPLE_COPY } from '@/i18n/composer-simple'
import type { ComposerAttachment } from '@/store/composer'

import {
  detectShortVideoLink,
  isLocalVideoAttachment,
  notePastedText,
  PASTE_ACTIONS,
  pasteActionRequest,
  pasteActionSource,
  pastedTextFor,
  type ShortVideoPlatform
} from './paste-actions'

const zh = COMPOSER_SIMPLE_COPY.zh.paste

// Every link shape each platform's app or site hands out, bare and inside the
// share text the app copies (hard rule 12: one row per platform per shape).
// `raw` is what must be found; the share-text rows prove the surrounding words,
// emoji and full-width punctuation never ride along.
const LINKS: [ShortVideoPlatform, string, string][] = [
  ['douyin', 'https://v.douyin.com/iRNBho6u/', 'https://v.douyin.com/iRNBho6u/'],
  [
    'douyin',
    '7.43 复制打开抖音，看看【小林的作品】租房党的厨房收纳 # 好物分享  https://v.douyin.com/iRNBho6u/ k@D.ub 03/15 qrK:/',
    'https://v.douyin.com/iRNBho6u/'
  ],
  ['douyin', 'https://www.douyin.com/video/7312345678901234567', 'https://www.douyin.com/video/7312345678901234567'],
  ['douyin', 'https://www.douyin.com/note/7312345678901234567', 'https://www.douyin.com/note/7312345678901234567'],
  [
    'douyin',
    '这条 https://www.douyin.com/user/MS4wLjABAAAA?modal_id=7312345678901234567 开头很抓人',
    'https://www.douyin.com/user/MS4wLjABAAAA?modal_id=7312345678901234567'
  ],
  [
    'douyin',
    'https://www.iesdouyin.com/share/video/7312345678901234567/?region=CN&mid=7',
    'https://www.iesdouyin.com/share/video/7312345678901234567/?region=CN&mid=7'
  ],
  ['xiaohongshu', 'https://xhslink.com/m/4Kq9ZbB2xYz', 'https://xhslink.com/m/4Kq9ZbB2xYz'],
  [
    'xiaohongshu',
    '【租房改造 - 小林 | 小红书 - 你的生活指南】 😆 AbCdEfGhIjK 😆 http://xhslink.com/a/AbCdEfGhIjK，复制本条信息，打开【小红书】App查看精彩内容！',
    'http://xhslink.com/a/AbCdEfGhIjK'
  ],
  [
    'xiaohongshu',
    'https://www.xiaohongshu.com/explore/64f0a1b2000000001e03abcd?xsec_token=ABcdEF123=&xsec_source=pc_share',
    'https://www.xiaohongshu.com/explore/64f0a1b2000000001e03abcd?xsec_token=ABcdEF123=&xsec_source=pc_share'
  ],
  [
    'xiaohongshu',
    'https://www.xiaohongshu.com/discovery/item/64f0a1b2000000001e03abcd',
    'https://www.xiaohongshu.com/discovery/item/64f0a1b2000000001e03abcd'
  ],
  ['channels', 'https://weixin.qq.com/sph/AbCdEf12', 'https://weixin.qq.com/sph/AbCdEf12'],
  [
    'channels',
    '我在看视频号的这条：https://weixin.qq.com/sph/AbCdEf12。你也看看',
    'https://weixin.qq.com/sph/AbCdEf12'
  ],
  [
    'channels',
    'https://channels.weixin.qq.com/web/pages/feed?eid=export%2FUzFfAgtgekIEAQAAAAAA',
    'https://channels.weixin.qq.com/web/pages/feed?eid=export%2FUzFfAgtgekIEAQAAAAAA'
  ],
  ['kuaishou', 'https://v.kuaishou.com/5xAbCd 复制此消息，打开【快手】直接观看！', 'https://v.kuaishou.com/5xAbCd'],
  [
    'kuaishou',
    'https://www.kuaishou.com/short-video/3xabcdef12345678',
    'https://www.kuaishou.com/short-video/3xabcdef12345678'
  ],
  ['kuaishou', 'https://www.kuaishou.com/f/X-7aBcDeFgHiJ', 'https://www.kuaishou.com/f/X-7aBcDeFgHiJ'],
  [
    'kuaishou',
    'https://v.m.chenzhongtech.com/fw/photo/3xabcdef12345678?fid=1',
    'https://v.m.chenzhongtech.com/fw/photo/3xabcdef12345678?fid=1'
  ],
  ['bilibili', '【这个收纳盒太好用了-哔哩哔哩】 https://b23.tv/AbCd123', 'https://b23.tv/AbCd123'],
  [
    'bilibili',
    'https://www.bilibili.com/video/BV1xx411c7mD?p=1&share_source=copy_web',
    'https://www.bilibili.com/video/BV1xx411c7mD?p=1&share_source=copy_web'
  ],
  ['bilibili', 'https://m.bilibili.com/video/av170001', 'https://m.bilibili.com/video/av170001'],
  ['bilibili', '“https://bili2233.cn/AbCd123”', 'https://bili2233.cn/AbCd123']
]

describe('detectShortVideoLink', () => {
  it.each(LINKS)('finds the %s link in %j', (platform, text, raw) => {
    expect(detectShortVideoLink(text)).toEqual({ platform, raw, url: raw })
  })

  it.each([
    ['看看这个 v.douyin.com/iRNBho6u/ 怎么样', 'v.douyin.com/iRNBho6u/', 'douyin'],
    ['b23.tv/AbCd123', 'b23.tv/AbCd123', 'bilibili']
  ])('adds the scheme a hand-typed %j left out', (text, raw, platform) => {
    expect(detectShortVideoLink(text)).toEqual({ platform, raw, url: `https://${raw}` })
  })

  it.each([
    ['sentence punctuation', 'https://b23.tv/AbCd123.', 'https://b23.tv/AbCd123'],
    ['a full-width bracket', '（https://b23.tv/AbCd123）', 'https://b23.tv/AbCd123'],
    ['CJK straight after the code', 'https://v.kuaishou.com/5xAbCd复制此消息', 'https://v.kuaishou.com/5xAbCd']
  ])('stops at %s', (_, text, raw) => {
    expect(detectShortVideoLink(text)?.raw).toBe(raw)
  })

  it('takes the first video link when a message holds several', () => {
    const text = '参考 https://example.com/a 和 https://b23.tv/AbCd123 以及 https://v.douyin.com/iRNBho6u/'

    expect(detectShortVideoLink(text)?.platform).toBe('bilibili')
  })

  it.each([
    ['a Douyin profile', 'https://www.douyin.com/user/MS4wLjABAAAA'],
    ['a Douyin live room', 'https://live.douyin.com/123456'],
    ['a Douyin search', 'https://www.douyin.com/search/收纳'],
    ['the Douyin home page', 'https://www.douyin.com/'],
    ['a Xiaohongshu profile', 'https://www.xiaohongshu.com/user/profile/5f0000000000000001000000'],
    ['a Kuaishou profile', 'https://www.kuaishou.com/profile/3xabcdef'],
    ['a Kuaishou live room', 'https://live.kuaishou.com/u/3xabcdef'],
    ['a Bilibili space', 'https://space.bilibili.com/12345'],
    ['a Bilibili live room', 'https://live.bilibili.com/123'],
    ['a Bilibili bangumi episode', 'https://www.bilibili.com/bangumi/play/ep123456'],
    ['the 视频号 creator console', 'https://channels.weixin.qq.com/platform'],
    ['a lookalike host', 'https://v.douyin.com.evil.cn/iRNBho6u/'],
    ['a host that only ends like one', 'https://fakev.douyin.com/iRNBho6u/'],
    ['a host that only starts like one', 'https://www.douyin.com.cn/video/7312345678901234567'],
    ['a link nested in another site’s path', 'https://example.com/v.douyin.com/iRNBho6u/'],
    ['credentials before the host', 'https://user@v.douyin.com/iRNBho6u/'],
    ['an explicit port', 'https://v.douyin.com:8443/iRNBho6u/'],
    ['an e-mail address', '写信到 team@xhslink.com'],
    ['YouTube, which the download tool does not take', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['a platform named in words only', '我在抖音看到一个收纳视频，想做一条类似的']
  ])('ignores %s', (_, text) => {
    expect(detectShortVideoLink(text)).toBeNull()
  })
})

// The server's share-link parsers, as of apex-nodes main `cb38ea5d`
// (`app/services/douyin_media.py`): what `social_download` can resolve. A chip
// the server cannot follow would send the user into a "未识别到有效…链接" reply,
// so every downloadable row above must also pass these. 视频号 has no download
// parser on purpose — `analysis_video_links.py` classifies `weixin.qq.com/sph/<id>`
// as upload_required — and the assistant asks for the file instead.
const SERVER_PARSERS: Record<Exclude<ShortVideoPlatform, 'channels'>, RegExp> = {
  bilibili: /https?:\/\/(?:www\.bilibili\.com|m\.bilibili\.com|b23\.tv|bili2233\.cn)\/[^\s<>\]）)"'，。]+/i,
  douyin: /https?:\/\/(?:v\.douyin\.com|www\.douyin\.com|(?:v\.|www\.)?iesdouyin\.com)\/[^\s<>\]）)"'，。]+/i,
  kuaishou:
    /https?:\/\/(?:v\.kuaishou\.com|www\.kuaishou\.com|v\.m\.chenzhongtech\.com|kuaishou\.com)\/[^\s<>\]）)"'，。]+/i,
  xiaohongshu: /https?:\/\/(?:www\.)?(?:xhslink\.(?:com|cn)|xiaohongshu\.com)\/[^\s<>\]）)"'，。]+/i
}

describe('the chips offer only links the server can resolve', () => {
  it.each(LINKS.filter(([platform]) => platform !== 'channels'))('%s: %j', (platform, text) => {
    const link = detectShortVideoLink(text)!
    const parser = SERVER_PARSERS[platform as Exclude<ShortVideoPlatform, 'channels'>]

    expect(parser.exec(link.url)?.[0]).toBe(link.url)
  })

  it('reads 视频号 shares in the shape the analysis classifier knows', () => {
    expect(detectShortVideoLink('https://weixin.qq.com/sph/AbCdEf12')?.platform).toBe('channels')
  })
})

function file(path: string, kind: ComposerAttachment['kind'] = 'file'): ComposerAttachment {
  return { id: `${kind}:${path}`, kind, label: path.split('/').pop() ?? path, path }
}

describe('isLocalVideoAttachment', () => {
  it.each(['收纳.mp4', 'clip.MOV', 'a.m4v', 'a.webm', 'a.mkv', 'a.avi', 'a.flv'])('takes %s', name => {
    expect(isLocalVideoAttachment(file(`/Users/me/Movies/${name}`))).toBe(true)
  })

  it.each([
    ['audio', file('/Users/me/voice.mp3')],
    ['a picture', file('/Users/me/cover.png')],
    ['a vision image', file('/Users/me/frame.mp4', 'image')],
    ['a folder', file('/Users/me/clips.mp4', 'folder')],
    ['a page', file('https://example.com/a.mp4', 'url')]
  ])('leaves %s alone', (_, attachment) => {
    expect(isLocalVideoAttachment(attachment)).toBe(false)
  })

  it('reads the label when a drop carried no path', () => {
    expect(isLocalVideoAttachment({ id: 'file:x', kind: 'file', label: '探店.mov' })).toBe(true)
  })
})

describe('pasteActionSource', () => {
  it('prefers the link the user is looking at over a video among the attachments', () => {
    const source = pasteActionSource('https://b23.tv/AbCd123', [file('/Users/me/a.mp4')])

    expect(source).toEqual({
      kind: 'link',
      link: { platform: 'bilibili', raw: 'https://b23.tv/AbCd123', url: 'https://b23.tv/AbCd123' }
    })
  })

  it('offers the chips for a dropped video with nothing typed', () => {
    expect(pasteActionSource('', [file('/Users/me/a.mp4')])).toEqual({ kind: 'video' })
  })

  it('offers nothing for plain words and ordinary files', () => {
    expect(pasteActionSource('帮我写个口播', [file('/Users/me/notes.txt')])).toBeNull()
  })
})

const DOUYIN_SHARE =
  '7.43 复制打开抖音，看看【小林的作品】租房党的厨房收纳  https://v.douyin.com/iRNBho6u/ k@D.ub 03/15 qrK:/'

describe('pasteActionRequest', () => {
  const douyin = pasteActionSource(DOUYIN_SHARE, [])!

  it.each([
    ['transcribe', '把这条抖音视频转成逐字稿：https://v.douyin.com/iRNBho6u/'],
    ['breakdown', '拆解这条抖音视频为什么火：https://v.douyin.com/iRNBho6u/'],
    ['remix', '照这条抖音视频的结构和节奏，仿写一个我的口播脚本：https://v.douyin.com/iRNBho6u/']
  ] as const)('%s: one sentence and the link, the share padding left out', (action, request) => {
    expect(pasteActionRequest(action, douyin, zh, { draft: DOUYIN_SHARE, pasted: DOUYIN_SHARE })).toBe(request)
  })

  it('keeps what the user typed after the paste, on its own line', () => {
    const draft = `${DOUYIN_SHARE}\n重点看开头三秒`

    expect(pasteActionRequest('breakdown', douyin, zh, { draft, pasted: DOUYIN_SHARE })).toBe(
      '拆解这条抖音视频为什么火：https://v.douyin.com/iRNBho6u/\n重点看开头三秒'
    )
  })

  it('drops only the link when no paste was recorded, so no typed word is lost', () => {
    const draft = '帮我看看 https://b23.tv/AbCd123 这条'
    const source = pasteActionSource(draft, [])!

    expect(pasteActionRequest('transcribe', source, zh, { draft })).toBe(
      '把这条哔哩哔哩视频转成逐字稿：https://b23.tv/AbCd123\n帮我看看 这条'
    )
  })

  it('takes an older @url: chip out whole', () => {
    const draft = '@url:`https://v.douyin.com/iRNBho6u/` 这条'
    const source = pasteActionSource(draft, [])!

    expect(pasteActionRequest('transcribe', source, zh, { draft })).toBe(
      '把这条抖音视频转成逐字稿：https://v.douyin.com/iRNBho6u/\n这条'
    )
  })

  it('sends a hand-typed link with its scheme, and Xiaohongshu’s http link as pasted', () => {
    const typed = pasteActionSource('v.douyin.com/iRNBho6u/', [])!
    const xhs = pasteActionSource('http://xhslink.com/a/AbCdEfGhIjK，复制本条信息', [])!

    expect(pasteActionRequest('transcribe', typed, zh, { draft: 'v.douyin.com/iRNBho6u/' })).toBe(
      '把这条抖音视频转成逐字稿：https://v.douyin.com/iRNBho6u/'
    )
    expect(pasteActionRequest('transcribe', xhs, zh, { draft: 'http://xhslink.com/a/AbCdEfGhIjK' })).toBe(
      '把这条小红书笔记转成逐字稿：http://xhslink.com/a/AbCdEfGhIjK'
    )
  })

  it('names the video by the attachment, not a link, after a drop', () => {
    expect(pasteActionRequest('transcribe', { kind: 'video' }, zh, { draft: '' })).toBe('把这个视频转成逐字稿')
    expect(pasteActionRequest('remix', { kind: 'video' }, zh, { draft: '口吻轻松一点' })).toBe(
      '照这个视频的结构和节奏，仿写一个我的口播脚本\n口吻轻松一点'
    )
  })

  it('never writes an @url: directive the gateway would fetch as a web page', () => {
    for (const [, text] of LINKS) {
      const source = pasteActionSource(text, [])!

      for (const action of PASTE_ACTIONS) {
        expect(pasteActionRequest(action, source, zh, { draft: text, pasted: text })).not.toContain('@url:')
      }
    }
  })
})

describe('notePastedText', () => {
  it('remembers a share text, with the line breaks a textarea stores', () => {
    notePastedText('tile:paste-test', `  ${DOUYIN_SHARE}\r\n`)

    expect(pastedTextFor('tile:paste-test')).toBe(DOUYIN_SHARE)
  })

  it('leaves the last share text in place when other text is pasted', () => {
    notePastedText('tile:paste-keep', DOUYIN_SHARE)
    notePastedText('tile:paste-keep', '一句普通的话')

    expect(pastedTextFor('tile:paste-keep')).toBe(DOUYIN_SHARE)
  })
})
