/**
 * APEX's items at the head of the strip above the composer, as one element in
 * ChatBar (whose own lines are capped by the code-health ratchet): the
 * messages held while the conversation opens (hc-1146, held-sends-strip.tsx),
 * then the paste-to-act chips (hc-994). Each renders nothing until it has
 * something to show.
 */

import type { ComponentProps } from 'react'

import { ComposerPasteActions } from '@/app/chat/composer/paste-action-chips'

import { HeldSendsStrip } from './held-sends-strip'

export function ComposerStripHead(props: ComponentProps<typeof ComposerPasteActions>) {
  return (
    <>
      <HeldSendsStrip />
      <ComposerPasteActions {...props} />
    </>
  )
}
