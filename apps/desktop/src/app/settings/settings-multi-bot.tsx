/**
 * hc-1077: Settings while several assistants are on. The pages change the
 * profile in scope (the assistant on screen), so the title says whose they
 * are — 「小红书文案 的设置」; the model / tier page is the exception (K3: the
 * tier is the account's, model-tier-settings.tsx `ModelSection`), and says
 * so above it. With one assistant both render exactly what they did.
 *
 * hc-1133: 账号, 套餐 and 用量 are the account's too, so their title names nobody.
 */

import { useStore } from '@nanostores/react'
import type { ComponentProps, ReactNode } from 'react'
import { useLocation } from 'react-router'

import { useMultiBotCopy } from '@/i18n/multi-bot'
import { $settingsScopeProfile } from '@/store/settings-scope'
import { $apexBot, $botRoster, botFor, useMultiBotMode } from '@/store/single-thread-bots'

import { AccountSurfaceHeader } from '../overlays/account-surface-header'

import { settingsTabAccountWide } from './product-settings'

export function SettingsSurfaceHeader(props: ComponentProps<typeof AccountSurfaceHeader>) {
  const copy = useMultiBotCopy()
  const multiBot = useMultiBotMode()
  const scope = useStore($settingsScopeProfile)
  const roster = useStore($botRoster)
  const accountWide = settingsTabAccountWide(new URLSearchParams(useLocation().search).get('tab'))
  const title = multiBot && !accountWide ? copy.settingsTitle(botFor(roster, scope).name) : props.title

  return <AccountSurfaceHeader {...props} title={title} />
}

/** Over the model / tier page when it edits APEX's on another assistant's screen. */
export function SharedTierNote({ children }: { children: ReactNode }) {
  const copy = useMultiBotCopy()
  const apexName = useStore($apexBot)?.name ?? ''

  return (
    <div className="grid gap-4" data-shared-tier-note="">
      <p className="rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary)/40 px-3 py-2 text-xs leading-5 text-foreground">
        {copy.sharedTierNote(apexName)}
      </p>
      {children}
    </div>
  )
}
