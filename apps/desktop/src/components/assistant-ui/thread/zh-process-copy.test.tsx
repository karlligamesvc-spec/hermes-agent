import { type ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $activeSessionId } from '@/store/session'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates } from '@/store/tool-view'
import { englishWords, readableText } from '@/test/zh-copy'

import { createdAt, stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '../test-utils'

import { Thread } from '.'

// hc-953: the process area of a Chinese chat speaks Chinese. The 2026-10-18
// short-video review saw "Thought for 3s", "Tool Search 4 results 33ms",
// "Used 4 tools", "正在运行 Media Transcribe" and "已加载技能: social-media-research"
// on a Chinese screen: English verbs and units, tool code names, skill slugs.
// These render the real transcript at zh with Chinese data, so any Latin word
// left on screen is the product's own copy.

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

const toolSearch = (id: string) =>
  tool(
    id,
    'tool_search',
    { queries: ['抖音热榜'] },
    { results: [{ name: '热榜' }, { name: '作品' }, { name: '账号' }, { name: '关键词' }], duration_s: 0.033 }
  )

// One finished turn the way the review saw it: a thought, the tool-search
// bridge, three skills (one nobody has named yet), a bridged call reloaded from
// history, platform tools and an MCP tool with no Chinese name.
const SETTLED_TURN: Part[] = [
  { type: 'reasoning', text: '先看看抖音家居类最近的热度。' },
  toolSearch('search'),
  tool('describe', 'tool_describe', { names: ['热榜'] }, { tools: [{ name: '热榜' }], duration_s: 0.004 }),
  tool('skill-1', 'skill_view', { name: 'social-media-research' }, { success: true, content: '技能说明' }),
  tool('skill-2', 'skill_view', { name: 'apexnodes/douyin-account-launch' }, { success: true, content: '技能说明' }),
  tool('skill-3', 'skill_view', { name: 'a-skill-nobody-named-yet' }, { success: true, content: '技能说明' }),
  tool('bridged', 'tool_call', { name: 'social_trending', arguments: { platform: '抖音' } }, { success: true }),
  tool('download', 'social_download', { platform: '抖音' }, { success: true, title: '懒人好物' }),
  tool('transcribe', 'media_transcribe', { platform: '抖音' }, { success: true, text: '大家好', duration_s: 126 }),
  tool('mcp', 'mcp_shop__create_order', { title: '订单' }, { ok: true })
]

function renderZh(messages: ThreadMessage[]) {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )
}

beforeEach(() => {
  // Module-level copy (tool titles, the run summary) reads the runtime locale,
  // which the app has already set to the user's language before any row paints.
  setRuntimeI18nLocale('zh')
  $activeSessionId.set('session-zh')
  $toolDisclosureStates.set({})
  clearDismissedToolRows()
})

afterEach(() => {
  cleanup()
  setRuntimeI18nLocale('en')
  $activeSessionId.set(null)
  $toolDisclosureStates.set({})
})

describe('a finished turn in a Chinese chat', () => {
  it('sums the run up in Chinese, naming skills instead of their slugs', async () => {
    const { container } = renderZh([assistant('turn', SETTLED_TURN)])

    await waitFor(() => expect(container.querySelector('[data-tool-summary]')).not.toBeNull())
    const summary = container.querySelector('[data-tool-summary]')!

    expect(summary.textContent).toContain('已加载技能：社媒调研，已加载技能：抖音起号，已加载技能，用了 6 个工具')
    expect(englishWords(readableText(summary))).toEqual([])
  })

  it('opens onto rows with Chinese titles, counts and durations', async () => {
    const { container } = renderZh([assistant('turn', SETTLED_TURN)])

    await waitFor(() => expect(container.querySelector('[data-tool-summary]')).not.toBeNull())
    fireEvent.click(container.querySelector('[data-tool-summary] button')!)
    await waitFor(() => expect(container.querySelectorAll('[data-tool-row]').length).toBeGreaterThan(5))

    const text = readableText(container)

    for (const expected of ['已思考', '已查找可用工具', '4 条结果', '33 毫秒', '已查看工具说明', '4 毫秒']) {
      expect(text).toContain(expected)
    }

    for (const expected of ['已查看热榜', '已下载视频', '已转成逐字稿', '2 分 6 秒', '已使用工具']) {
      expect(text).toContain(expected)
    }

    expect(englishWords(text)).toEqual([])
  })

  it('titles the reviewed "Tool Search 4 results 33ms" row in Chinese', async () => {
    const { container } = renderZh([assistant('lone', [toolSearch('lone-search')])])

    await waitFor(() => expect(container.querySelector('[data-tool-row]')).not.toBeNull())
    const row = container.querySelector('[data-tool-row]')!

    expect(row.textContent).toContain('已查找可用工具')
    expect(row.textContent).toContain('4 条结果')
    expect(row.textContent).toContain('33 毫秒')
    expect(englishWords(readableText(row))).toEqual([])
  })
})

