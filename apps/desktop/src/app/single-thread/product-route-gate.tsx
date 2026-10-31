/**
 * The pages single-thread product mode does not have: 沉浸式分析 (hc-1070), 项目
 * and 工作流 (hc-1123). Their menu items and page buttons are folded, and this gate
 * closes the routes themselves: every other way in (a route remembered from
 * developer mode on a cold start, history back, a hermes://open deep link, a
 * plugin notification or host.navigate) ends on the route, so product mode turns
 * back to `/`, which the single-thread shell opens as the conversation. It wraps
 * the whole route element, sign-in gate included, so nothing of the workspace
 * mounts first.
 *
 * Developer mode and the switch off render the workspace as before.
 */

import type { ReactNode } from 'react'
import { Navigate } from 'react-router'

import { useSingleThreadMode } from '@/store/single-thread'

import { ASSISTANT_ROUTE, NEW_CHAT_ROUTE, WORKFLOWS_ROUTE } from '../routes'

export function ProductRouteGate({ children }: { children: ReactNode }) {
  return useSingleThreadMode() ? <Navigate replace to={NEW_CHAT_ROUTE} /> : children
}

/**
 * The page under a run drawer opened with no source, and where closing it lands.
 * 工作流 is closed in product mode, and a drawer over a closed page would close
 * itself; 连接助手 is the one place that lists runs there.
 */
export function useRunDrawerHome(): string {
  return useSingleThreadMode() ? ASSISTANT_ROUTE : WORKFLOWS_ROUTE
}
