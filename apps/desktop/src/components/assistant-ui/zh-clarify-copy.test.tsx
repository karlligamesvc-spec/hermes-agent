import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { onComposerInsertRequest } from '@/app/chat/composer/focus'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { $gateway } from '@/store/gateway'
import { rememberServerRequest, resetServerRequestsForTests } from '@/store/server-requests'
import { $activeSessionId } from '@/store/session'
import { englishWords, readableText } from '@/test/zh-copy'

import { ClarifyTool } from './clarify-tool'

// hc-953: the question card in a Chinese chat. The backend marks the
// agent's pick with the English wire marker "(Recommended)"; a Chinese user
// must read 「推荐」, and every button, hint and progress line around it must
// be Chinese too. Same harness as clarify-tool.test.tsx, at zh.

vi.mock('@assistant-ui/react', () => ({
  useAuiState: () => true
}))

const QUESTION = '你手上有什么素材？'
const CHOICES = ['先出 10 秒样片 (Recommended)', '只要拍摄脚本', '换个方向']

function props(args: Record<string, unknown>, result?: unknown): ToolCallMessagePartProps {
  return {
    addResult: vi.fn(),
    args,
    argsText: JSON.stringify(args),
    isError: false,
    respondToApproval: vi.fn(),
    result,
    resume: vi.fn(),
    status: result === undefined ? { type: 'running' } : { type: 'complete' },
    toolCallId: 'clarify-zh',
    toolName: 'clarify',
    type: 'tool-call'
  } as ToolCallMessagePartProps
}

function renderZh(part: ToolCallMessagePartProps) {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ClarifyTool {...part} />
    </I18nProvider>
  )
}

function openRequest(request: Parameters<typeof setClarifyRequest>[0]) {
  rememberServerRequest({ fail: vi.fn(), id: request.requestId, method: 'clarify', params: {}, respond: vi.fn() })
  $activeSessionId.set('session-zh')
  $gateway.set({ request: vi.fn().mockResolvedValue({ ok: true, remaining: [] }) } as never)
  setClarifyRequest(request)
}

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  resetServerRequestsForTests()
})

afterEach(() => {
  cleanup()
  clearClarifyRequest()
  resetServerRequestsForTests()
  setRuntimeI18nLocale('en')
  $activeSessionId.set(null)
  $gateway.set(null)
})

describe('the question card in a Chinese chat', () => {
  it('marks the recommended choice 「推荐」 and keeps every control Chinese', () => {
    openRequest({
      choices: CHOICES,
      multiSelect: false,
      question: QUESTION,
      requestId: 'request-zh',
      sessionId: 'session-zh'
    })

    const { container } = renderZh(props({ choices: CHOICES, question: QUESTION }))
    const recommended = screen.getByRole('button', { name: /先出 10 秒样片/ })

    expect(recommended.textContent).toBe('A先出 10 秒样片 推荐')
    expect(englishWords(readableText(container))).toEqual([])
  })

  it('keeps a several-question card Chinese, progress line included', () => {
    openRequest({
      choices: null,
      multiSelect: false,
      question: '',
      questions: [
        { choices: CHOICES, multiSelect: false, qid: 'q0', question: QUESTION },
        { choices: null, multiSelect: false, qid: 'q1', question: '账号叫什么？' }
      ],
      requestId: 'request-batch-zh',
      sessionId: 'session-zh'
    })

    const { container } = renderZh(
      props({ questions: [{ question: QUESTION, choices: CHOICES }, { question: '账号叫什么？' }] })
    )

    expect(screen.getByText('已回答 0/2')).toBeTruthy()
    expect(screen.getByRole('button', { name: /确认并继续/ })).toBeTruthy()
    expect(englishWords(readableText(container))).toEqual([])
  })

  it('drafts a late answer in Chinese, without the wire marker', async () => {
    const inserts: string[] = []
    const stop = onComposerInsertRequest(detail => inserts.push(detail.text))

    try {
      const { container } = renderZh(
        props({ choices: CHOICES, question: QUESTION }, { question: QUESTION, user_response: '' })
      )

      expect(englishWords(readableText(container))).toEqual([])

      fireEvent.click(screen.getByRole('button', { name: /先出 10 秒样片/ }))
      await new Promise(resolve => window.setTimeout(resolve, 0))

      expect(inserts).toEqual([`关于“${QUESTION}”，我的回答是：先出 10 秒样片`])
    } finally {
      stop()
    }
  })
})
