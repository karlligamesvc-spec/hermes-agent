/**
 * hc-1014 单线对话: the main window's single-thread shell, mounted once by the
 * chat surface. With product single-thread mode on it
 *
 * - looks the thread up for the active profile once the gateway is open;
 * - takes over the Start route: `/` opens the thread instead of the Start page,
 *   so every "new chat" path (⌘N, the File menu, a profile switch, a fresh
 *   draft from anywhere) lands back in the one conversation;
 * - registers the composer middleware that opens segments and refuses sends
 *   outside the thread (composer-middleware.ts);
 * - titles the session the first message of a brand-new thread creates.
 *
 * Off, it does nothing at all: no lookup, no middleware, no navigation.
 */

import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { COMPOSER_AREAS, type ComposerMiddleware } from '@/app/chat/composer/contrib'
import { registry } from '@/contrib/registry'
import { $mainThread, resolveMainThread } from '@/store/main-thread'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { $singleThreadMode, loadSingleThreadFlag } from '@/store/single-thread'
import { isSecondaryWindow } from '@/store/windows'

import { NEW_CHAT_ROUTE, sessionRoute } from '../routes'

import { $pendingThreadClaim, claimCreatedThread, type RequestGateway, singleThreadSend } from './composer-middleware'

export const SINGLE_THREAD_MIDDLEWARE_ID = 'single-thread-send'

export function useSingleThreadShell(requestGateway: RequestGateway): void {
  // The main window only: a pop-out or watch window is a scratch surface, never the thread's owner.
  const singleThread = useStore($singleThreadMode) && !isSecondaryWindow()
  const gatewayOpen = useStore($gatewayState) === 'open'
  const profile = normalizeProfileKey(useStore($activeGatewayProfile))
  const thread = useStore($mainThread)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const requestRef = useRef(requestGateway)
  const profileRef = useRef(profile)

  requestRef.current = requestGateway
  profileRef.current = profile

  useEffect(() => {
    void loadSingleThreadFlag()
  }, [])

  // One lookup per (profile, open gateway); a failed one is retried by the next send.
  useEffect(() => {
    const held = $mainThread.get()

    if (singleThread && gatewayOpen && (held.profile !== profile || held.status === 'unknown')) {
      void resolveMainThread(requestRef.current, profile)
    }
  }, [gatewayOpen, profile, singleThread])

  const threadTip = thread.status === 'found' && thread.profile === profile ? thread.tipId : null

  useEffect(() => {
    if (singleThread && pathname === NEW_CHAT_ROUTE && threadTip) {
      navigate(sessionRoute(threadTip), { replace: true })
    }
  }, [navigate, pathname, singleThread, threadTip])

  useEffect(() => {
    if (!singleThread) {
      return
    }

    const middleware: ComposerMiddleware = {
      handler: draft =>
        singleThreadSend(
          draft,
          () => requestRef.current,
          () => profileRef.current
        )
    }

    const unregister = registry.register({
      area: COMPOSER_AREAS.middleware,
      data: middleware,
      id: SINGLE_THREAD_MIDDLEWARE_ID,
      // Before every other middleware: a send that does not belong in the thread stops here.
      order: -100
    })

    const unlisten = $selectedStoredSessionId.listen(storedId => {
      if (storedId && $pendingThreadClaim.get()) {
        void claimCreatedThread(requestRef.current, storedId)
      }
    })

    return () => {
      unregister()
      unlisten()
    }
  }, [singleThread])
}
