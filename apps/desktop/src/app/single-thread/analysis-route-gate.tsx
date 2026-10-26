/**
 * hc-1070: single-thread product mode has no 沉浸式分析. The sidebar and the
 * account menu carry no entry for it, and this gate closes the route itself:
 * every other way in (a route remembered from developer mode on a cold start,
 * history back, a hermes://open deep link, a plugin notification or
 * host.navigate) ends on `/analysis`, so product mode turns back to `/`, which
 * the single-thread shell opens as the conversation. It wraps the whole route
 * element, sign-in gate included, so nothing of the workspace mounts first.
 *
 * Developer mode and the switch off render the workspace as before.
 */

import type { ReactNode } from 'react'
import { Navigate } from 'react-router'

import { useSingleThreadMode } from '@/store/single-thread'

import { NEW_CHAT_ROUTE } from '../routes'

export function AnalysisRouteGate({ children }: { children: ReactNode }) {
  return useSingleThreadMode() ? <Navigate replace to={NEW_CHAT_ROUTE} /> : children
}
