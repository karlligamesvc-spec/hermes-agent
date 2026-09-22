import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { codiconIcon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { getHermesConfigDefaults, getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import {
  Archive,
  Bell,
  Cpu,
  Download,
  Globe,
  Info,
  Keyboard,
  KeyRound,
  RefreshCw,
  Settings2,
  ShieldLock,
  Upload,
  Wrench,
  Zap
} from '@/lib/icons'
import { confirm } from '@/store/confirm'
import { $activeConnectionId } from '@/store/connections'
import { $localModelsEnabled } from '@/store/local-models-flag'
import { notifyError } from '@/store/notifications'
import { $settingsScopeProfile } from '@/store/settings-scope'

import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { AccountSurfaceHeader } from '../overlays/account-surface-header'
import { OverlayIconButton } from '../overlays/overlay-chrome'
import { OverlayMain, OverlayNav, type OverlayNavGroup, OverlaySplitLayout } from '../overlays/overlay-split-layout'
import { OverlayView } from '../overlays/overlay-view'

import { AboutSettings } from './about-settings'
import { AppearanceSettings } from './appearance-settings'
import { ConfigSettings } from './config-settings'
import { SECTIONS } from './constants'
import { GatewaySettings } from './gateway-settings'
import { KeybindSettings } from './keybind-settings'
import { KEYS_VIEWS, KeysSettings, type KeysView } from './keys-settings'
import { movedSettingsTabRedirect } from './moved-tabs'
import { NotificationsSettings } from './notifications-settings'
import { PersonalizationSettings } from './personalization-settings'
import { PROVIDER_VIEWS, ProvidersSettings, type ProviderView } from './providers-settings'
import { SessionsSettings } from './sessions-settings'
import type { SettingsPageProps, SettingsView as SettingsViewId } from './types'
import { vaultOwnerKey, VaultSettings } from './vault-settings'

const SETTINGS_VIEWS: readonly SettingsViewId[] = [
  ...SECTIONS.map(s => `config:${s.id}` as SettingsViewId),
  'providers',
  'gateway',
  // Legacy alias: the Connections page merged into Gateways. Kept in the enum
  // so saved `?tab=connections` deep links still resolve (redirected below).
  'connections',
  'keybinds',
  'keys',
  'vault',
  'notifications',
  'sessions',
  'about'
]

export function SettingsView({ onClose, onConfigSaved, onMainModelChanged }: SettingsPageProps) {
  const scopeProfile = useStore($settingsScopeProfile)
  const activeConnectionId = useStore($activeConnectionId)
  const { t } = useI18n()
  const navigate = useNavigate()
  const { hash, pathname, search } = useLocation()

  // MCP and Plugins moved out of Settings into Capabilities. Keep old
  // `/settings?tab=mcp|plugins` deep links working — `useRouteEnumParam` would
  // silently coerce the unknown tab to the default view otherwise.
  useEffect(() => {
    const redirect = movedSettingsTabRedirect(search)

    if (redirect) {
      navigate(redirect, { replace: true })
    }
  }, [navigate, search])

  const [activeView, setActiveView] = useRouteEnumParam(
    'tab',
    SETTINGS_VIEWS,
    'config:personalization' as SettingsViewId
  )

  // Connections merged into the unified Gateways page: land old
  // `?tab=connections` routes/bookmarks there instead of a dead entry.
  useEffect(() => {
    if (activeView === 'connections') {
      setActiveView('gateway')
    }
  }, [activeView, setActiveView])
  // Providers subnav (Accounts vs API keys) lives in its own param so each
  // sub-view is deep-linkable and survives a refresh.
  const [providerView, setProviderView] = useRouteEnumParam<ProviderView>('pview', PROVIDER_VIEWS, 'accounts')
  const [keysView] = useRouteEnumParam<KeysView>('kview', KEYS_VIEWS, 'tools')

  // Jump to a section + its sub-view in one navigate. Two sequential setters
  // would each read the same stale `search` and the second would clobber the
  // first's `tab` — so the sub-view never opened on narrow screens.
  const openSubView = useCallback(
    (tab: SettingsViewId, param: string, value: string, fallback: string) => {
      const params = new URLSearchParams(search)
      params.set('tab', tab)

      if (value === fallback) {
        params.delete(param)
      } else {
        params.set(param, value)
      }

      const qs = params.toString()
      navigate({ hash, pathname, search: qs ? `?${qs}` : '' }, { replace: true })
    },
    [hash, navigate, pathname, search]
  )

  const openProviderView = useCallback(
    (view: ProviderView) => openSubView('providers', 'pview', view, 'accounts'),
    [openSubView]
  )

  const openKeysView = useCallback((view: KeysView) => openSubView('keys', 'kview', view, 'tools'), [openSubView])

  const importInputRef = useRef<HTMLInputElement | null>(null)

  const exportConfig = async () => {
    try {
      const cfg = await getHermesConfigRecord()
      const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'hermes-config.json'
      a.click()
      URL.revokeObjectURL(url)
      triggerHaptic('success')
    } catch (err) {
      notifyError(err, t.settings.exportFailed)
    }
  }

  const resetConfig = async () => {
    const ok = await confirm({
      confirmLabel: t.settings.resetToDefaults,
      destructive: true,
      title: t.settings.resetConfirm
    })

    if (!ok) {
      return
    }

    try {
      await saveHermesConfig(await getHermesConfigDefaults())
      triggerHaptic('success')
      onConfigSaved?.()
    } catch (err) {
      notifyError(err, t.settings.resetFailed)
    }
  }

  const navGroups: OverlayNavGroup[] = useMemo(
    () => [
      ...SECTIONS.flatMap(s => {
        const view = `config:${s.id}` as SettingsViewId

        const entry = {
          active: activeView === view,
          icon: s.icon,
          id: view,
          label: t.settings.sections[s.id] ?? s.label,
          onSelect: () => setActiveView(view)
        }

        // Credential Vault lives beside the Browser section: it feeds the
        // browser's model-blind vault fill, so the two are one mental unit.
        if (s.id === 'browser') {
          return [
            entry,
            {
              active: activeView === 'vault',
              icon: ShieldLock,
              id: 'vault',
              label: t.settings.nav.vault,
              onSelect: () => setActiveView('vault')
            }
          ]
        }

        return [entry]
      }),
      {
        active: activeView === 'notifications',
        icon: Bell,
        id: 'notifications',
        label: t.settings.nav.notifications,
        onSelect: () => setActiveView('notifications')
      },
      {
        active: activeView === 'providers',
        children: [
          {
            active: activeView === 'providers' && providerView === 'accounts',
            icon: codiconIcon('account'),
            id: 'pview:accounts',
            label: t.settings.nav.providerAccounts,
            onSelect: () => openProviderView('accounts')
          },
          {
            active: activeView === 'providers' && providerView === 'keys',
            icon: KeyRound,
            id: 'pview:keys',
            label: t.settings.nav.providerApiKeys,
            onSelect: () => openProviderView('keys')
          },
          {
            active: activeView === 'providers' && providerView === 'custom-endpoints',
            icon: Globe,
            id: 'pview:custom-endpoints',
            label: t.settings.nav.providerCustomEndpoints,
            onSelect: () => openProviderView('custom-endpoints')
          },
          // Local models ships behind the --local launch flag: no flag, no
          // nav entry (the pane itself also refuses to render, so a stale
          // ?pview=local deep link falls back to accounts-shaped emptiness
          // rather than a hidden feature).
          ...($localModelsEnabled.get()
            ? [
                {
                  active: activeView === 'providers' && providerView === 'local',
                  icon: Cpu,
                  id: 'pview:local',
                  label: t.settings.nav.providerLocalModels,
                  onSelect: () => openProviderView('local')
                }
              ]
            : [])
        ],
        gapBefore: true,
        icon: Zap,
        id: 'providers',
        label: t.settings.nav.providers,
        onSelect: () => setActiveView('providers')
      },
      {
        active: activeView === 'gateway',
        icon: Globe,
        id: 'gateway',
        label: t.settings.nav.gateway,
        onSelect: () => setActiveView('gateway')
      },
      {
        active: activeView === 'keybinds',
        icon: Keyboard,
        id: 'keybinds',
        label: t.settings.nav.keybinds,
        onSelect: () => setActiveView('keybinds')
      },
      {
        active: activeView === 'keys',
        children: [
          {
            active: activeView === 'keys' && keysView === 'tools',
            icon: Wrench,
            id: 'kview:tools',
            label: t.settings.nav.keysTools,
            onSelect: () => openKeysView('tools')
          },
          {
            active: activeView === 'keys' && keysView === 'settings',
            icon: Settings2,
            id: 'kview:settings',
            label: t.settings.nav.keysSettings,
            onSelect: () => openKeysView('settings')
          }
        ],
        icon: KeyRound,
        id: 'keys',
        label: t.settings.nav.apiKeys,
        onSelect: () => setActiveView('keys')
      },
      {
        active: activeView === 'sessions',
        icon: Archive,
        id: 'sessions',
        label: t.settings.nav.archivedChats,
        onSelect: () => setActiveView('sessions')
      },
      {
        active: activeView === 'about',
        icon: Info,
        id: 'about',
        label: t.settings.nav.about,
        onSelect: () => setActiveView('about')
      }
    ],
    [activeView, keysView, providerView, t, setActiveView, openProviderView, openKeysView]
  )

  const navFooter = (
    <>
      <Tip label={t.settings.exportConfig}>
        <OverlayIconButton onClick={() => void exportConfig()}>
          <Download />
        </OverlayIconButton>
      </Tip>
      <Tip label={t.settings.importConfig}>
        <OverlayIconButton
          onClick={() => {
            triggerHaptic('open')
            importInputRef.current?.click()
          }}
        >
          <Upload />
        </OverlayIconButton>
      </Tip>
      <Tip label={t.settings.resetToDefaults}>
        <OverlayIconButton
          className="hover:text-destructive"
          onClick={() => {
            triggerHaptic('warning')
            void resetConfig()
          }}
        >
          <RefreshCw />
        </OverlayIconButton>
      </Tip>
    </>
  )

  const activeSettingsContent =
    activeView === 'config:personalization' ? (
      <PersonalizationSettings onConfigSaved={onConfigSaved} />
    ) : activeView === 'config:appearance' ? (
      <AppearanceSettings />
    ) : activeView === 'about' ? (
      <AboutSettings />
    ) : activeView === 'gateway' || activeView === 'connections' ? (
      // 'connections' renders the unified page too so the frame before
      // the alias redirect lands doesn't flash the fallback view.
      <GatewaySettings />
    ) : activeView === 'keybinds' ? (
      <KeybindSettings />
    ) : activeView.startsWith('config:') ? (
      <ConfigSettings
        activeSectionId={activeView.slice('config:'.length)}
        importInputRef={importInputRef}
        onConfigSaved={onConfigSaved}
        onMainModelChanged={onMainModelChanged}
      />
    ) : activeView === 'providers' ? (
      <ProvidersSettings
        key={scopeProfile}
        onClose={onClose}
        onConfigSaved={onConfigSaved}
        onMainModelChanged={onMainModelChanged}
        onViewChange={setProviderView}
        view={providerView}
      />
    ) : activeView === 'keys' ? (
      <KeysSettings view={keysView} />
    ) : activeView === 'notifications' ? (
      <NotificationsSettings />
    ) : activeView === 'vault' ? (
      <VaultSettings key={vaultOwnerKey(activeConnectionId, scopeProfile)} />
    ) : (
      <SessionsSettings />
    )

  return (
    <OverlayView
      ariaDescribedBy="settings-surface-description"
      ariaLabelledBy="settings-surface-title"
      closeLabel={t.settings.closeSettings}
      compactFullscreen
      containerClassName="max-w-[1024px]"
      onClose={onClose}
    >
      <OverlaySplitLayout className="p5-settings">
        <OverlayNav footer={navFooter} groups={navGroups} />

        <OverlayMain className="px-0 pb-0 pt-0">
          <AccountSurfaceHeader
            className="max-[53rem]:pt-3"
            description={t.settings.description}
            title={t.settings.title}
            titleId="settings-surface-title"
          />
          <span className="sr-only" id="settings-surface-description">
            {t.settings.description}
          </span>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{activeSettingsContent}</div>
        </OverlayMain>
      </OverlaySplitLayout>
    </OverlayView>
  )
}

export { SettingsView as SettingsPage }
