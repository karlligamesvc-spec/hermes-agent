/**
 * hc-1101 identity guard (hard rule 11): what you sent looks and behaves the
 * same wherever single-thread product mode is not on.
 *
 * The goldens under `__identity__/user-message/` were recorded on fork main
 * 784a824659, before hc-1101 changed a line: every user row of a transcript
 * (the bubble, the pictures under it, the hover rail with stop or restore, the
 * background-process and assistant-to-assistant notes), with the switch off in
 * product mode, in developer mode and with reactions on. Developer mode with
 * the switch on must match the developer golden byte for byte. A diff here
 * means the off path moved: fix the code, do not re-record the golden unless
 * the change is meant to reach every user.
 */
// First: the recording time zone, before any app module or fixture (time-zone.ts).
import './__identity__/single-thread-shell/time-zone'

import { type ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { restoreRecordingTimeZone } from '@/__identity__/single-thread-shell/time-zone'
import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $displayTimestamps } from '@/store/display-timestamps'
import { $reactionsEnabled } from '@/store/reactions-enabled'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

stubThreadEnvironment()
stubThreadViewportSize()

const GOLDEN = './__identity__/user-message'
const NOW = new Date(2026, 9, 28, 9, 30)
const AT = new Date(2026, 9, 28, 9, 0)
const AT_S = AT.getTime() / 1000

function user(id: string, text: string, custom: Record<string, unknown> = {}): ThreadMessage {
  return {
    attachments: [],
    content: [{ text, type: 'text' }],
    createdAt: AT,
    id,
    metadata: { custom },
    role: 'user'
  } as ThreadMessage
}

function assistant(id: string, text: string, running = false): ThreadMessage {
  return {
    content: [{ text, type: 'text' }],
    createdAt: AT,
    id,
    metadata: { custom: {}, steps: [], unstable_annotations: [], unstable_data: [], unstable_state: null },
    role: 'assistant',
    status: running ? { type: 'running' } : { reason: 'stop', type: 'complete' }
  } as unknown as ThreadMessage
}

/** Every kind of user row: plain words, code and a link, pictures under the bubble, a
 *  background-process note, an assistant-to-assistant note, a stamped time, and the
 *  latest ask (the stop button while its turn runs, restore once it is done). */
function transcript(running: boolean): ThreadMessage[] {
  return [
    user('u-plain', '帮我拆一下这条为什么火，仿写成我的'),
    assistant('a-plain', '好，我先看看。'),
    user('u-code', '先跑 `npm test`，再看 https://v.douyin.com/iRemix01/ 这条', {
      timelineTimestamp: AT_S
    }),
    assistant('a-code', '跑完了。'),
    user('u-picture', '发了，1.2 万播放，完播 18%', { attachmentRefs: ['@image:`/tmp/数据截图.png`'] }),
    assistant('a-picture', '1.2 万比你前几条都高。'),
    user('u-process', '[IMPORTANT: Background process proc_1 finished\nexit code 0]'),
    assistant('a-process', '后台任务跑完了。'),
    user('u-agent', 'Message from 🤖 剪辑师 (@editor): 粗剪好了，你看看'),
    assistant('a-agent', '收到。'),
    user('u-last', '标题用第 1 个'),
    assistant('a-last', running ? '' : '好，用第 1 个。', running)
  ]
}

/** React's and Radix's generated ids count up per render in one run; they are not what the guard is about. */
function normalized(html: string): string {
  return html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|radix-[^"\s]+/g, '«id»')
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

async function userRows(running: boolean): Promise<string> {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ThreadRuntime messages={transcript(running)}>
        <Thread onCancel={() => {}} onRestoreToMessage={() => {}} />
      </ThreadRuntime>
    </I18nProvider>
  )

  await waitFor(() => expect(view.container.querySelectorAll('[data-slot="aui_user-message-root"]').length).toBe(6))
  await settle()

  const rows = [...view.container.querySelectorAll('[data-slot="aui_user-message-root"]')].map(root => {
    // The pictures row is the bubble's flow sibling (StickyHumanMessageContainer).
    const sibling = root.nextElementSibling
    const pictures = sibling && !sibling.hasAttribute('data-slot') ? `\n${sibling.outerHTML}` : ''

    return root.outerHTML + pictures
  })

  return normalized(rows.join('\n'))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  setRuntimeI18nLocale('zh')
  $activeSessionId.set('session-identity')
  $gatewayState.set('open')
  $displayTimestamps.set(true)
  $reactionsEnabled.set(false)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setRuntimeI18nLocale('en')
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  $reactionsEnabled.set(false)
  $activeSessionId.set(null)
})

afterAll(restoreRecordingTimeZone)

describe('single_thread off: the user rows are unchanged', () => {
  it.each([
    ['product', 'product'],
    ['developer', 'technical']
  ] as const)('%s mode, while the latest turn runs and once it is done', async (name, view) => {
    setSingleThreadFlagForTest(false)
    setToolViewMode(view)

    await expect(await userRows(true)).toMatchFileSnapshot(`${GOLDEN}/${name}-running.html`)
    cleanup()
    await expect(await userRows(false)).toMatchFileSnapshot(`${GOLDEN}/${name}-done.html`)
  })

  it('with reactions on', async () => {
    setSingleThreadFlagForTest(false)
    setToolViewMode('product')
    $reactionsEnabled.set(true)

    await expect(await userRows(false)).toMatchFileSnapshot(`${GOLDEN}/reactions-done.html`)
  })
})

describe('single_thread on in developer mode: the user rows match the developer goldens', () => {
  it.each([
    ['running', true],
    ['done', false]
  ] as const)('%s', async (name, running) => {
    setSingleThreadFlagForTest(true)
    setToolViewMode('technical')

    await expect(await userRows(running)).toMatchFileSnapshot(`${GOLDEN}/developer-${name}.html`)
  })
})
