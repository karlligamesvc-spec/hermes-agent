import { type FC, useCallback, useMemo, useState } from 'react'

import { AssistantMessage } from '@/components/assistant-ui/thread/assistant-message'
import { ThreadMessageList } from '@/components/assistant-ui/thread/list'
import {
  BackgroundResumeNotice,
  CenteredThreadSpinner,
  ResponseLoadingIndicator
} from '@/components/assistant-ui/thread/status'
import { SystemMessage } from '@/components/assistant-ui/thread/system-message'
import { ThreadTimeline } from '@/components/assistant-ui/thread/timeline'
import { type RestoreMessageTarget } from '@/components/assistant-ui/thread/types'
import { UserEditComposer } from '@/components/assistant-ui/thread/user-edit-composer'
import { UserMessage } from '@/components/assistant-ui/thread/user-message'
import { Intro, type IntroProps } from '@/components/chat/intro'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { HermesGateway } from '@/hermes'
import { useI18n } from '@/i18n'
import { notifyError } from '@/store/notifications'

type ThreadLoadingState = 'response' | 'session'

export const Thread: FC<{
  clampToComposer?: boolean
  cwd?: string | null
  gateway?: HermesGateway | null
  intro?: IntroProps
  loading?: ThreadLoadingState
  onBranchInNewChat?: (messageId: string) => void
  onCancel?: () => Promise<void> | void
  onDismissError?: (messageId: string) => void
  onRestoreToMessage?: (messageId: string, target?: RestoreMessageTarget) => Promise<void> | void
  sessionId?: string | null
  sessionKey?: string | null
}> = ({
  clampToComposer = false,
  cwd = null,
  gateway = null,
  intro,
  loading,
  onBranchInNewChat,
  onCancel,
  onDismissError,
  onRestoreToMessage,
  sessionId = null,
  sessionKey
}) => {
  const { t } = useI18n()
  const copy = t.assistant.thread

  const [restoreConfirmTarget, setRestoreConfirmTarget] = useState<
    (RestoreMessageTarget & { messageId: string }) | null
  >(null)

  const closeRestoreConfirm = useCallback(() => setRestoreConfirmTarget(null), [])

  const confirmRestore = useCallback(() => {
    if (!restoreConfirmTarget || !onRestoreToMessage) {
      throw new Error('Restore is unavailable for this message.')
    }

    const { messageId, text, userOrdinal } = restoreConfirmTarget

    closeRestoreConfirm()
    void Promise.resolve(onRestoreToMessage(messageId, { text, userOrdinal })).catch((error: unknown) => {
      notifyError(error, 'Restore failed')
    })
  }, [closeRestoreConfirm, onRestoreToMessage, restoreConfirmTarget])

  const requestRestoreConfirm = useCallback((messageId: string, target: RestoreMessageTarget) => {
    setRestoreConfirmTarget({ messageId, ...target })
  }, [])

  const messageComponents = useMemo(
    () => ({
      AssistantMessage: () => (
        <AssistantMessage onBranchInNewChat={onBranchInNewChat} onDismissError={onDismissError} />
      ),
      SystemMessage,
      UserEditComposer: () => <UserEditComposer cwd={cwd} gateway={gateway} sessionId={sessionId} />,
      UserMessage: () => (
        <UserMessage
          onCancel={onCancel}
          onRequestRestoreConfirm={onRestoreToMessage ? requestRestoreConfirm : undefined}
        />
      )
    }),
    [cwd, gateway, onBranchInNewChat, onCancel, onDismissError, onRestoreToMessage, requestRestoreConfirm, sessionId]
  )

  const emptyPlaceholder = intro ? (
    // Scroll-safe centering: the greeting alone centers as before, but the
    // hc-554 scenario shelf can make the block taller than the viewport — the
    // outer scroll + min-h-full inner center-if-fits/scroll-if-not pattern keeps
    // the top reachable (a plain justify-center flex clips it). Symmetric
    // composer-height padding clears the floating composer top and bottom.
    // The bar itself stays hidden (Kael, hc-590 review): the zero state should
    // read as a calm landing surface, not a scrolling document — content still
    // scrolls when the window is short, same idiom as the terminal rail.
    <div className="min-h-0 w-full overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex min-h-full w-full flex-col items-center justify-center py-[var(--composer-measured-height)]">
        <Intro {...intro} />
      </div>
    </div>
  ) : undefined

  return (
    <div className="relative grid h-full min-h-0 max-w-full grid-rows-[minmax(0,1fr)] overflow-hidden bg-transparent contain-[layout_paint]">
      <ThreadMessageList
        clampToComposer={clampToComposer}
        components={messageComponents}
        emptyPlaceholder={emptyPlaceholder}
        loadingIndicator={loading === 'response' ? <ResponseLoadingIndicator /> : <BackgroundResumeNotice />}
        sessionKey={sessionKey}
      />
      {loading === 'session' && <CenteredThreadSpinner />}
      <ThreadTimeline />
      <ConfirmDialog
        confirmLabel={copy.restoreConfirm}
        description={copy.restoreBody}
        destructive
        onClose={closeRestoreConfirm}
        onConfirm={confirmRestore}
        open={Boolean(restoreConfirmTarget)}
        title={copy.restoreTitle}
      />
    </div>
  )
}
