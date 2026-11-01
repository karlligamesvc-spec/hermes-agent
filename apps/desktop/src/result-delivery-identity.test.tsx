/**
 * hc-1130 identity guard (hard rule 11): the file cards and result cards only
 * change in single-thread product mode. With the switch off, and in developer
 * mode with it on, the transcript stays byte for byte what it was.
 *
 * The goldens under `__identity__/result-delivery/` were recorded on fork main
 * b881175df2, before any hc-1130 code was written. A diff here means the off
 * path moved: fix the code, do not re-record the golden unless the change is
 * meant to reach every user.
 */
import { type ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { clearAllPrompts, setApprovalRequest } from '@/store/prompts'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { $singleThreadFlag } from '@/store/single-thread'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'
import {
  RESULT_DOC,
  RESULT_IMAGE,
  resultDelegateTurn,
  resultImageCardTurn,
  resultTurn,
  resultWritingTurn
} from '@/test/result-turn'

// Syntax colours arrive whenever Shiki finishes loading, and a golden must not
// depend on that race: every diff renders on its plain path here.
vi.mock('@/components/chat/shiki-highlighter', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  exceedsHighlightBudget: () => true
}))

stubThreadEnvironment()
stubThreadViewportSize()

const GOLDEN = './__identity__/result-delivery'
const SESSION = 'session-result-identity'

/** React's generated ids differ by render order, and a running row's timer by the clock. */
function normalized(html: string): string {
  return html
    .replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
    .replace(/(<span class="inline-block text-center w-\[1ch\]">)\d(<\/span>)/g, '$1«d»$2')
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 60))
  })

async function renderThread(messages: ThreadMessage[]) {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )

  await waitFor(() => expect(view.container.querySelector('[data-role="assistant"]')).not.toBeNull())
  await settle()

  // The image card only shows its actions once the picture has loaded.
  view.container.querySelectorAll('[data-slot="aui_generated-image"] img').forEach(image => fireEvent.load(image))
  await settle()

  return view.container
}

function messageArea(container: HTMLElement): string {
  return normalized(
    [...container.querySelectorAll('[data-slot="aui_assistant-message-root"]')].map(node => node.outerHTML).join('\n')
  )
}

let originalDesktop: typeof window.hermesDesktop

beforeEach(() => {
  originalDesktop = window.hermesDesktop
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { readFileDataUrl: async () => 'data:image/png;base64,AAAA' }
  })
  setRuntimeI18nLocale('zh')
  setToolViewMode('product')
  $singleThreadFlag.set(false)
  $activeSessionId.set(SESSION)
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
  clearDismissedToolRows()
  clearAllPrompts()
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: originalDesktop })
  setRuntimeI18nLocale('en')
  setToolViewMode('product')
  $singleThreadFlag.set(false)
  $activeSessionId.set(null)
  $toolDisclosureStates.set({})
  clearAllPrompts()
})

const CASES: [string, () => ThreadMessage[]][] = [
  ['finished', resultTurn],
  ['image-card', resultImageCardTurn],
  ['writing', resultWritingTurn],
  ['delegate', resultDelegateTurn],
  ['links', () => resultTurn(`封面：\n\n![封面](${RESULT_IMAGE})\n\n报告：[报告](${RESULT_DOC})`)]
]

describe('single_thread off, product view: unchanged', () => {
  it.each(CASES)('a %s turn', async (name, turn) => {
    const container = await renderThread(turn())

    await expect(messageArea(container)).toMatchFileSnapshot(`${GOLDEN}/${name}-product.html`)
  })

  it('a finished turn with its steps opened', async () => {
    const container = await renderThread(resultTurn())

    fireEvent.click(await screen.findByRole('button', { name: '看步骤' }))
    await settle()

    await expect(messageArea(container)).toMatchFileSnapshot(`${GOLDEN}/finished-opened-product.html`)
  })

  it('a file write waiting on an approval', async () => {
    setApprovalRequest({
      command: 'write_file SOUL.md',
      description: 'Write to protected agent-instruction file',
      sessionId: SESSION
    })
    const container = await renderThread(resultWritingTurn())

    await expect(messageArea(container)).toMatchFileSnapshot(`${GOLDEN}/writing-approval-product.html`)
  })
})

describe('developer mode: the same with the switch off and on', () => {
  it.each(CASES)('a %s turn', async (name, turn) => {
    setToolViewMode('technical')
    const off = messageArea(await renderThread(turn()))

    await expect(off).toMatchFileSnapshot(`${GOLDEN}/${name}-developer.html`)

    cleanup()
    $singleThreadFlag.set(true)

    expect(messageArea(await renderThread(turn()))).toBe(off)
  })
})
