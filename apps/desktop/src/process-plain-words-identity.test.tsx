/**
 * hc-1066 identity guard (hard rule 11): with `desktop_features.single_thread`
 * off, an editing task's process area and its approval bar look exactly as
 * they did before hc-1066.
 *
 * The goldens under `__identity__/process-plain-words/` were recorded on fork
 * main c4b606771d, before any hc-1066 code was written: a finished, an opened
 * and a running editing turn (terminal commands, image looks, a script written
 * and patched, code run), developer mode, and a run of code waiting on the
 * user's approval, inline and as the floating bar. hc-1066 names those steps
 * by what they do only in single-thread product mode; a diff here means the
 * off path moved.
 */
import { type ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { PendingApprovalFallback } from '@/components/assistant-ui/tool/approval'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { clearAllPrompts, setApprovalRequest } from '@/store/prompts'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { $singleThreadFlag } from '@/store/single-thread'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'
import { EDITING_APPROVAL_CODE, editingApprovalTurn, editingLiveTurn, editingRunningTurn } from '@/test/editing-turn'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getSkills: vi.fn(async () => []),
  getMoaModels: vi.fn(async () => null)
}))

stubThreadEnvironment()
stubThreadViewportSize()

const GOLDEN = './__identity__/process-plain-words'
const SESSION = 'session-process-identity'

/** React's generated ids differ by render order; they are not what the guard is about. */
function normalized(html: string): string {
  return html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
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

  return view.container
}

/** Every assistant row of the transcript, in order. */
function messageArea(container: HTMLElement): string {
  return normalized(
    [...container.querySelectorAll('[data-slot="aui_assistant-message-root"]')].map(node => node.outerHTML).join('\n')
  )
}

function requestApproval() {
  setApprovalRequest({
    command: EDITING_APPROVAL_CODE,
    description:
      'execute_code script execution. The script can spawn subprocesses or mutate files without passing through terminal command approval; approval is one-shot for this run.',
    sessionId: SESSION
  })
}

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setToolViewMode('product')
  $activeSessionId.set(SESSION)
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
  clearDismissedToolRows()
  clearAllPrompts()
})

afterEach(() => {
  cleanup()
  setRuntimeI18nLocale('en')
  setToolViewMode('product')
  $singleThreadFlag.set(false)
  $activeSessionId.set(null)
  $toolDisclosureStates.set({})
  clearAllPrompts()
})

describe('single_thread off: an editing task looks as it did', () => {
  it.each([
    ['finished', editingLiveTurn],
    ['running', editingRunningTurn]
  ])('a %s editing turn', async (name, turn) => {
    const container = await renderThread(turn())

    await expect(messageArea(container)).toMatchFileSnapshot(`${GOLDEN}/editing-${name}.html`)
  })

  it('a finished editing turn with its steps opened', async () => {
    const container = await renderThread(editingLiveTurn())

    fireEvent.click(await screen.findByRole('button', { name: '看步骤' }))
    await settle()

    await expect(messageArea(container)).toMatchFileSnapshot(`${GOLDEN}/editing-finished-opened.html`)
  })

  it('a finished editing turn in developer mode', async () => {
    setToolViewMode('technical')

    const container = await renderThread(editingLiveTurn())

    await expect(messageArea(container)).toMatchFileSnapshot(`${GOLDEN}/editing-finished-developer.html`)
  })

  it('code waiting on the user’s approval, inline', async () => {
    requestApproval()

    const container = await renderThread(editingApprovalTurn())

    await waitFor(() => expect(container.querySelector('[data-slot="tool-approval-inline"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '命令' }))
    await settle()

    await expect(messageArea(container)).toMatchFileSnapshot(`${GOLDEN}/editing-approval.html`)
  })

  it('code waiting on the user’s approval, as the floating bar', async () => {
    requestApproval()

    const view = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <PendingApprovalFallback />
      </I18nProvider>
    )

    await settle()

    await expect(normalized(view.container.innerHTML)).toMatchFileSnapshot(`${GOLDEN}/approval-floating.html`)
  })
})

describe('single_thread on: developer mode is still the chat it was', () => {
  it('a finished editing turn in developer mode, against the same golden', async () => {
    $singleThreadFlag.set(true)
    setToolViewMode('technical')

    const container = await renderThread(editingLiveTurn())

    await expect(messageArea(container)).toMatchFileSnapshot(`${GOLDEN}/editing-finished-developer.html`)
  })
})
