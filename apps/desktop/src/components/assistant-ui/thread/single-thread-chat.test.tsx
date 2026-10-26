/**
 * hc-1015 「只有问题和回复」 on the real transcript, in Chinese.
 *
 * With `desktop_features.single_thread` on (developer mode off), a turn's work
 * is one activity line at the foot of the conversation while it runs, and
 * 「用时 … · 看过程」 under the answer once it is done; no thought chip and no
 * turn timer. What protects the user stays: the approval bar for a command,
 * the failure card and its three ways on, 「等你决定」 while a question waits.
 * The flag-off look is pinned byte for byte in src/single-thread-identity.test.tsx.
 */
import { type ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $clarifyRequests, setClarifyRequest } from '@/store/clarify'
import { clearAllPrompts, setApprovalRequest } from '@/store/prompts'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { $singleThreadFlag } from '@/store/single-thread'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'
import {
  REMIX_SKILL_SLUGS,
  REMIX_TOOL_NAMES,
  remixFailedTurn,
  remixLiveTurn,
  remixRunningTurn,
  remixTool
} from '@/test/remix-turn'
import { englishWords, readableText } from '@/test/zh-copy'

import { createdAt, stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '../test-utils'

import { Thread } from '.'

const submitted = vi.hoisted(() => [] as string[])

vi.mock('@/app/chat/composer/focus', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  requestComposerSubmit: (text: string) => {
    submitted.push(text)

    return true
  }
}))

// 换更强的再答一次 only renders in hc-960 tier mode with a usable next tier; a
// marker stands in for it so the single-thread gate around it is reachable.
vi.mock('@/components/model-tier/retry-stronger', () => ({
  RetryStrongerButton: () => <span data-retry-stronger="" />
}))

stubThreadEnvironment()
stubThreadViewportSize()

const SESSION = 'session-single-thread'

function renderZh(messages: ThreadMessage[]) {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )
}

/** The words on screen, in order, one space between text nodes. */
function onScreen(root: Element): string {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const words: string[] = []

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim()

    if (text) {
      words.push(text)
    }
  }

  return words.join(' ')
}

/** Our copy in a block: its text and labels, minus link targets (data, like a search query). */
function ourCopy(root: Element): string {
  const copy = root.cloneNode(true) as HTMLElement

  copy.querySelectorAll('[data-process-link]').forEach(link => link.remove())

  return readableText(copy)
}

const footer = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-single-thread-process]')
const activity = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-single-thread-activity]')

function expectNoMechanism(text: string) {
  expect(englishWords(text)).toEqual([])

  for (const name of [...REMIX_TOOL_NAMES, ...REMIX_SKILL_SLUGS]) {
    expect(text).not.toContain(name)
  }
}

/** A turn that only thought, then answered. */
function thoughtTurn(): ThreadMessage[] {
  const T0 = Date.UTC(2026, 9, 18, 10, 0, 0) / 1000

  return [
    {
      id: 'thought-ask',
      role: 'user',
      content: [{ type: 'text', text: '给我起 3 个标题' }],
      attachments: [],
      createdAt,
      metadata: { custom: {} }
    } as ThreadMessage,
    {
      id: 'thought-answer',
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '先想想这条的卖点。', timestamp: T0, completedAt: T0 + 6 },
        { type: 'text', text: '1. 9.9 元的收纳，我只留了这 3 样' }
      ],
      status: { type: 'complete', reason: 'stop' },
      createdAt,
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: { durationS: 9 }
      }
    } as unknown as ThreadMessage
  ]
}

/** A turn waiting on a command the user has to approve. */
function approvalTurn(): ThreadMessage[] {
  const [ask] = remixRunningTurn()

  return [
    ask,
    {
      id: 'approve-a',
      role: 'assistant',
      content: [
        { type: 'text', text: '我把下载的视频挪到你的作品文件夹。' },
        remixTool('term-1', 'terminal', { command: 'mv /工作区/媒体/懒人好物盘点.mp4 ~/作品/' })
      ],
      status: { type: 'running' },
      createdAt,
      metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
    } as unknown as ThreadMessage
  ]
}

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setToolViewMode('product')
  $singleThreadFlag.set(true)
  $activeSessionId.set(SESSION)
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
  clearDismissedToolRows()
  clearAllPrompts()
  $clarifyRequests.set({})
  submitted.length = 0
})

afterEach(() => {
  cleanup()
  setRuntimeI18nLocale('en')
  setToolViewMode('product')
  $singleThreadFlag.set(false)
  $activeSessionId.set(null)
  $toolDisclosureStates.set({})
  clearAllPrompts()
  $clarifyRequests.set({})
})

