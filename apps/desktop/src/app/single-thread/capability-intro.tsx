/**
 * hc-1108 首启能力介绍 (C2): right after the three first-open cards, APEX says
 * in its own voice what it can do — one lead line,
 * then one short message per thing with its button — and the closing tip
 * without its first sentence. first-open.tsx shows this, in place of that tip,
 * only on the screen where the third card was just answered and only while
 * `desktop_features.capability_intro` is on (store/capability-intro.ts).
 *
 * Nothing here sends a message or calls the network:
 * - 粘一条试试 reads the clipboard once, on that click. A video link the
 *   download tools can read goes into the composer, where the paste chips
 *   (转逐字稿 / 拆它为什么火 / 仿写成我的脚本) take it from there; anything else
 *   (a 视频号 link too) gets a line on how to copy one.
 * - 出一条 puts a half sentence in the composer; once sent, the video skill
 *   asks before anything is generated (生成样片 / 只要拍摄脚本 / 换个方向).
 * - 扫码连上 opens the same page as the sidebar's WeChat row; 稍后再说 says
 *   where that row is. WeChat reaches APEX only (K7), and an install that
 *   already has it connected hears two things, not three.
 */

import { useStore } from '@nanostores/react'
import { type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { useCapabilityIntroCopy } from '@/i18n/single-thread-capability-intro'
import { useSingleThreadSidebarCopy } from '@/i18n/single-thread-sidebar'
import { $apexBot, withBotName } from '@/store/single-thread-bots'

import { requestComposerFocus, requestComposerInsert } from '../chat/composer/focus'
import { detectShortVideoLink } from '../chat/composer/paste-actions'
import { IM_ENTRY_ROUTE } from '../routes'

import { FIRST_OPEN_BUBBLE_CLASS } from './first-open-ideas'
import { useWechatBound } from './sidebar-wechat'

/** The clipboard's first short-video link the download tools can read, or null. */
async function clipboardVideoLink(): Promise<null | string> {
  try {
    const link = detectShortVideoLink((await window.hermesDesktop?.readClipboard?.()) ?? '')

    return link && link.platform !== 'channels' ? link.url : null
  } catch {
    return null
  }
}

export function CapabilityIntro() {
  const copy = useCapabilityIntroCopy()
  const sidebarCopy = useSingleThreadSidebarCopy()
  const apexName = useStore($apexBot)?.name
  const navigate = useNavigate()
  const bound = useWechatBound()
  const [pasteHint, setPasteHint] = useState(false)
  const [later, setLater] = useState(false)

  // Wait for the binding: the lead says how many things follow.
  if (bound === null) {
    return null
  }

  const pasteOne = async () => {
    const url = await clipboardVideoLink()

    setPasteHint(!url)

    if (url) {
      requestComposerInsert(url, { target: 'main' })
    } else {
      requestComposerFocus('main')
    }
  }

  return (
    <>
      <p className={FIRST_OPEN_BUBBLE_CLASS} data-capability-intro="">
        {copy.lead(bound ? 2 : 3)}
      </p>
      <IntroTurn id="paste" note={pasteHint ? copy.paste.hint : null} text={copy.paste.text}>
        <Button onClick={() => void pasteOne()} size="xs" type="button" variant="outline">
          {copy.paste.button}
        </Button>
      </IntroTurn>
      <IntroTurn id="video" text={copy.video.text}>
        <Button
          onClick={() => requestComposerInsert(copy.video.draft, { target: 'main' })}
          size="xs"
          type="button"
          variant="outline"
        >
          {copy.video.button}
        </Button>
      </IntroTurn>
      {!bound && (
        <IntroTurn
          id="wechat"
          note={later ? copy.wechat.laterNote(withBotName(sidebarCopy.wechatTitle, apexName)) : null}
          text={copy.wechat.text}
        >
          {!later && (
            <>
              <Button onClick={() => navigate(IM_ENTRY_ROUTE)} size="xs" type="button">
                {copy.wechat.connect}
              </Button>
              <Button onClick={() => setLater(true)} size="xs" type="button" variant="outline">
                {copy.wechat.later}
              </Button>
            </>
          )}
        </IntroTurn>
      )}
      <p className={FIRST_OPEN_BUBBLE_CLASS} data-first-open-tip="">
        {copy.tip}
      </p>
    </>
  )
}

/** One message, its buttons under it, and APEX's follow-up line once a button asks for one. */
function IntroTurn({
  children,
  id,
  note = null,
  text
}: {
  children: ReactNode
  id: 'paste' | 'video' | 'wechat'
  note?: null | string
  text: string
}) {
  return (
    <div className="flex flex-col items-start gap-1.5" data-capability={id}>
      <p className={FIRST_OPEN_BUBBLE_CLASS}>{text}</p>
      {children && <div className="flex flex-wrap gap-1.5 ps-1">{children}</div>}
      {note && (
        <p className={FIRST_OPEN_BUBBLE_CLASS} role="status">
          {note}
        </p>
      )}
    </div>
  )
}
