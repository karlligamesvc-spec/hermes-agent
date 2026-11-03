/**
 * hc-1085 identity guard harness. Renders the left column the way the goldens
 * beside this file were recorded on fork main aa8e554e38, before hc-1085
 * existed: the zone that holds the sessions pane, its tab strip included.
 *
 * - The sessions pane carries the core contribution's chrome (controller.tsx:
 *   left, collapsible, hide-only, 「会话」 tab title) around the real
 *   SidebarSurface.
 * - Bot Mode's pane is the real hermes-bots plugin's: its `register()` runs
 *   against the real plugin context, and the real tree adoption docks the pane
 *   wherever the plugin asks.
 *
 * It must keep using only APIs main already had: the same file recorded the
 * goldens there. The caller sets the switches and mocks the plugin's clocks,
 * sockets and sweeps; this file only mounts the zone and returns its HTML.
 */
// First: the recording time zone, before any app module or fixture (time-zone.ts).
import '../single-thread-shell/time-zone'

import { useStore } from '@nanostores/react'
import { act, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { SidebarSurface } from '@/app/contrib/surfaces'
import type { SidebarActions } from '@/app/contrib/types'
import { findGroupOfPane, group, type LayoutNode, split } from '@/components/pane-shell/tree/model'
import { TreeGroup } from '@/components/pane-shell/tree/renderer/tree-group'
import {
  $dismissedPanes,
  $hiddenTreePanes,
  $layoutTree,
  adoptContributedPanes,
  resetEnforcedDocks
} from '@/components/pane-shell/tree/store'
import { SidebarProvider } from '@/components/ui/sidebar'
import { createPluginContext } from '@/contrib/plugin'
import { registry } from '@/contrib/registry'
import { I18nProvider, useI18n } from '@/i18n'
import botMode from '@/plugins/hermes-bots/plugin'

import { normalized } from '../single-thread-shell/render'

export { normalized }

const noop = () => {}

const SIDEBAR_ACTIONS: SidebarActions = {
  onArchiveSession: noop,
  onBranchSession: noop,
  onDeleteSession: noop,
  onLoadMoreSessions: noop,
  onManageCronJob: noop,
  onNavigate: noop,
  onNewSessionInWorkspace: noop,
  onNewSessionSplit: noop,
  onResumeSession: noop,
  onTriggerCronJob: noop
}

const SessionsTabTitle = () => <>{useI18n().t.sidebar.sessions}</>

/** The default layout's two columns before any plugin pane joins them (layout-presets.ts). */
export const BOOT_TREE: LayoutNode = split(
  'row',
  [group(['sessions'], { id: 'grp-sessions' }), group(['workspace'], { id: 'grp-main' })],
  [1, 4.6]
)

/** The core panes the zone needs: sessions (with the real sidebar) and the main workspace it docks beside. */
function registerCorePanes(): () => void {
  return registry.registerMany([
    {
      area: 'panes',
      data: {
        collapsible: true,
        dock: { pane: 'workspace', pos: 'left' },
        hideOnly: true,
        placement: 'left',
        revealAliases: ['chat-sidebar'],
        tabTitle: () => <SessionsTabTitle />
      },
      id: 'sessions',
      render: () => (
        <SidebarProvider>
          <SidebarSurface actions={SIDEBAR_ACTIONS} currentView="chat" />
        </SidebarProvider>
      ),
      title: 'Sessions'
    },
    {
      area: 'panes',
      data: { placement: 'main', uncloseable: true },
      id: 'workspace',
      render: () => null,
      title: 'New session'
    }
  ])
}

export interface MountedLayout {
  /** Tear down the plugin, the core panes and adoption. */
  dispose: () => void
}

/**
 * Boot the layout: core panes, the tree (BOOT_TREE unless one was persisted),
 * live adoption, then Bot Mode through the real plugin context.
 */
export function mountLayout(tree: LayoutNode = BOOT_TREE): MountedLayout {
  const disposers: (() => void)[] = []

  resetEnforcedDocks()
  $dismissedPanes.set(new Set())
  $hiddenTreePanes.set(new Set())
  disposers.push(registerCorePanes())
  $layoutTree.set(tree)
  disposers.push(registry.subscribe(adoptContributedPanes))
  adoptContributedPanes()
  botMode.register(createPluginContext(botMode.id, dispose => disposers.push(dispose)))

  return {
    dispose: () =>
      disposers
        .splice(0)
        .reverse()
        .forEach(dispose => dispose())
  }
}

function SidebarZone() {
  const tree = useStore($layoutTree)
  const zone = tree ? findGroupOfPane(tree, 'sessions') : null

  return zone ? <TreeGroup leftEdge node={zone} parentAxis="row" railSide="left" topEdge /> : null
}

/** The left column as mounted: the zone holding the sessions pane, strip and all. */
export async function sidebarZoneHtml(): Promise<string> {
  const view = render(
    <MemoryRouter initialEntries={['/chat-a']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <SidebarZone />
      </I18nProvider>
    </MemoryRouter>
  )

  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

  return normalized(view.container.innerHTML) + '\n'
}
