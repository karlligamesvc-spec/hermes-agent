/**
 * hc-1059 单线消息样式 (prototype v2 1:1) on the real transcript.
 *
 * In single-thread product mode your words are a violet bubble and APEX's words a
 * grey one; 用时 · 看过程, the steps, the next-step buttons, 「记下了」, the failure
 * card and the activity line stay outside them, and a centred time line marks where
 * the conversation picked up. The stylesheet is loaded into jsdom, whose cascade
 * resolves which rules land on which element, so these tests see what the CSS
 * paints rather than which class names exist. Everything here is inert with the
 * switch off or in developer mode; the byte-for-byte guard for those is
 * src/single-thread-identity.test.tsx.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import type { DesktopMemoryLedger } from '@/lib/memory-ledger'
import { $authState } from '@/store/auth'
import { $memoryLedger } from '@/store/memory-ledger'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'
import { remixFailedTurn, remixLiveTurn, remixRunningTurn } from '@/test/remix-turn'

stubThreadEnvironment()
stubThreadViewportSize()

const ME = 'var(--st-me-bubble)'
const APEX = 'var(--st-ai-bubble)'

const LEDGER: DesktopMemoryLedger = {
  aboutYou: [],
  limits: { aboutYouMax: 30, contentMaxChars: 100, recentKeepDays: 30, recentMax: 50 },
  recent: []
}

const sheet = window.document.createElement('style')

// jsdom does not load Tailwind: these stand in for the two utilities on the user
// message that the stylesheet must override, so losing an override shows.
const utilities = window.document.createElement('style')

beforeAll(() => {
  utilities.textContent = '.sticky { position: sticky; } .w-full { margin-left: 0; }'
  // Read from disk: under vitest a `.css` import (even `?raw`) comes back empty.
  sheet.textContent = readFileSync(join(__dirname, 'single-thread-chat.css'), 'utf8')
  window.document.head.append(utilities, sheet)
})

afterAll(() => {
  utilities.remove()
  sheet.remove()
})

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  $activeSessionId.set('session-g1')
  $gatewayState.set('open')
  $authState.set({
    account: { email: 'a@example.test', name: 'Lin', plan: 'free' },
    accountId: 'acc-1',
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-in'
  })
  $memoryLedger.set({ accountId: 'acc-1', ledger: LEDGER, status: 'ready' })
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    managed: { memoryLedger: async () => ({ ledger: LEDGER, ok: true }) }
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setRuntimeI18nLocale('en')
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  $activeSessionId.set(null)
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
})

function renderZh(messages: ThreadMessage[]) {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )
}

const fill = (element: Element) => getComputedStyle(element).backgroundColor

/** Every element in the transcript the stylesheet paints with `value`, in document order. */
const painted = (container: HTMLElement, value: string) =>
  [...container.querySelectorAll('*')].filter(el => fill(el) === value)

/** Waits until `selector` is in the transcript (a bare `querySelector` would resolve with null). */
const found = (container: HTMLElement, selector: string) =>
  waitFor(() => {
    const element = container.querySelector<HTMLElement>(selector)

    expect(element, selector).not.toBeNull()

    return element!
  })

/** The words of one reply: the Markdown container the text renders into. */
const words = (text: string) => screen.getByText(text, { exact: false }).closest('[data-status]')!

const RESULT = '按你不露脸的习惯，仿写了一版 40 秒口播。'
const NEXT = ['<!-- apex:next', '先出 10 秒样片 | 先出 10 秒样片', '改得更口语 | 改得更口语一点', '-->'].join('\n')

const memoryPart = {
  args: { action: 'add', content: '不露脸', kind: 'about_you' },
  argsText: '{}',
  result: JSON.stringify({
    action: 'add',
    created: true,
    entry: { content: '不露脸', id: 'm-1', kind: 'about_you' },
    ok: true
  }),
  toolCallId: 'call-memory',
  toolName: 'apex_memory',
  type: 'tool-call'
}

/** The finished remix task, ending on a result with next steps and a new memory. */
function resultTurn(): ThreadMessage[] {
  const turn = remixLiveTurn()
  const last = turn.at(-1)!
  const content = (last.content as readonly { type: string }[]).filter(part => part.type !== 'text')

  return [
    ...turn.slice(0, -1),
    {
      ...last,
      content: [...content, memoryPart, { type: 'text', text: `${RESULT}\n\n${NEXT}` }]
    } as unknown as ThreadMessage
  ]
}

/** Top-level selectors of the stylesheet as jsdom parsed it (a comma inside :is() stays). */
function selectors(): string[] {
  return [...sheet.sheet!.cssRules].flatMap(rule => {
    if (!(rule instanceof CSSStyleRule)) {
      return [`@${rule.constructor.name}`]
    }

    const parts: string[] = []
    let depth = 0
    let start = 0

    for (const [index, char] of [...rule.selectorText].entries()) {
      depth += char === '(' ? 1 : char === ')' ? -1 : 0

      if (char === ',' && depth === 0) {
        parts.push(rule.selectorText.slice(start, index).trim())
        start = index + 1
      }
    }

    return [...parts, rule.selectorText.slice(start).trim()]
  })
}