describe('a finished task: only the question and the answer', () => {
  it('folds the work into 「用时 … · 看过程」 under the answer, with no thought and no timer', async () => {
    const { container } = renderZh(remixLiveTurn())

    const line = await waitFor(() => {
      const node = footer(container)

      expect(node).not.toBeNull()

      return node!
    })

    expect(onScreen(line)).toBe('用时 2 分 10 秒 · 看过程')
    expect(container.querySelectorAll('[data-single-thread-process]')).toHaveLength(1)
    // Under the answer, not above it: the turn's last words come first.
    const answer = [...container.querySelectorAll('[data-slot="aui_assistant-message-content"]')].at(-1)!

    expect(answer.contains(line)).toBe(true)
    expect(answer.textContent!.indexOf('用时 2 分 10 秒')).toBeGreaterThan(answer.textContent!.indexOf('仿写'))
    // No process block, no step, no thought, no turn timer, no activity line.
    expect(container.querySelector('[data-process-block]')).toBeNull()
    expect(container.querySelector('[data-process-step]')).toBeNull()
    expect(container.querySelector('[data-slot="aui_thinking-disclosure"]')).toBeNull()
    expect(container.textContent).not.toMatch(/想了|想过了|正在想/)
    expect(container.querySelector('[data-slot="aui_turn-duration"]')).toBeNull()
    expect(activity(container)).toBeNull()
  })

  it('opens onto the same plain-language steps and sources, then folds again', async () => {
    const { container } = renderZh(remixLiveTurn())

    fireEvent.click(await screen.findByRole('button', { name: '看过程' }))

    await waitFor(() => expect(container.querySelectorAll('[data-process-step]')).toHaveLength(4))

    for (const toggle of container.querySelectorAll('[data-process-source-toggle]')) {
      fireEvent.click(toggle)
    }

    const text = ourCopy(footer(container)!)

    for (const expected of [
      '下载视频',
      '下载了 1 个视频，1 分 43 秒，12.6 万赞',
      '识别语音',
      '来源：抖音公开链接里的这条作品。只读公开数据，没有登录你的账号。',
      '收起过程'
    ]) {
      expect(text).toContain(expected)
    }

    // N10 (hc-1063): the methods line names the skills, which this mode keeps out of sight.
    expect(text).not.toContain('用到的方法')
    expect(text).not.toContain('视频脚本拆解')
    expectNoMechanism(text)
    expect(text).not.toMatch(/想了|想过了/)

    fireEvent.click(screen.getByRole('button', { name: '收起过程' }))
    await waitFor(() => expect(container.querySelector('[data-process-step]')).toBeNull())
  })

  it('adds nothing under an answer that used no tools, and shows no thought', async () => {
    const { container } = renderZh(thoughtTurn())

    await waitFor(() => expect(container.querySelector('[data-role="assistant"]')).not.toBeNull())

    expect(footer(container)).toBeNull()
    expect(container.querySelector('[data-slot="aui_thinking-disclosure"]')).toBeNull()
    expect(container.textContent).not.toContain('先想想这条的卖点')
    expect(container.querySelector('[data-slot="aui_turn-duration"]')).toBeNull()
  })
})

describe('while a task runs: one activity line at the foot', () => {
  it('names the step in progress next to APEX looking down at the work, and nothing else', async () => {
    const { container } = renderZh(remixRunningTurn())

    const line = await waitFor(() => {
      const node = activity(container)

      expect(node).not.toBeNull()

      return node!
    })

    const status = line.querySelector('[role="status"]')!

    expect(status.getAttribute('aria-label')).toBe('APEX 在做的事')
    expect(onScreen(status)).toBe('正在识别语音… 第 2 步')
    expect(status.querySelector('[data-apex-avatar]')?.getAttribute('data-apex-avatar')).toBe('working')
    expect(container.querySelectorAll('[data-single-thread-activity]')).toHaveLength(1)
    // It is the thread's tail: after everything the turn has said so far.
    const tail = [...container.querySelectorAll('[data-slot="aui_assistant-message-content"]')].at(-1)!

    expect(tail.contains(line)).toBe(true)
    expect(container.querySelector('[data-process-block]')).toBeNull()
    expect(container.querySelector('[data-slot="aui_turn-activity"]')).toBeNull()
    expect(container.querySelector('[data-slot="aui_response-loading"]')).toBeNull()
    expect(footer(container)).toBeNull()
    expectNoMechanism(ourCopy(line))
  })

  it('keeps the approval bar for a command, under the activity line', async () => {
    setApprovalRequest({ command: 'mv 懒人好物盘点.mp4 ~/作品/', description: '移动文件', sessionId: SESSION })

    const { container } = renderZh(approvalTurn())

    await waitFor(() => {
      const bar = container.querySelector('[data-single-thread-activity] [data-slot="tool-approval-inline"]')

      expect(bar).not.toBeNull()
      expect(bar?.closest('[hidden]')).toBeNull()
    })

    expect(onScreen(activity(container)!.querySelector('[role="status"]')!)).toBe('等你决定')
  })

  it('says 「等你决定」 while a question card waits on the user', async () => {
    setClarifyRequest({
      choices: ['口播', '图文'],
      multiSelect: false,
      question: '这条想做成口播还是图文？',
      requestId: 'clarify-1',
      sessionId: SESSION
    })

    const { container } = renderZh(remixRunningTurn())

    await waitFor(() => expect(activity(container)).not.toBeNull())

    expect(onScreen(activity(container)!.querySelector('[role="status"]')!)).toBe('等你决定')
    // Waiting on the user, APEX looks up at them instead of down at the work.
    expect(activity(container)!.querySelector('[data-apex-avatar]')?.getAttribute('data-apex-avatar')).toBe('idle')
  })
})

