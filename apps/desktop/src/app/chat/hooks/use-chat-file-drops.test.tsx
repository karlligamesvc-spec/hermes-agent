import { act, renderHook } from '@testing-library/react'
import type { DragEvent as ReactDragEvent } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requestComposerInsert } from '@/app/chat/composer/focus'

import { useChatFileDrops } from './use-chat-file-drops'
import { HERMES_PATHS_MIME } from './use-composer-actions'

vi.mock(import('@/app/chat/composer/focus'), async importOriginal => ({
  ...(await importOriginal()),
  requestComposerInsert: vi.fn()
}))

/** A project-tree drag: a workspace path the gateway resolves itself. */
function projectTreeDrop(path: string): ReactDragEvent {
  const payload = JSON.stringify([{ path }])

  return {
    dataTransfer: {
      files: { item: () => null, length: 0 },
      getData: (type: string) => (type === HERMES_PATHS_MIME ? payload : ''),
      items: [],
      types: [HERMES_PATHS_MIME]
    },
    preventDefault: () => {}
  } as unknown as ReactDragEvent
}

describe('useChatFileDrops', () => {
  beforeEach(() => {
    vi.mocked(requestComposerInsert).mockClear()
  })

  it.each([
    // Start zero-state: the rich composer is hidden, so the drop stages on the visible draft.
    { chatBarVisible: false, inline: false, surface: 'business Start' },
    // A Workflow Run or Project drawer over Start shows the chat composer: refs stay inline, as before hc-906.
    { chatBarVisible: true, inline: true, surface: 'drawer over business Start' }
  ])('routes a project-tree drag on the $surface', ({ chatBarVisible, inline }) => {
    const onAttachDroppedItems = vi.fn()

    const { result } = renderHook(() =>
      useChatFileDrops({
        busy: false,
        businessStartVisible: true,
        chatBarVisible,
        composerTarget: 'main',
        currentCwd: '/work',
        gatewayOpen: true,
        onAttachDroppedItems
      })
    )

    act(() => result.current.dropHandlers.onDrop(projectTreeDrop('/work/src/app.ts')))

    if (inline) {
      expect(requestComposerInsert).toHaveBeenCalledOnce()
      expect(onAttachDroppedItems).not.toHaveBeenCalled()
    } else {
      expect(onAttachDroppedItems).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ isDirectory: false, path: '/work/src/app.ts' })
      ])
      expect(requestComposerInsert).not.toHaveBeenCalled()
    }
  })
})