describe('a turn still running in a Chinese chat', () => {
  it('narrates live work in Chinese', async () => {
    const { container } = renderZh([
      assistant(
        'live',
        [
          toolSearch('live-search'),
          tool('live-download', 'social_download', { platform: '抖音' }),
          tool('live-transcribe', 'media_transcribe', { platform: '抖音' })
        ],
        true
      )
    ])

    expect(await screen.findAllByText(/正在下载|正在转成/)).not.toHaveLength(0)
    expect(englishWords(readableText(container))).toEqual([])
  })

  it('names a quiet wait in Chinese', async () => {
    const { container } = renderZh([assistant('quiet', [{ type: 'text', text: '好的，' }], true)])

    // The row earns its place after the turn has been quiet for TURN_QUIET_S.
    await waitFor(() => expect(container.querySelector('[data-slot="aui_turn-activity"]')).not.toBeNull(), {
      timeout: 5000
    })

    expect(readableText(container)).toContain('APEX 正在处理')
    expect(englishWords(readableText(container))).toEqual([])
  })

  it('times a thought in progress in Chinese seconds', async () => {
    const { container } = renderZh([assistant('thinking', [{ type: 'reasoning', text: '先想想用哪条视频。' }], true)])

    expect(await screen.findByText('思考中')).toBeTruthy()
    // The timer paints one cell per character: digits, a space, then 「秒」.
    expect(readableText(container)).toMatch(/\d\s*秒/)
    expect(englishWords(readableText(container))).toEqual([])
  })
})

describe('opened rows and notices in a Chinese chat', () => {
  it('labels search results and command output in Chinese', async () => {
    const { container } = renderZh([
      assistant('opened', [
        tool('web', 'web_search', { query: '收纳神器' }, { results: [{ title: '十款收纳神器', snippet: '厨房收纳' }] }),
        tool('term', 'terminal', { command: '列出素材' }, { stdout: '素材一', stderr: '提示一条', exit_code: 0 })
      ])
    ])

    await waitFor(() => expect(container.querySelector('[data-tool-summary]')).not.toBeNull())
    fireEvent.click(container.querySelector('[data-tool-summary] button')!)
    await waitFor(() => expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(2))

    for (const row of container.querySelectorAll('[data-tool-row] button[aria-expanded="false"]')) {
      fireEvent.click(row)
    }

    await waitFor(() => expect(readableText(container)).toContain('搜索结果'))
    const text = readableText(container)

    expect(text).toContain('错误输出')
    expect(text).toContain('退出码 0')
    // The opened detail title-cases the result's own JSON field names
    // ("results" → "Results"): tool data, listed as a residual for the
    // process-area redesign. Every other Latin word would be our copy.
    expect(englishWords(text).filter(word => word !== 'Results')).toEqual([])
  })

  it('reports a message to another assistant in Chinese', async () => {
    const command = 'hermes -p helper chat --in ~ -c "Bot Chat" -Q -q "Message from 🤖 小助手 (@apex): 你好"'

    const { container } = renderZh([
      assistant('deliver', [tool('deliver', 'terminal', { command }, { output: 'session_id: s1\n收到，马上处理' })])
    ])

    expect(await screen.findByText('已给 helper 发消息')).toBeTruthy()
    expect(screen.getByText('helper 发来的消息')).toBeTruthy()
    // `helper` is the other assistant's profile name: data, not copy.
    expect(englishWords(readableText(container)).filter(word => word !== 'helper')).toEqual([])
  })
})