describe('a stuck task keeps everything that gets the user unstuck', () => {
  it('says which step failed, opens its steps, and offers the three ways on', async () => {
    const { container } = renderZh(remixFailedTurn())

    const line = await waitFor(() => {
      const node = footer(container)

      expect(node).not.toBeNull()

      return node!
    })

    expect(line.getAttribute('data-state')).toBe('failed')
    expect(onScreen(line.querySelector('[data-process-status]')!)).toBe('识别语音没成功 第 2 步，共 2 步 · 收起过程')
    expect(line.querySelectorAll('[data-process-step]')).toHaveLength(2)
    expect(line.querySelector('[data-process-failure]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(submitted).toEqual(['再试一次「识别语音」这一步。'])
    expect(screen.getByRole('button', { name: '换个办法' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '先给我能出的部分' })).toBeTruthy()
    expect(container.querySelector('[data-process-block]')).toBeNull()
  })
})

describe('developer mode keeps the process block', () => {
  it('shows the block in place and no single-thread line, with the switch on', async () => {
    setToolViewMode('technical')

    const { container } = renderZh(remixLiveTurn())

    await waitFor(() => expect(container.querySelector('[data-process-block]')).not.toBeNull())

    expect(footer(container)).toBeNull()
    expect(activity(container)).toBeNull()
  })
})

function errorTurn(): ThreadMessage[] {
  const [ask] = remixRunningTurn()

  return [
    ask,
    {
      id: 'provider-error',
      role: 'assistant',
      content: [],
      status: { type: 'incomplete', reason: 'error', error: '模型服务暂时不可用，请稍后重试。' },
      createdAt,
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: { errorSurface: { code: 'provider_unavailable', layer: 'provider', retryable: true } }
      }
    } as unknown as ThreadMessage
  ]
}

/** The error card's 切换提供方 deep-links into Settings, so it needs a router. */
function renderZhRouted(messages: ThreadMessage[]) {
  return render(
    <MemoryRouter>
      <I18nProvider configClient={null} initialLocale="zh">
        <ThreadRuntime messages={messages}>
          <Thread />
        </ThreadRuntime>
      </I18nProvider>
    </MemoryRouter>
  )
}

function signIn(managed: boolean) {
  $authState.set({
    ...$authState.get(),
    enabled: managed,
    gateReason: null,
    modelTierMax: false,
    modelTiers: false,
    status: managed ? 'signed-in' : 'signed-out'
  })
}

describe('no tier, no second chat and no model switch under an answer', () => {
  afterEach(() => signIn(false))

  it('drops 换更强的再答一次 and 在新对话中分支 (both there with the switch off)', async () => {
    const renderWithBranch = () =>
      render(
        <I18nProvider configClient={null} initialLocale="zh">
          <ThreadRuntime messages={thoughtTurn()}>
            <Thread onBranchInNewChat={() => undefined} />
          </ThreadRuntime>
        </I18nProvider>
      )

    $singleThreadFlag.set(false)

    const off = renderWithBranch()

    await screen.findByRole('button', { name: '在新对话中分支' })
    expect(off.container.querySelector('[data-retry-stronger]')).not.toBeNull()
    off.unmount()

    $singleThreadFlag.set(true)

    const on = renderWithBranch()

    await waitFor(() => expect(on.container.querySelector('[data-role="assistant"]')).not.toBeNull())
    expect(screen.queryByRole('button', { name: '在新对话中分支' })).toBeNull()
    expect(on.container.querySelector('[data-retry-stronger]')).toBeNull()
  })

  it('keeps 重试 on an error card but not 切换提供方, on an APEX account', async () => {
    signIn(true)

    renderZhRouted(errorTurn())

    expect(await screen.findByRole('button', { name: '重试' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '切换提供方' })).toBeNull()
  })

  it('keeps 切换提供方 for the user’s own key', async () => {
    signIn(false)

    renderZhRouted(errorTurn())

    expect(await screen.findByRole('button', { name: '切换提供方' })).toBeTruthy()
  })
})
