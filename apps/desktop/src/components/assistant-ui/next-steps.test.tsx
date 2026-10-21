import { type ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale, setRuntimeI18nLocale } from '@/i18n'
import { sanitizeTextForSpeech } from '@/lib/speech-text'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'
import { REMIX_ANSWER, remixFailedTurn, remixLiveTurn } from '@/test/remix-turn'
import { englishWords, readableText } from '@/test/zh-copy'

import { createdAt, stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from './test-utils'
import { Thread } from './thread'

const submitted = vi.hoisted(() => [] as string[])

vi.mock('@/app/chat/composer/focus', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  requestComposerSubmit: (text: string) => {
    submitted.push(text)

    return true
  }
}))

// 「下一步」 (apex-next/1): a creator skill ends its result with a block of options; the
// Desktop shows them as buttons under the answer and never the block itself. A click sends
// the option's sentence as the user's message. A failed result gets hc-973's three buttons.

stubThreadEnvironment()
stubThreadViewportSize()

type Part = Record<string, unknown>

const BLOCK = [
  '<!-- apex:next',
  '存进选题库 | 把这 5 个选题存进我的选题库',
  '写成脚本 | 把第 1 个选题写成 60 秒口播脚本',
  '做成发布包 | 把第 1 个选题做成发布包，我自己去发',
  '-->'
].join('\n')

const RESULT = `给你 5 个选题：\n\n1. 收纳避坑\n2. 小户型改造\n\n${BLOCK}`

function message(id: string, role: 'assistant' | 'user', content: Part[], running = false): ThreadMessage {
  return {
    id,
    role,
    content,
    ...(role === 'user'
      ? { attachments: [] }
      : { status: running ? { type: 'running' } : { type: 'complete', reason: 'stop' } }),
    createdAt,
    metadata:
      role === 'user'
        ? { custom: {} }
        : { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
  } as unknown as ThreadMessage
}

const said = (text: string): Part => ({ type: 'text', text })
const ask = (id = 'ask', text = '帮我想几个家居收纳的选题') => message(id, 'user', [said(text)])
// A fresh id per render: a row someone already used stays used for that message (next-steps.tsx).
let answers = 0

const answer = (text = RESULT, running = false, id = `answer-${++answers}`) =>
  message(id, 'assistant', [said(text)], running)

function renderThread(messages: ThreadMessage[], locale: Locale = 'zh') {
  setRuntimeI18nLocale(locale)

  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )
}

const row = () => screen.queryByRole('group', { name: '下一步' })

beforeEach(() => {
  submitted.length = 0
  setToolViewMode('product')
  $activeSessionId.set('session-next-steps')
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
})

afterEach(() => {
  cleanup()
  $activeSessionId.set(null)
})

describe('a finished result with a 「下一步」 block', () => {
  it('shows the options as buttons under the answer, never the block', async () => {
    const { container } = renderThread([ask(), answer()])

    const group = await waitFor(() => {
      const found = row()
      expect(found).toBeTruthy()

      return found!
    })

    expect(
      within(group)
        .getAllByRole('button')
        .map(button => button.textContent)
    ).toEqual(['存进选题库', '写成脚本', '做成发布包'])
    expect(container.textContent).toContain('小户型改造')
    expect(container.textContent).not.toContain('apex')
    expect(container.textContent).not.toContain('把第 1 个选题写成')
  })

  it('hides a block the model wrapped in a code fence, and still offers its buttons', async () => {
    const fenced = `给你 5 个选题：\n\n1. 收纳避坑\n\n\`\`\`text\n${BLOCK}\n\`\`\`\n`
    const { container } = renderThread([ask(), answer(fenced)])

    await screen.findByRole('button', { name: '写成脚本' })

    expect(container.textContent).not.toContain('apex')
    expect(container.textContent).not.toContain('把第 1 个选题写成')
    expect(container.querySelector('pre')).toBeNull()
  })

  it('sends the option’s sentence as the user’s message, once', async () => {
    renderThread([ask(), answer()])

    const write = await screen.findByRole('button', { name: '写成脚本' })
    fireEvent.click(write)
    fireEvent.click(write)

    expect(submitted).toEqual(['把第 1 个选题写成 60 秒口播脚本'])
    expect((write as HTMLButtonElement).disabled).toBe(true)
  })

  it('says in Chinese what a click sends, with no English on the row', async () => {
    renderThread([ask(), answer()])

    const write = await screen.findByRole('button', { name: '写成脚本' })

    expect(write.getAttribute('title')).toBe('点一下就发：把第 1 个选题写成 60 秒口播脚本')
    expect(englishWords(readableText(row()!))).toEqual([])
  })

  it('waits while the gateway is down', async () => {
    $gatewayState.set('closed')
    renderThread([ask(), answer()])

    const write = await screen.findByRole('button', { name: '写成脚本' })
    fireEvent.click(write)

    expect((write as HTMLButtonElement).disabled).toBe(true)
    expect(submitted).toEqual([])
  })

  it('copies the reply without the block', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    renderThread([ask(), answer()])

    await screen.findByRole('button', { name: '写成脚本' })
    fireEvent.click(screen.getAllByRole('button', { name: '复制' }).at(-1)!)

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText.mock.calls[0]).toEqual(['给你 5 个选题：\n\n1. 收纳避坑\n2. 小户型改造'])
  })

  it('reads the reply aloud without the block', () => {
    expect(sanitizeTextForSpeech(RESULT)).toBe('给你 5 个选题：. 1. 收纳避坑 2. 小户型改造')
  })
})

