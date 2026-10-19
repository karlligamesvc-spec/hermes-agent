import { type ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'
import {
  REMIX_SKILL_SLUGS,
  REMIX_TOOL_NAMES,
  remixFailedTurn,
  remixLiveTurn,
  remixReloadedTurn,
  remixRunningTurn
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

// hc-953 made the process area Chinese; hc-973 makes it say what was done
// instead of how. Outside developer mode a whole 「拆爆款 + 仿写」 task is one line
// — 「下载视频 → 识别语音 → 看关键词热度 → 搜同类作品」 — that opens onto steps in
// plain words, each able to say where its data came from; thoughts fold to one
// chip. No English word, tool code name, skill slug or millisecond count may
// reach the screen. Developer mode adds each step's technical details.

stubThreadEnvironment()
stubThreadViewportSize()

type Part = Record<string, unknown>

function tool(id: string, toolName: string, args: Record<string, unknown>, result?: unknown): Part {
  return {
    type: 'tool-call',
    toolCallId: id,
    toolName,
    args,
    argsText: JSON.stringify(args),
    ...(result === undefined ? {} : { result })
  }
}

function assistant(id: string, content: Part[], running = false): ThreadMessage {
  return {
    id,
    role: 'assistant',
    content,
    status: running ? { type: 'running' } : { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
  } as unknown as ThreadMessage
}

function renderZh(messages: ThreadMessage[]) {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )
}

/** The process area: the turn's block, plus any thought or tool row that
 *  rendered outside it. Everything in it is our copy except link targets. */
function processText(container: HTMLElement): string {
  const areas = [
    ...container.querySelectorAll('[data-process-block], [data-slot="aui_thinking-disclosure"], [data-tool-row]')
  ]

  return areas
    .map(area => {
      const copy = area.cloneNode(true) as HTMLElement

      // A link's text is the page it points at — data, like a search query.
      copy.querySelectorAll('[data-process-link]').forEach(link => link.remove())

      return readableText(copy)
    })
    .join('\n')
}

function expectNoMechanism(text: string) {
  expect(englishWords(text)).toEqual([])

  for (const name of [...REMIX_TOOL_NAMES, ...REMIX_SKILL_SLUGS]) {
    expect(text).not.toContain(name)
  }

  expect(text).not.toMatch(/毫秒|\dms\b/)
}

async function openEverything(container: HTMLElement) {
  fireEvent.click(await screen.findByRole('button', { name: '看步骤' }))
  await waitFor(() => expect(container.querySelectorAll('[data-process-step]').length).toBeGreaterThan(0))

  for (const toggle of container.querySelectorAll('[data-process-source-toggle]')) {
    fireEvent.click(toggle)
  }

  fireEvent.click(screen.getByRole('button', { name: /想了|想过了/ }))
}

beforeEach(() => {
  // Module-level copy (tool titles, step facts) reads the runtime locale, which
  // the app has already set to the user's language before any row paints.
  setRuntimeI18nLocale('zh')
  setToolViewMode('product')
  $activeSessionId.set('session-zh')
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
  clearDismissedToolRows()
  submitted.length = 0
})

afterEach(() => {
  cleanup()
  setRuntimeI18nLocale('en')
  setToolViewMode('product')
  $activeSessionId.set(null)
  $toolDisclosureStates.set({})
})

describe('a finished 拆爆款 + 仿写 task in a Chinese chat', () => {
  it('is one line: what was done and how long it took', async () => {
    const { container } = renderZh(remixLiveTurn())

    const status = await waitFor(() => {
      const node = container.querySelector('[data-process-status]')

      expect(node).not.toBeNull()

      return node!
    })

    expect(status.textContent).toContain('下载视频 → 识别语音 → 看关键词热度 → 搜同类作品')
    expect(status.textContent).toContain('用时 2 分 10 秒')
    expect(container.querySelectorAll('[data-process-block]')).toHaveLength(1)
    // Steps, rows and every thought stay folded until asked for.
    expect(container.querySelector('[data-process-step]')).toBeNull()
    expect(container.querySelector('[data-tool-row]')).toBeNull()
    expect(container.querySelector('[data-slot="aui_thinking-disclosure"]')).toBeNull()
    expect(container.querySelector('[data-slot="aui_thinking-body"]')).toBeNull()
    expectNoMechanism(processText(container))
  })

  it('opens onto plain-language steps, where each step got its data, and the folded thoughts', async () => {
    const { container } = renderZh(remixLiveTurn())

    await openEverything(container)

    const text = processText(container)

    for (const expected of [
      '下载了 1 个视频，1 分 43 秒，12.6 万赞',
      '拿到逐字稿，360 字',
      '看了「家居好物」的热度',
      '找到 40 条作品',
      '来源：抖音公开链接里的这条作品。只读公开数据，没有登录你的账号。',
      '方式：把视频里的声音转成文字，共 1 分 43 秒音频。',
      '来源：巨量算数（抖音官方数据）。',
      '来源：抖音上的公开数据。',
      '懒人好物、厨房收纳',
      '拿到 40 条',
      '用到的方法：视频脚本拆解、事实核验',
      '想了 15 秒',
      '先把视频拿下来转成文字'
    ]) {
      expect(text).toContain(expected)
    }

    // Preparation is not a step: four steps, not eight.
    expect(container.querySelectorAll('[data-process-step]')).toHaveLength(4)
    // Sources link to the work they came from, titled.
    expect(screen.getByRole('link', { name: /懒人好物盘点/ })).toBeTruthy()
    expectNoMechanism(text)
  })

  it('reads the same reloaded from history, through the tool_call bridge', async () => {
    const { container } = renderZh(remixReloadedTurn())

    await openEverything(container)

    const text = processText(container)

    expect(container.querySelector('[data-process-status]')?.textContent).toContain(
      '下载视频 → 识别语音 → 看关键词热度 → 搜同类作品'
    )
    expect(text).toContain('下载了 1 个视频，1 分 43 秒，12.6 万赞')
    expect(text).toContain('用到的方法：视频脚本拆解、事实核验')
    expectNoMechanism(text)
  })
})

describe('the same task still running', () => {
  it('names only the step in progress, and says it is a slow one', async () => {
    const { container } = renderZh(remixRunningTurn())

    const status = await waitFor(() => {
      const node = container.querySelector('[data-process-status][data-state="running"]')

      expect(node).not.toBeNull()

      return node!
    })

    expect(status.textContent).toContain('正在识别语音…')
    expect(status.textContent).toContain('第 2 步')
    expect(container.querySelector('[data-process-slow-hint]')?.textContent).toBe('这一步要久一点，你可以先去忙别的。')
    expectNoMechanism(processText(container))
  })
})

describe('the same task stuck on a step', () => {
  it('says which step, keeps what it got, and offers three ways on', async () => {
    const { container } = renderZh(remixFailedTurn())

    const alert = await screen.findByRole('alert')

    expect(container.querySelector('[data-process-status]')?.textContent).toContain('识别语音没成功')
    expect(container.querySelector('[data-process-status]')?.textContent).toContain('第 2 步，共 2 步')
    // The tool's own message names a code name, so a plain one stands in.
    expect(alert.textContent).toContain('这一步没有拿到结果。')
    expect(alert.textContent).toContain('已经拿到的部分不会丢。')
    // Stuck opens the steps by itself: the failed one is right there.
    expect(container.querySelector('[data-process-step][data-state="failed"]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    fireEvent.click(screen.getByRole('button', { name: '换个办法' }))
    fireEvent.click(screen.getByRole('button', { name: '先给我能出的部分' }))

    expect(submitted).toEqual([
      '再试一次「识别语音」这一步。',
      '「识别语音」这一步没成功，换个办法继续。',
      '「识别语音」先跳过，把已经拿到的部分整理给我。'
    ])
    expectNoMechanism(processText(container))
  })

  it('keeps the buttons off while the gateway is down', async () => {
    act(() => $gatewayState.set('closed'))
    renderZh(remixFailedTurn())

    expect(((await screen.findByRole('button', { name: '重试' })) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('developer mode', () => {
  it('adds each step’s technical details: code names, timings and the calls themselves', async () => {
    setToolViewMode('technical')

    const { container } = renderZh(remixLiveTurn())

    // Developer mode opens the steps by itself.
    await waitFor(() => expect(container.querySelectorAll('[data-process-tech]').length).toBe(4))

    const tech = [...container.querySelectorAll('[data-process-tech]')].map(node => node.textContent ?? '').join('\n')

    expect(tech).toContain('技术细节')
    expect(tech).toContain('social_download · 13 秒')
    expect(tech).toContain('media_transcribe · 2 分 6 秒')
    // Preparation rides under the step it prepared, millisecond timings and all.
    expect(tech).toContain('tool_search, tool_describe, skill_view, social_download')
    expect(container.querySelectorAll('[data-tool-row]').length).toBeGreaterThan(4)
  })

  it('keeps the rows themselves in Chinese', async () => {
    setToolViewMode('technical')

    const { container } = renderZh(remixLiveTurn())

    await waitFor(() => expect(container.querySelectorAll('[data-tool-row]').length).toBeGreaterThan(4))

    const rows = [...container.querySelectorAll('[data-tool-row]')].map(row => readableText(row)).join('\n')

    for (const expected of ['已查找可用工具', '2 条结果', '9 毫秒', '已下载视频', '已转成逐字稿']) {
      expect(rows).toContain(expected)
    }

    expect(englishWords(rows)).toEqual([])
  })
})

describe('tools nobody named', () => {
  it('reads as plain work, never as its code name', async () => {
    const { container } = renderZh([assistant('mcp', [tool('mcp', 'mcp_shop__create_order', { title: '订单' }, { ok: true })])])

    await waitFor(() => expect(container.querySelector('[data-process-status]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '看步骤' }))

    const text = processText(container)

    expect(container.querySelector('[data-process-status]')?.textContent).toContain('处理')
    expect(text).not.toContain('mcp_shop__create_order')
    expect(englishWords(text)).toEqual([])
  })

  it('says 「正在处理」 while one runs', async () => {
    const { container } = renderZh([assistant('mcp-live', [tool('mcp', 'mcp_shop__create_order', { title: '订单' })], true)])

    await waitFor(() =>
      expect(container.querySelector('[data-process-status]')?.textContent).toContain('正在处理…')
    )
    expect(englishWords(processText(container))).toEqual([])
  })
})

describe('around the process area', () => {
  it('names a quiet wait in Chinese', async () => {
    const { container } = renderZh([assistant('quiet', [{ type: 'text', text: '好的，' }], true)])

    // The row earns its place after the turn has been quiet for TURN_QUIET_S.
    await waitFor(() => expect(container.querySelector('[data-slot="aui_turn-activity"]')).not.toBeNull(), {
      timeout: 5000
    })

    expect(readableText(container)).toContain('APEX 正在处理')
    expect(englishWords(readableText(container))).toEqual([])
  })

  it('folds a thought with no tool work into the same 「想了」 chip, never a live preview', async () => {
    const { container } = renderZh([assistant('thinking', [{ type: 'reasoning', text: '先想想用哪条视频。' }], true)])

    expect(await screen.findByText('正在想')).toBeTruthy()
    expect(container.querySelector('[data-slot="aui_thinking-body"]')).toBeNull()
    expect(englishWords(readableText(container))).toEqual([])
  })

  it('reports a message to another assistant in Chinese', async () => {
    const command = 'hermes -p helper chat --in ~ -c "Bot Chat" -Q -q "Message from 🤖 小助手 (@apex): 你好"'

    const { container } = renderZh([
      assistant('deliver', [tool('deliver', 'terminal', { command }, { output: 'session_id: s1\n收到，马上处理' })])
    ])

    expect(await screen.findByText('已给 helper 发消息')).toBeTruthy()
    expect(screen.getByText('helper 发来的消息')).toBeTruthy()
    // A note to another assistant is its own card, not a step.
    expect(container.querySelector('[data-process-block]')).toBeNull()
    // `helper` is the other assistant's profile name: data, not copy.
    expect(englishWords(readableText(container)).filter(word => word !== 'helper')).toEqual([])
  })
})