describe('hc-1059 the stylesheet reaches single-thread product mode only', () => {
  it('scopes every rule under [data-single-thread-chat]', () => {
    const all = selectors()

    expect(all.length).toBeGreaterThan(20)
    expect(all.filter(selector => !/^(\.dark )?\[data-single-thread-chat\] /.test(`${selector} `))).toEqual([])
  })

  it('is loaded by the transcript (these tests read it from disk, so only the import puts it in the app)', () => {
    const thread = readFileSync(join(__dirname, '../../components/assistant-ui/thread/index.tsx'), 'utf8')

    expect(thread).toMatch(/^import '@\/app\/single-thread\/single-thread-chat\.css'$/m)
  })

  it.each([
    ['switch on, product mode', true, 'product', true],
    ['switch on, developer mode', true, 'technical', false],
    ['switch off', false, 'product', false]
  ] as const)('%s: the transcript root carries the attribute = %s', async (_label, on, view, expected) => {
    setSingleThreadFlagForTest(on)
    setToolViewMode(view)

    const { container } = renderZh(resultTurn())

    await waitFor(() => expect(container.querySelector('[data-role="assistant"]')).not.toBeNull())
    expect(container.querySelectorAll('[data-single-thread-chat]')).toHaveLength(expected ? 1 : 0)
  })

  it.each([
    ['switch off', false, 'product'],
    ['developer mode', true, 'technical']
  ] as const)('%s: nothing in the transcript is painted as a bubble', async (_label, on, view) => {
    setSingleThreadFlagForTest(on)
    setToolViewMode(view)

    const { container } = renderZh(resultTurn())

    await screen.findByText(RESULT, { exact: false })
    expect(painted(container, ME)).toEqual([])
    expect(painted(container, APEX)).toEqual([])
  })
})

describe('hc-1059 bubbles hold the words, and only the words', () => {
  it('your message is the violet bubble, each reply text the grey one', async () => {
    const { container } = renderZh(resultTurn())
    const nextSteps = await found(container, '[data-next-steps]')

    const root = container.querySelector('[data-single-thread-chat]')!

    expect(getComputedStyle(root).getPropertyValue('--st-me-bubble').trim()).toBe('#6a4ceb')
    expect(getComputedStyle(root).getPropertyValue('--st-ai-bubble').trim()).toBe('#ececf1')
    expect(getComputedStyle(root).getPropertyValue('--composer-width').trim()).toBe('720px')

    // The violet fill: your words, and the first (recommended) next step.
    expect(painted(container, ME)).toEqual([
      screen.getByRole('button', { name: '编辑消息' }),
      nextSteps.firstElementChild
    ])
    expect(painted(container, APEX)).toEqual([words('好的，我先把视频下载下来'), words('逐字稿拿到了'), words(RESULT)])
  })

  it('用时 · 看过程, the steps, the next steps and 「记下了」 sit outside every bubble', async () => {
    const { container } = renderZh(resultTurn())

    await waitFor(() => expect(container.querySelector('[data-next-steps]')).not.toBeNull())
    await waitFor(() => expect(container.querySelector('[data-memory-noted]')).not.toBeNull())
    screen.getByRole('button', { name: '看过程' }).click()
    await waitFor(() => expect(container.querySelector('[data-process-steps]')).not.toBeNull())

    const bubbles = [...painted(container, ME), ...painted(container, APEX)]

    for (const selector of [
      '[data-single-thread-process]',
      '[data-process-steps]',
      '[data-next-steps]',
      '[data-memory-noted]'
    ]) {
      const element = container.querySelector(selector)!

      expect(
        bubbles.filter(bubble => bubble.contains(element)),
        selector
      ).toEqual([])
    }

    // The next steps come last, under the steps, as in the prototype.
    expect(getComputedStyle(container.querySelector('[data-slot="aui_assistant-message-content"]')!).display).toBe(
      'flex'
    )
    expect(getComputedStyle(container.querySelector('[data-next-steps]')!).order).toBe('1')
  })

  it('the failure card and the activity line are outside the bubbles too', async () => {
    const failed = renderZh(remixFailedTurn())
    const card = await found(failed.container, '[data-process-failure]')

    expect(painted(failed.container, APEX).some(bubble => bubble.contains(card))).toBe(false)
    expect(painted(failed.container, APEX)).toContain(words('抱歉，这条视频的语音没识别出来。'))
    cleanup()

    const running = renderZh(remixRunningTurn())
    const line = await found(running.container, '[data-single-thread-activity]')

    expect(painted(running.container, APEX).some(bubble => bubble.contains(line))).toBe(false)
  })

  it('a reply that is only a 下一步 block draws no empty bubble', async () => {
    const turn = resultTurn()
    const last = turn.at(-1)!
    const content = (last.content as readonly { type: string }[]).filter(part => part.type !== 'text')

    const { container } = renderZh([
      ...turn.slice(0, -1),
      { ...last, content: [...content, { type: 'text', text: NEXT }] } as unknown as ThreadMessage
    ])

    await waitFor(() => expect(container.querySelector('[data-next-steps]')).not.toBeNull())

    const empty = [...container.querySelectorAll('[data-slot="aui_assistant-message-content"] > [data-status]')].filter(
      element => !element.textContent?.trim()
    )

    expect(empty).toHaveLength(1)
    expect(getComputedStyle(empty[0]).display).toBe('none')
  })

  it('your message scrolls with the conversation instead of pinning to the top, on the right', async () => {
    const { container } = renderZh(resultTurn())

    await screen.findByText(RESULT, { exact: false })

    const userRoot = container.querySelector('[data-slot="aui_user-message-root"]')!
    const bubble = screen.getByRole('button', { name: '编辑消息' })

    expect(userRoot.classList.contains('sticky')).toBe(true)
    expect(getComputedStyle(userRoot).position).toBe('static')
    expect(getComputedStyle(bubble.parentElement!).marginLeft).toBe('auto')
  })
})

