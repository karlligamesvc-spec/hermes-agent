/**
 * hc-1146 切换助手不闪屏: the router's half of opening an assistant's thread
 * at once (openBot in store/single-thread-bots.ts), mounted by
 * useMultiBotShell while several assistants are on. It
 *
 * - installs the navigation openBot calls when this window already knows the
 *   thread of the assistant clicked: straight to that conversation, with no
 *   fresh draft (and its blank frame) on the way;
 * - once the lookup for that assistant lands (the shell keeps it running,
 *   resolveMainThread with `seed`), moves the route on when the thread's tip
 *   is no longer the one opened: a segment that rotated while the assistant
 *   worked in the background. Only the route a click opened is moved; any
 *   other navigation is left alone.
 *
 * Off (or in a pop-out window) it does nothing.
 */

import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { $mainThread } from '@/store/main-thread'
import { setBotThreadOpener } from '@/store/single-thread-bots'

import { sessionRoute } from '../routes'

export function useBotThreadOpen(multiBot: boolean): void {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const thread = useStore($mainThread)
  const pathnameRef = useRef(pathname)
  // The thread a click opened, until its own lookup lands.
  const opened = useRef<null | { profile: string; route: string }>(null)

  pathnameRef.current = pathname

  // A marker of what a click opened, not a mirror of an atom.
  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (!multiBot) {
      return
    }

    return setBotThreadOpener((tipId, profile) => {
      const route = sessionRoute(tipId)

      opened.current = { profile, route }

      if (pathnameRef.current !== route) {
        navigate(route)
      }
    })
  }, [multiBot, navigate])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    const open = opened.current

    // Not that thread's confirmed lookup yet: still the assistant being left, or only the seeded paint.
    if (!multiBot || !open || thread.profile !== open.profile || thread.seeded || !thread.tipId) {
      return
    }

    opened.current = null
    const tip = sessionRoute(thread.tipId)

    if (pathname === open.route && tip !== open.route) {
      navigate(tip, { replace: true })
    }
  }, [multiBot, navigate, pathname, thread])
}
