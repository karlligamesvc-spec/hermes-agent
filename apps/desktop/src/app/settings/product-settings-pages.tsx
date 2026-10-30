/**
 * hc-1109: what product mode's Settings shows that the other modes don't — its
 * rail (product-settings.ts says which tabs, in which order) and the 记忆,
 * 连接微信和飞书 and 用量 pages.
 */

import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { useChatcutCopy } from '@/i18n/chatcut'
import { useSettingsProductCopy } from '@/i18n/settings-product'
import { formatUsedPercent, useSingleThreadSidebarCopy } from '@/i18n/single-thread-sidebar'
import { BarChart3, Brain, MessageCircle, Video } from '@/lib/icons'
import { $authState } from '@/store/auth'
import { readChatcutFlag } from '@/store/chatcut'
import { $planUsage, planUsageFor, planUsageOwner, refreshPlanUsage } from '@/store/plan-usage'

import { ImEntryView } from '../im-entry'
import type { OverlayNavGroup } from '../overlays/overlay-split-layout'
import { PROFILE_STATS_ROUTE } from '../routes'

import { ChatcutSettings } from './chatcut-settings'
import { MemoryLedgerSettings } from './memory-ledger-settings'
import { ListRow, SectionHeading, SettingsContent } from './primitives'
import { $productSettingsViews } from './product-settings'
import type { SettingsView } from './types'

/** The rail as given outside product mode; in product mode only the kept tabs, in product order. */
export function useProductSettingsRail(
  groups: OverlayNavGroup[],
  activeView: string,
  select: (view: SettingsView) => void
): OverlayNavGroup[] {
  const views = useStore($productSettingsViews)
  const copy = useSettingsProductCopy()
  const chatcutCopy = useChatcutCopy()

  // A local disk read through main: the rail picks ChatCut up once the switch says so.
  useEffect(() => {
    void readChatcutFlag()
  }, [])

  return useMemo(() => {
    if (!views) {
      return groups
    }

    const byId = new Map(groups.map(group => [group.id, group]))

    const own = (id: SettingsView, icon: OverlayNavGroup['icon'], label: string): OverlayNavGroup => ({
      active: activeView === id,
      icon,
      id,
      label,
      onSelect: () => select(id)
    })

    const memory = byId.get('config:memory')

    const productOnly: Partial<Record<string, OverlayNavGroup>> = {
      'config:memory': memory && { ...memory, label: copy.memory },
      chatcut: own('chatcut', Video, chatcutCopy.title),
      im: own('im', MessageCircle, copy.im),
      usage: own('usage', BarChart3, copy.usage)
    }

    // One short list: no gap before 提供方 (developer mode sets one off its sub-nav).
    return views.flatMap(view => {
      const group = productOnly[view] ?? byId.get(view)

      return group ? [{ ...group, gapBefore: false }] : []
    })
  }, [activeView, chatcutCopy.title, copy, groups, select, views])
}

/** The page for a product-only tab (and 记忆, the ledger here); null for every other tab. */
export function productSettingsPage(view: string): ReactNode {
  switch (view) {
    case 'config:memory':
      return <ProductMemorySettings />

    case 'chatcut':
      return <ChatcutSettings />

    case 'im':
      return <ProductImSettings />

    case 'usage':
      return <ProductUsageSettings />

    default:
      return null
  }
}

/** 它记得什么: the account's ledger, so without an APEX account it says how to get one. */
function ProductMemorySettings() {
  const copy = useSettingsProductCopy()
  const { accountId, status } = useStore($authState)

  return (
    <SettingsContent>
      {status === 'signed-in' && accountId ? (
        <MemoryLedgerSettings />
      ) : (
        <>
          <SectionHeading icon={Brain} title={copy.memory} />
          <p className="p5-section-intro">{copy.memorySignedOut}</p>
        </>
      )}
    </SettingsContent>
  )
}

/** The 消息渠道 page (scan to bind WeChat or Feishu), the same one the account menu's 助手 page embeds. */
function ProductImSettings() {
  const { t } = useI18n()
  const copy = useSettingsProductCopy()

  return (
    <SettingsContent>
      <SectionHeading icon={MessageCircle} title={copy.im} />
      <p className="p5-section-intro">{t.imEntry.intro}</p>
      <ImEntryView className="-mx-5 w-auto" embedded />
    </SettingsContent>
  )
}

/** The plan and this period's usage, the line the sidebar's account row shows, and the way to the history. */
function ProductUsageSettings() {
  const copy = useSettingsProductCopy()
  const sidebar = useSingleThreadSidebarCopy()
  const navigate = useNavigate()
  const auth = useStore($authState)
  const owner = planUsageOwner(auth)
  const usage = planUsageFor(useStore($planUsage), owner)
  const signedIn = auth.status === 'signed-in'

  useEffect(() => {
    if (signedIn) {
      void refreshPlanUsage(owner)
    }
  }, [owner, signedIn])

  const used =
    usage &&
    (usage.usedRatio === null
      ? copy.usageUnlimited
      : copy.usageUsed({ percent: formatUsedPercent(usage.usedRatio, sidebar), period: usage.period }))

  return (
    <SettingsContent>
      <SectionHeading icon={BarChart3} title={copy.usage} />
      <p className="p5-section-intro">{copy.usageIntro}</p>
      <div className="p5-card p5-rows mt-3.5">
        <ListRow
          action={
            <Button onClick={() => navigate(PROFILE_STATS_ROUTE)} size="sm" type="button" variant="outline">
              {copy.usageHistory}
            </Button>
          }
          description={used || undefined}
          title={usage ? usage.planName : copy.usageNone}
        />
      </div>
    </SettingsContent>
  )
}