describe('hc-1059 the centred time line', () => {
  // The fake clock stays in the past. The transcript's stick-to-bottom loop keeps asking
  // for frames while `Date.now()` is behind the moment a scroll started, so a scroll still
  // in flight when a clock ahead of the real one is put back runs on until the test
  // environment is gone (an unhandled rejection that failed #487's first CI run).
  const REAL_NOW = Date.now()
  const at = (day: number, hour: number, minute: number) => new Date(2026, 0, day, hour, minute)

  /** Lets the mount-time scroll finish before the test ends and the real clock comes back. */
  const settle = () =>
    act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })

  const said = (id: string, role: 'assistant' | 'user', createdAt: Date, text: string) =>
    ({
      id,
      role,
      content: [{ type: 'text', text }],
      createdAt,
      ...(role === 'user'
        ? { attachments: [], metadata: { custom: {} } }
        : {
            status: { type: 'complete', reason: 'stop' },
            metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
          })
    }) as unknown as ThreadMessage

  const exchange = (id: string, ask: Date, answer = ask) => [
    said(`${id}-ask`, 'user', ask, `问 ${id}`),
    said(`${id}-answer`, 'assistant', answer, `答 ${id}`)
  ]

  /** The lines between turns, in order: dividers by their label, time lines by their text. */
  const lines = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-turn-divider], [data-turn-time]')].map(node =>
      node.hasAttribute('data-turn-time') ? node.textContent : `—${node.getAttribute('aria-label')}—`
    )

  async function renderAt(now: Date, messages: ThreadMessage[]) {
    expect(now.getTime()).toBeLessThan(REAL_NOW)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)

    const view = renderZh(messages)

    await screen.findByText(`答 ${messages.at(-1)!.id.replace(/-answer$/, '')}`)
    await settle()

    return view
  }

  it.each([
    [
      'a thread that started today opens on 「今天」',
      [...exchange('a', at(14, 14, 20)), ...exchange('b', at(14, 14, 40))],
      ['今天 14:20']
    ],
    [
      'yesterday, then today: 「昨天」, the new day, its time',
      [...exchange('a', at(13, 14, 52)), ...exchange('b', at(14, 9, 10))],
      ['昨天 14:52', '—1 月 14 日 周三—', '09:10']
    ],
    [
      'older than yesterday keeps the date line, with the time under it',
      exchange('a', at(8, 14, 20)),
      ['—1 月 8 日 周四—', '14:20']
    ],
    [
      'six idle hours in one day: 「新的一段」 and its time',
      [...exchange('a', at(14, 8, 0)), ...exchange('b', at(14, 14, 5))],
      ['今天 08:00', '—新的一段—', '14:05']
    ]
  ])('%s', async (_label, messages, expected) => {
    const { container } = await renderAt(at(14, 16, 0), messages)

    expect(lines(container)).toEqual(expected)
  })

  it('after midnight the next message turns 「今天」 into 「昨天」 and adds the new day', async () => {
    const first = exchange('a', at(14, 14, 20))
    const { container, rerender } = await renderAt(at(14, 23, 59), first)

    expect(lines(container)).toEqual(['今天 14:20'])

    vi.setSystemTime(at(15, 0, 1))

    const next = [...first, ...exchange('b', at(15, 0, 1))]

    rerender(
      <I18nProvider configClient={null} initialLocale="zh">
        <ThreadRuntime messages={next}>
          <Thread />
        </ThreadRuntime>
      </I18nProvider>
    )

    await screen.findByText('答 b')
    await settle()
    expect(lines(container)).toEqual(['昨天 14:20', '—1 月 15 日 周四—', '00:01'])
  })

  it.each([
    ['switch off', false, 'product'],
    ['developer mode', true, 'technical']
  ] as const)('%s: no time lines', async (_label, on, view) => {
    setSingleThreadFlagForTest(on)
    setToolViewMode(view)

    const { container } = await renderAt(at(14, 16, 0), [
      ...exchange('a', at(13, 14, 52)),
      ...exchange('b', at(14, 9, 10))
    ])

    expect(lines(container)).toEqual([])
  })
})
