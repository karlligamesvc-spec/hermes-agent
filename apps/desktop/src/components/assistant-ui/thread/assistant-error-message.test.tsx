import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { restoreRecordingTimeZone } from '@/__identity__/single-thread-shell/time-zone'
import { FAILED_REPLIES } from '@/__identity__/upstream-copy/render'
import { stubThreadEnvironment, stubThreadViewportSize } from '@/components/assistant-ui/test-utils'
import { I18nProvider } from '@/i18n/context'
import type { Locale } from '@/i18n/types'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { serviceSaid } from './assistant-error-message'

import { Thread } from '.'

// hc-1116: in single-thread product mode the error card under a failed reply
// says what happened in APEX's words instead of printing the engine's English
// (/model, /retry, `hermes fallback add`, Hermes). Developer mode and
// single_thread off are pinned byte for byte by upstream-copy-identity.test.tsx.

stubThreadEnvironment()
stubThreadViewportSize()

// The fixtures come from the identity harness, which pins the recording time zone on import.
afterAll(restoreRecordingTimeZone)

// What an upstream failure text may not leak into the card's body.
const UPSTREAM = /hermes|\/model|\/retry|Custom reported|Details:|Provider said/i

function renderThread(messages: ThreadMessage[], locale: Locale = 'zh') {
  function Harness() {
    const runtime = useExternalStoreRuntime<ThreadMessage>({ messages, isRunning: false, onNew: async () => {} })

    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread />
      </AssistantRuntimeProvider>
    )
  }

  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <Harness />
    </I18nProvider>
  )
}

function bodies(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-slot="aui_error-body"]')].map(node => node.textContent ?? '')
}

beforeEach(() => {
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
})

afterEach(() => {
  cleanup()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
})

describe('the error card in single-thread product mode', () => {
  it('says what failed in APEX’s words and keeps only the service’s own words', async () => {
    const { container } = renderThread(FAILED_REPLIES)

    await screen.findByText('提供方错误')

    expect(bodies(container)).toEqual([
      '模型服务这次没有正常回应，你的消息还没有得到回答。服务方说：模型服务繁忙，请稍后再试。',
      '这一轮没做完，你的消息还没有得到回答。'
    ])

    for (const alert of container.querySelectorAll('[role="alert"]')) {
      expect(alert.textContent).not.toMatch(UPSTREAM)
    }
  })

  it.each([
    ['zh-hant', '模型服務這次沒有正常回應，你的訊息還沒有得到回答。服務方說：模型服务繁忙，请稍后再试。'],
    [
      'en',
      "The model service didn't respond properly; your message hasn't been answered.The service said: 模型服务繁忙，请稍后再试。"
    ],
    [
      'ja',
      "The model service didn't respond properly; your message hasn't been answered.The service said: 模型服务繁忙，请稍后再试。"
    ]
  ] as [Locale, string][])('speaks %s', async (locale, body) => {
    const { container } = renderThread(FAILED_REPLIES.slice(0, 2), locale)

    await screen.findAllByRole('alert')

    expect(bodies(container)).toEqual([body])
  })

  it.each([
    ['auth', '模型服务没有接受这次登录。请重新登录 APEX 后再试（用自己密钥的，检查一下密钥）。'],
    ['billing', '额度不够了，你的消息还没有得到回答。'],
    ['runtime', 'APEX 在这台电脑上的引擎出了问题，你的消息还没有得到回答。一直这样的话，退出 APEX 再重新打开。'],
    ['disk', '磁盘空间不够，这一轮没法继续。腾出一些空间后再试。']
  ])('names what to do for a %s failure', async (layer, body) => {
    // The second failed reply: an engine text that carries no service words.
    const [, , ask, failed] = FAILED_REPLIES

    const reply = {
      ...failed,
      metadata: { ...failed.metadata, custom: { errorSurface: { code: 'x', layer, retryable: false } } }
    } as ThreadMessage

    const { container } = renderThread([ask, reply])

    await screen.findAllByRole('alert')

    expect(bodies(container)).toEqual([body])
  })
})

describe('serviceSaid', () => {
  it('takes the first line after "Provider said:"', () => {
    expect(serviceSaid('Lead.\n\nProvider said: 额度已用完\nmore')).toBe('额度已用完')
  })

  it('is null when the text carries none (a Details: line is not the service talking)', () => {
    expect(serviceSaid('Lead.\nDetails: RuntimeError: boom')).toBeNull()
    expect(serviceSaid('')).toBeNull()
  })

  it('caps a long one', () => {
    const words = serviceSaid(`Provider said: ${'x'.repeat(500)}`)

    expect(words).toHaveLength(200)
    expect(words?.endsWith('…')).toBe(true)
  })
})
