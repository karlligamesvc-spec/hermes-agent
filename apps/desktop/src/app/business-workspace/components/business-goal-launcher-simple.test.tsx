/**
 * WP4 on the Start input — the first composer a creator meets: attach · voice
 * · send in the footer, the workflow choice under "+" › 高级, and the same
 * paste-to-act chips the chat composer offers.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { COMPOSER_SIMPLE_COPY } from '@/i18n/composer-simple'
import { $authState } from '@/store/auth'
import type { ComposerAttachment } from '@/store/composer'
import { setToolViewMode } from '@/store/tool-view'
import { chooseWorkflowFromAddMenu, stubMenuPointerApis } from '@/test/composer-add-menu'

import { BusinessGoalLauncher, type BusinessGoalLauncherProps } from './business-goal-launcher'

const zh = COMPOSER_SIMPLE_COPY.zh

const DOUYIN_SHARE =
  '7.43 复制打开抖音，看看【小林的作品】租房党的厨房收纳 # 好物分享  https://v.douyin.com/iRNBho6u/ k@D.ub 03/15 qrK:/'

function renderLauncher(props: Partial<BusinessGoalLauncherProps> = {}) {
  const onSubmit = vi.fn(async (_goal: string) => true)
  const onChoose = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={client}>
      <I18nProvider configClient={null} initialLocale="zh">
        <BusinessGoalLauncher
          model={{ canSwitch: true, model: 'deepseek-flash', provider: 'custom' }}
          onPickFiles={vi.fn()}
          onPickFolders={vi.fn()}
          onPickImages={vi.fn()}
          onSubmit={onSubmit}
          workflow={{ disabled: false, label: '选择工作流', onChoose }}
          {...props}
        />
      </I18nProvider>
    </QueryClientProvider>
  )

  const goal = screen.getByRole('textbox', { name: '业务目标' }) as HTMLTextAreaElement

  return { form: goal.closest('form')!, goal, onChoose, onSubmit }
}

/** A paste into the textarea: the browser inserts the text (change), the
 *  launcher only listens to remember the share text. */
function paste(goal: HTMLTextAreaElement, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true })

  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
  goal.dispatchEvent(event)
  fireEvent.change(goal, { target: { value: text } })
}

const footerButtons = (form: HTMLElement) =>
  within(form.querySelector('[data-business-goal-footer]') as HTMLElement)
    .getAllByRole('button')
    .map(button => button.getAttribute('aria-label') ?? button.textContent?.trim())

beforeAll(stubMenuPointerApis)

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  setToolViewMode('product')
  $authState.set({ ...$authState.get(), enabled: true, modelTiers: true, status: 'signed-in' })
})

afterEach(() => {
  cleanup()
  setToolViewMode('product')
  $authState.set({ ...$authState.get(), modelTiers: false })
  setRuntimeI18nLocale('en')
})

describe('the Start input, attach · voice · send', () => {
  it('has only the three in its footer on an APEX account', () => {
    const { form } = renderLauncher()

    expect(footerButtons(form)).toEqual(['开始执行', zh.addMenu, '开始语音对话'])
    expect(form.querySelector('[data-start-workflow-selection]')).toBeNull()
  })

  it('keeps the workflow choice under "+" › 高级', async () => {
    const { form, onChoose } = renderLauncher()

    await chooseWorkflowFromAddMenu(form, zh, '选择工作流')

    expect(onChoose).toHaveBeenCalledTimes(1)
  })

  it('keeps the footer button in developer mode', () => {
    setToolViewMode('technical')
    const { form, onChoose } = renderLauncher()

    fireEvent.click(within(form).getByRole('button', { name: '选择工作流' }))

    expect(onChoose).toHaveBeenCalledTimes(1)
  })
})

describe('paste-to-act on the Start input', () => {
  it('offers the chips for a pasted share text and sends the chip’s request', async () => {
    const { goal, onSubmit } = renderLauncher()

    paste(goal, DOUYIN_SHARE)
    fireEvent.click(await screen.findByRole('button', { name: '拆它为什么火' }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith('拆解这条抖音视频为什么火：https://v.douyin.com/iRNBho6u/')
    )
    await waitFor(() => expect(goal.value).toBe(''))
  })

  it('offers them for a dropped video with nothing typed', async () => {
    const clip: ComposerAttachment = { id: 'file:clip', kind: 'file', label: '探店.mov', path: '/Users/me/探店.mov' }
    const { onSubmit } = renderLauncher({ attachments: [clip] })

    fireEvent.click(await screen.findByRole('button', { name: '转逐字稿' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('把这个视频转成逐字稿'))
  })

  it('asks for a 视频号 video to be saved and dragged in instead of offering the chips', () => {
    const { goal } = renderLauncher()

    paste(goal, '视频号这条不错 https://weixin.qq.com/sph/AbCdEf12')

    expect(window.document.querySelector('[data-slot="composer-paste-hint"]')?.textContent).toBe(zh.paste.saveFirst)
    expect(screen.queryByRole('group', { name: zh.paste.group })).toBeNull()
  })

  it('keeps the goal typed by hand untouched when nothing is a video', () => {
    const { goal } = renderLauncher()

    fireEvent.change(goal, { target: { value: '分析美国宠物用品市场' } })

    expect(screen.queryByRole('group', { name: zh.paste.group })).toBeNull()
  })
})
