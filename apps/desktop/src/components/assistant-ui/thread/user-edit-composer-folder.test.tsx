// hc-1207: a Finder folder dropped into the inline edit composer is granted to the session like a
// chip in the main composer, and its granted ref is what lands in the edited message. A folder
// main will not sign keeps the inline @folder: ref a dropped folder always got there.

import { AssistantRuntimeProvider, ExportedMessageRepository, type ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useIncrementalExternalStoreRuntime } from '@/lib/incremental-external-store-runtime'
import { $connection } from '@/store/session'

import { assistantMessage, stubThreadEnvironment, stubThreadViewportSize, userMessage } from '../test-utils'

import { Thread } from '.'

stubThreadEnvironment()
stubThreadViewportSize()

const SESSION = 'rt-edit'
const FOLDER = '/Users/alice/Downloads/素材 一批'

afterEach(() => {
  cleanup()
  $connection.set(null)
  Reflect.deleteProperty(window, 'hermesDesktop')
})

function Harness({ gateway }: { gateway: { request: (method: string, params?: Record<string, unknown>) => Promise<unknown> } }) {
  const runtime = useIncrementalExternalStoreRuntime<ThreadMessage>({
    isRunning: false,
    messageRepository: ExportedMessageRepository.fromArray([userMessage(), assistantMessage()]),
    onCancel: async () => {},
    onEdit: async () => {},
    onNew: async () => {},
    onReload: async () => {},
    setMessages: () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread cwd="/Users/alice/.apexnodes/profiles/apex-bot-2" gateway={gateway as never} sessionId={SESSION} />
    </AssistantRuntimeProvider>
  )
}

function folderDrop(): DataTransfer {
  const folder = new File([], '素材 一批')

  return {
    files: { item: () => folder, length: 1 },
    getData: () => '',
    items: [{ getAsFile: () => folder, kind: 'file', type: '', webkitGetAsEntry: () => ({ isDirectory: true }) }],
    types: ['Files']
  } as unknown as DataTransfer
}

async function dropFolderIntoEdit(grants: Record<string, string>) {
  $connection.set({ mode: 'local' } as never)

  const folderGrants = vi.fn(async () => grants)

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { folderGrants, getPathForFile: () => FOLDER }
  })

  const request = vi.fn(async (method: string) =>
    method === 'folder.attach' ? { attached: true, ref_text: '@folder:`/private/Users/alice/Downloads/素材 一批`' } : {}
  )

  render(<Harness gateway={{ request }} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }))

  const editor = await screen.findByRole('textbox', { name: 'Edit message' })

  await act(async () => {
    fireEvent.drop(editor, { dataTransfer: folderDrop() })
  })

  return { editor, folderGrants, request }
}

describe('a folder dropped into the edit composer', () => {
  it('is granted to the session and lands as the granted ref', async () => {
    const { editor, folderGrants, request } = await dropFolderIntoEdit({ [FOLDER]: 'signed-by-main' })

    await waitFor(() =>
      expect(editor.querySelector('[data-ref-text]')?.getAttribute('data-ref-text')).toBe(
        '@folder:`/private/Users/alice/Downloads/素材 一批`'
      )
    )
    expect(folderGrants).toHaveBeenCalledExactlyOnceWith([FOLDER])
    expect(request).toHaveBeenCalledWith('folder.attach', { grant: 'signed-by-main', path: FOLDER, session_id: SESSION })
  })

  it('keeps the inline ref it always got when main will not sign it', async () => {
    const { editor, request } = await dropFolderIntoEdit({})

    await waitFor(() =>
      expect(editor.querySelector('[data-ref-text]')?.getAttribute('data-ref-text')).toBe(
        '@folder:`/Users/alice/Downloads/素材 一批`'
      )
    )
    expect(request).not.toHaveBeenCalledWith('folder.attach', expect.anything())
  })
})
