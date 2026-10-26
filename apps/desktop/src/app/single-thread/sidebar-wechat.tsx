/**
 * hc-1061 G3: 「在微信里找 APEX」 at the foot of the single-thread sidebar
 * (prototype v2). It opens the IM entry page (hc-417 / hc-538), where WeChat is
 * bound by scanning a code, and says 「已绑定」 once this machine's assistant has
 * a WeChat binding. Read through the same imEntry bridge the page uses; with
 * no bridge (a web build) the row only offers the page.
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { Codicon } from '@/components/ui/codicon'
import { useSingleThreadSidebarCopy } from '@/i18n/single-thread-sidebar'

import { IM_ENTRY_ROUTE } from '../routes'

import { SINGLE_THREAD_ROW_CLASS } from './sidebar-row'

const WECHAT_CHANNEL = 'weixin'

/** True or false once known; null while the first read is pending. */
function useWechatBound(): boolean | null {
  const [bound, setBound] = useState<boolean | null>(null)

  useEffect(() => {
    const list = typeof window !== 'undefined' ? window.hermesDesktop?.imEntry?.list : undefined
    let cancelled = false

    if (!list) {
      setBound(false)

      return
    }

    list()
      .then(result => {
        if (!cancelled) {
          setBound(result.channels.some(channel => channel.channelId === WECHAT_CHANNEL))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBound(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  return bound
}

export function SingleThreadWechatRow() {
  const copy = useSingleThreadSidebarCopy()
  const navigate = useNavigate()
  const bound = useWechatBound()

  return (
    <button
      className={SINGLE_THREAD_ROW_CLASS}
      data-single-thread-wechat={bound === null ? '' : bound ? 'bound' : 'unbound'}
      onClick={() => navigate(IM_ENTRY_ROUTE)}
      type="button"
    >
      <Codicon className="shrink-0 text-(--ui-text-secondary)" name="device-mobile" size="1.125rem" />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[0.875rem] text-(--ui-text-primary)">{copy.wechatTitle}</span>
        {bound === null ? null : (
          <span className="truncate pt-0.5 text-[0.75rem] text-(--ui-text-tertiary)">
            {bound ? copy.wechatBound : copy.wechatUnbound}
          </span>
        )}
      </span>
    </button>
  )
}
