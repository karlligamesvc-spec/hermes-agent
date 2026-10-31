/**
 * hc-1122: ChatCut in product mode's Settings, shown only with the switch on.
 *
 * The state, and 断开. Connecting is not here on purpose: it happens in the
 * conversation, where the assistant asks on a choice card when the user wants to
 * edit a video. The page speaks for the assistant on screen, like the other
 * settings pages (the header names it): each assistant connects on its own.
 *
 * 断开 goes through the ordinary "remove this server" route; the engine's seam
 * (apex_overlay/chatcut.py) takes the tokens and the upload consent with it.
 */

import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useState } from 'react'

import { capabilityScoped, type ProfileScope } from '@/api/client'
import { removeMcpServer } from '@/api/mcp'
import { Button } from '@/components/ui/button'
import { useChatcutCopy } from '@/i18n/chatcut'
import { Video } from '@/lib/icons'
import { CHATCUT_SERVER } from '@/store/chatcut'
import { $settingsRequestProfile } from '@/store/settings-scope'
import type { McpServerSummary } from '@/types/hermes'

import { ListRow, SectionHeading, SettingsContent } from './primitives'

type Connection = 'connected' | 'not-connected' | 'unknown'

function readConnection(profile: ProfileScope | undefined): Promise<Connection> {
  return window.hermesDesktop
    .api<{ servers: McpServerSummary[] }>({ ...capabilityScoped(profile), path: '/api/mcp/servers' })
    .then(({ servers }): Connection => (servers.some(server => server.name === CHATCUT_SERVER) ? 'connected' : 'not-connected'))
    .catch((): Connection => 'unknown')
}

export function ChatcutSettings() {
  const copy = useChatcutCopy()
  const profile = useStore($settingsRequestProfile) ?? undefined
  const [connection, setConnection] = useState<Connection | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let current = true

    setConnection(null)
    setConfirming(false)
    setFailed(false)
    void readConnection(profile).then(next => {
      if (current) {
        setConnection(next)
      }
    })

    return () => {
      current = false
    }
  }, [profile])

  const disconnect = useCallback(async () => {
    setWorking(true)
    setFailed(false)

    try {
      await removeMcpServer(CHATCUT_SERVER, profile)
      setConnection('not-connected')
      setConfirming(false)
    } catch {
      setFailed(true)
    } finally {
      setWorking(false)
    }
  }, [profile])

  const state =
    connection === 'connected'
      ? { description: copy.connectedHint, title: copy.connected }
      : connection === 'not-connected'
        ? { description: copy.notConnectedHint, title: copy.notConnected }
        : connection === 'unknown'
          ? { description: undefined, title: copy.unknown }
          : null

  return (
    <SettingsContent>
      <SectionHeading icon={Video} title={copy.title} />
      <p className="p5-section-intro">{copy.intro}</p>
      {state && (
        <div className="p5-card p5-rows mt-3.5" data-chatcut-state={connection}>
          <ListRow
            action={
              connection === 'connected' ? (
                <Button
                  disabled={working}
                  onClick={() => (confirming ? void disconnect() : setConfirming(true))}
                  size="sm"
                  type="button"
                  variant={confirming ? 'destructive' : 'outline'}
                >
                  {working ? copy.disconnecting : copy.disconnect}
                </Button>
              ) : undefined
            }
            description={confirming ? copy.disconnectConfirm : state.description}
            title={state.title}
          />
        </div>
      )}
      {failed && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {copy.disconnectFailed}
        </p>
      )}
      <p className="mt-3 text-xs text-(--ui-text-tertiary)">{copy.privacy}</p>
    </SettingsContent>
  )
}