describe('when there are no buttons', () => {
  it('has none while the reply is still streaming, and no block text either', async () => {
    const streaming = `给你 5 个选题：\n\n1. 收纳避坑\n\n<!-- apex:next\n存进选题库 | 把这 5 个`
    const { container } = renderThread([ask(), answer(streaming, true)])

    await waitFor(() => expect(container.textContent).toContain('收纳避坑'))

    expect(row()).toBeNull()
    expect(container.textContent).not.toContain('apex')
    expect(container.textContent).not.toContain('把这 5 个')
  })

  it('has none while the turn is still running, even once the whole block has arrived', async () => {
    const { container } = renderThread([ask(), answer(RESULT, true)])

    await waitFor(() => expect(container.textContent).toContain('小户型改造'))

    expect(row()).toBeNull()
    expect(container.textContent).not.toContain('apex')
  })

  it('has none on an earlier result the conversation has moved past', async () => {
    const { container } = renderThread([ask(), answer(), ask('ask-2', '换个方向'), answer('好的，换成厨房收纳。')])

    await waitFor(() => expect(container.textContent).toContain('换成厨房收纳'))

    expect(row()).toBeNull()
    expect(container.textContent).not.toContain('apex')
  })

  it('has none for a reply without a block', async () => {
    const { container } = renderThread([ask(), answer('普通回复。')])

    await waitFor(() => expect(container.textContent).toContain('普通回复。'))

    expect(row()).toBeNull()
  })
})

describe('a failed result', () => {
  const FAILED = '这条视频没生成出来：视频服务暂时不可用。脚本已经写好了。\n\n<!-- apex:next failed=生成视频 -->'

  it('offers hc-973’s three buttons, sending the same sentences', async () => {
    const { container } = renderThread([ask(), answer(FAILED)])

    const retry = await screen.findByRole('button', { name: '重试' })

    expect(screen.getByRole('button', { name: '换个办法' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '先给我能出的部分' })).toBeTruthy()
    expect(container.textContent).not.toContain('apex')

    fireEvent.click(retry)

    expect(submitted).toEqual(['再试一次「生成视频」这一步。'])
  })

  it('is not offered twice when the process block already shows the stuck step', async () => {
    const turn = remixFailedTurn()
    const last = turn.at(-1)!
    const content = [...(last.content as readonly Part[]), said('<!-- apex:next failed=识别语音 -->')]
    renderThread([...turn.slice(0, -1), { ...last, content } as unknown as ThreadMessage])

    await screen.findByRole('alert')

    expect(screen.getAllByRole('button', { name: '重试' })).toHaveLength(1)
    expect(row()).toBeNull()
  })
})

describe('in English', () => {
  it('names the row and the failure buttons in English; the options stay the skill’s own words', async () => {
    const turn = remixLiveTurn()
    const last = turn.at(-1)!

    const content = (last.content as readonly Part[]).map(part =>
      part.type === 'text' && part.text === REMIX_ANSWER ? said(`${REMIX_ANSWER}\n\n${BLOCK}`) : part
    )

    renderThread([...turn.slice(0, -1), { ...last, content } as unknown as ThreadMessage], 'en')

    const group = await screen.findByRole('group', { name: 'Next steps' })

    expect(within(group).getByRole('button', { name: '存进选题库' }).getAttribute('title')).toBe(
      'Sends: 把这 5 个选题存进我的选题库'
    )
  })
})
