import { $authState } from '@/store/auth'
import { $pendingDesktopLoginCode } from '@/store/onboarding'

import { requestComposerFocus, requestComposerInsert } from './chat/composer/focus'

interface DesktopDeepLinkPayload {
  kind: string
  name: string
  params: Record<string, string>
}

export function handleDesktopDeepLinkPayload(payload: DesktopDeepLinkPayload | null | undefined): void {
  if (!payload) {
    return
  }

  if (payload.kind === 'login') {
    const code = typeof payload.params?.code === 'string' ? payload.params.code.trim() : ''

    if (code && $authState.get().status !== 'signed-in') {
      $pendingDesktopLoginCode.set(code)
    }

    return
  }

  if (payload.kind !== 'blueprint' || !payload.name) {
    return
  }

  const slots = Object.entries(payload.params || {})
    .map(([key, value]) => {
      const escaped = /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value

      return `${key}=${escaped}`
    })
    .join(' ')

  requestComposerInsert(`/blueprint ${payload.name}${slots ? ' ' + slots : ''}`, { mode: 'block', target: 'main' })
  requestComposerFocus('main')
}
