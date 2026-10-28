/**
 * hc-1078 (multi-bot M2): 「删掉「X」？」. Deleting is for real (K9): the assistant's profile goes,
 * and with it its conversations, the images and videos its tools saved on this computer and its
 * copy of the skills. The text says so, and says what stays: 「关于你」, 交付物 and usage belong to
 * the account. There is no undo and no bin.
 */

import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useSingleThreadBotsCopy } from '@/i18n/single-thread-bots'
import { deleteBot } from '@/store/single-thread-bot-ops'

export interface BotDeleteTarget {
  name: string
  profile: string
}

export function BotDeleteConfirm({
  onClose,
  onDeleted,
  target
}: {
  onClose: () => void
  onDeleted: (profile: string) => void
  /** null keeps it closed. */
  target: BotDeleteTarget | null
}) {
  const copy = useSingleThreadBotsCopy()

  async function confirm() {
    if (!target) {
      return
    }

    try {
      await deleteBot(target.profile)
    } catch {
      throw new Error(copy.deleteFailed)
    }

    onDeleted(target.profile)
  }

  return (
    <ConfirmDialog
      busyLabel={copy.deleting}
      cancelLabel={copy.deleteCancel}
      confirmLabel={copy.deleteConfirm}
      description={copy.deleteBody}
      destructive
      onClose={onClose}
      onConfirm={confirm}
      open={target !== null}
      title={target ? copy.deleteTitle(target.name) : ''}
    />
  )
}
