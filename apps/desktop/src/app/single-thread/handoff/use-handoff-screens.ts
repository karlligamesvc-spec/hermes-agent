/**
 * hc-1087: the relay screens' part of the multi-bot shell (use-multi-bot-shell.ts):
 * while relay is on, a send naming another assistant becomes the confirm card
 * (mention.ts), ahead of the single-thread middleware. Off, nothing is
 * registered and the composer's chain is exactly what it was.
 */

import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { COMPOSER_AREAS, type ComposerMiddleware } from '@/app/chat/composer/contrib'
import { registry } from '@/contrib/registry'
import { $handoffMode } from '@/store/single-thread-handoff'
import { dismissHandoffProposal } from '@/store/single-thread-handoff-confirm'

import { handoffMentionSend } from './mention'

export const HANDOFF_MENTION_MIDDLEWARE_ID = 'single-thread-handoff-mention'

export function useHandoffScreens(multiBot: boolean): void {
  const on = useStore($handoffMode) && multiBot

  useEffect(() => {
    if (!on) {
      return
    }

    const middleware: ComposerMiddleware = { handler: handoffMentionSend }

    const unregister = registry.register({
      area: COMPOSER_AREAS.middleware,
      data: middleware,
      id: HANDOFF_MENTION_MIDDLEWARE_ID,
      // Before the single-thread one (-100): a relay never opens a segment or claims a thread.
      order: -200
    })

    return () => {
      unregister()
      // A card left up when relay went off would start nothing: take it down.
      dismissHandoffProposal()
    }
  }, [on])
}
