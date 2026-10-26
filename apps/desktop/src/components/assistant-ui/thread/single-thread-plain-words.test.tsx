/**
 * hc-1066 「过程说人话」 on the real transcript, single-thread product mode.
 *
 * An editing task done on the creator's computer — terminal commands, image
 * looks, a script written and patched, code run — reads as what each step is
 * for (「抽帧」「看画面：字幕、构图」「合成视频」), never as a path, a command
 * or code; the activity line says where a long task stands; a command or code
 * waiting on the user's approval says in one sentence what it is for, with the
 * code itself still one click away. The flag-off look is pinned byte for byte
 * in src/process-plain-words-identity.test.tsx.
 */
import { type ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PendingApprovalFallback } from '@/components/assistant-ui/tool/approval'
import { I18nProvider, type Locale, setRuntimeI18nLocale } from '@/i18n'
import { clearAllPrompts, setApprovalRequest } from '@/store/prompts'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { $singleThreadFlag } from '@/store/single-thread'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'
import { EDITING_APPROVAL_CODE, editingApprovalTurn, editingLiveTurn, editingRunningTurn } from '@/test/editing-turn'
import { englishWords, readableText } from '@/test/zh-copy'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '../test-utils'

import { Thread } from '.'

stubThreadEnvironment()
stubThreadViewportSize()

const SESSION = 'session-plain-words'

const CODE_DESCRIPTION =
  'execute_code script execution. The script can spawn subprocesses or mutate files without passing through terminal command approval; approval is one-shot for this run.'

// What the fixture's arguments hold and a creator should never have to read.
const MECHANISM = [
  '/Users',
  '.apexnodes',
  'ffmpeg',
  'ffprobe',
  'python',
  '.py',
  'build',
  'subs',
  'mkdir',
  'cp ',
  'execute_code',
  'terminal',
  'vision_analyze',
  'write_file',
  'patch',
  'open('
]

function renderIn(locale: Locale, messages: ThreadMessage[]) {
  setRuntimeI18nLocale(locale)

  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )
}

const footer = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-single-thread-process]')
const activity = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-single-thread-activity]')

function expectNoMechanism(text: string) {
  expect(englishWords(text)).toEqual([])

  for (const word of MECHANISM) {
    expect(text).not.toContain(word)
  }
}

beforeEach(() => {
  setToolViewMode('product')
  $singleThreadFlag.set(true)
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

describe('a finished editing task', () => {
  it('opens onto steps named by what they did, repeats folded, nothing of the mechanism', async () => {
    const { container } = renderIn('zh', editingLiveTurn())

    fireEvent.click(await screen.findByRole('button', { name: '看过程' }))

    const steps = await waitFor(() => {
      const rows = [...container.querySelectorAll<HTMLElement>('[data-process-step]')]

      expect(rows.length).toBeGreaterThan(0)

      return rows
    })

    expect(steps.map(row => row.querySelector('.font-medium')?.textContent)).toEqual([
      '查看视频信息',
      '准备工作文件夹',
      '抽帧',
      '看画面：人物、场景',
      '生成配音',
      '生成视频',
      '写剪辑步骤',
      '合成视频',
      '抽帧',
      '看画面：字幕、构图',
      '调整字幕',
      '做字幕',
      '保存文件'
    ])
    expect(steps[0].textContent).toContain('查看了 2 个文件')
    expect(steps[2].textContent).toContain('抽了 2 次帧')
    expectNoMechanism(readableText(footer(container)!))
  })
})

describe('while an editing task runs', () => {
  it('names the step by what it does and says where the task stands', async () => {
    const { container } = renderIn('zh', editingRunningTurn())

    const line = await waitFor(() => {
      const node = activity(container)

      expect(node).not.toBeNull()

      return node!
    })

    expect(line.querySelector('[role="status"]')?.textContent).toContain('正在合成视频…')
    expect(line.querySelector('[data-single-thread-stage]')?.textContent).toBe('已看完素材、生成好素材，正在剪辑')
    expectNoMechanism(readableText(line))
  })

  it('reads in English too', async () => {
    const { container } = renderIn('en', editingRunningTurn())

    const line = await waitFor(() => {
      const node = activity(container)

      expect(node).not.toBeNull()

      return node!
    })

    expect(line.querySelector('[role="status"]')?.textContent).toContain('Putting the video together…')
    expect(line.querySelector('[data-single-thread-stage]')?.textContent).toBe(
      'Looked through the footage, made the new footage — now editing'
    )
  })
})

describe('code waiting on the user’s approval', () => {
  it('says in one sentence what it is for; the code stays one click away', async () => {
    setApprovalRequest({ command: EDITING_APPROVAL_CODE, description: CODE_DESCRIPTION, sessionId: SESSION })

    const { container } = renderIn('zh', editingApprovalTurn())

    const explain = await waitFor(() => {
      const node = container.querySelector<HTMLElement>(
        '[data-single-thread-activity] [data-slot="tool-approval-explain"]'
      )

      expect(node).not.toBeNull()

      return node!
    })

    expect(explain.textContent).toBe(
      'APEX 想在你的电脑上运行一段程序，用来做字幕。你同意了才会执行，点「命令」可以看具体内容。'
    )
    // The sentence sits above the buttons, and the buttons are all still there.
    const bar = container.querySelector<HTMLElement>('[data-slot="tool-approval-inline"]')!

    expect(explain.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: /运行/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /拒绝/ })).toBeTruthy()
    expect(container.textContent).not.toContain('subs.ass')

    fireEvent.click(screen.getByRole('button', { name: '命令' }))

    expect(container.querySelector('[data-slot="tool-approval-inline"] pre')?.textContent).toBe(EDITING_APPROVAL_CODE)
  })

  it('says the same sentence on the floating bar, instead of the engine’s English', async () => {
    setApprovalRequest({ command: EDITING_APPROVAL_CODE, description: CODE_DESCRIPTION, sessionId: SESSION })
    setRuntimeI18nLocale('zh')

    const { container } = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <PendingApprovalFallback />
      </I18nProvider>
    )

    await waitFor(() => expect(container.querySelector('[data-slot="tool-approval-explain"]')).not.toBeNull())

    expect(container.textContent).toContain('APEX 想在你的电脑上运行一段程序，用来做字幕。')
    expect(container.textContent).not.toContain('execute_code')
  })
})

describe('developer mode is untouched', () => {
  it('keeps the tool names and no stage line, with the switch on', async () => {
    setToolViewMode('technical')

    const { container } = renderIn('zh', editingRunningTurn())

    await waitFor(() => expect(container.querySelector('[data-process-block]')).not.toBeNull())

    expect(container.querySelector('[data-process-status]')?.textContent).toContain('正在电脑上处理')
    expect(container.querySelector('[data-single-thread-stage]')).toBeNull()
  })
})
