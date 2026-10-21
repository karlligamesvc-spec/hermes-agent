/**
 * WP4 on the real chat composer (Kael 2026-10-20): attach · voice · send, the
 * rest one level down under "+" › 高级, and a pasted short-video link or a
 * dropped video offering 转逐字稿 / 拆它为什么火 / 仿写成我的脚本.
 *
 * Everything renders the actual ChatBar in Chinese, the way a creator meets it;
 * the PR lists the reverse injections that turn each block red.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { stubThreadEnvironment, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { APEX_PUBLIC_LLM_MODELS } from '@/lib/provider-allowlist'
import { $authState } from '@/store/auth'
import { clearSessionDraft, type ComposerAttachment, mainComposerScope } from '@/store/composer'
import { setToolViewMode } from '@/store/tool-view'
import { $autoSpeakReplies, setAutoSpeakReplies } from '@/store/voice-prefs'
import { $wakeWord } from '@/store/wake-word'
import { englishWords, readableText } from '@/test/zh-copy'

import { generationModels } from './generation-models'
import { composerPlainText } from './rich-editor'
import type { ChatBarProps, ChatBarState } from './types'

import { ChatBar } from '.'

const applyApprovalMode = vi.hoisted(() => vi.fn(async () => 'manual'))

vi.mock('@/lib/yolo-session', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  applyApprovalMode
}))

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  getSkills: vi.fn(async () => []),
  getMoaModels: vi.fn(async () => null)
}))

const STATE: ChatBarState = {
  model: { canSwitch: true, model: 'deepseek-flash', provider: 'custom' },
  tools: { enabled: true, label: 'Add context' },
  voice: { enabled: true, active: false }
}

const DOUYIN_SHARE =
  '7.43 复制打开抖音，看看【小林的作品】租房党的厨房收纳 # 好物分享  https://v.douyin.com/iRNBho6u/ k@D.ub 03/15 qrK:/'

const CHANNELS_SHARE = '我在看视频号的这条：https://weixin.qq.com/sph/AbCdEf12。你也看看'

const XHS_SHARE =
  '【租房改造 - 小林 | 小红书 - 你的生活指南】 😆 AbCdEfGhIjK 😆 http://xhslink.com/a/AbCdEfGhIjK，复制本条信息，打开【小红书】App查看精彩内容！'

function setTierMode(on: boolean) {
  $authState.set({
    ...$authState.get(),
    enabled: true,
    gateReason: null,
    modelTierMax: false,
    modelTiers: on,
    status: 'signed-in'
  })
}

/** Mount the composer and let its mount-time focus settle: a menu opened in
 *  the same tick loses its submenu to the editor taking focus. */
async function renderChatBar(props: Partial<ChatBarProps> = {}) {
  const onSubmit = vi.fn<ChatBarProps['onSubmit']>(async () => true)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <ThreadRuntime messages={[]}>
            <ChatBar
              busy={false}
              disabled={false}
              onCancel={() => {}}
              onPickFiles={() => {}}
              onPickFolders={() => {}}
              onPickImages={() => {}}
              onSubmit={onSubmit}
              state={STATE}
              {...props}
            />
          </ThreadRuntime>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )

  await settle()

  return { onSubmit, view }
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

const editor = () => screen.getByRole('textbox', { name: '消息' })

function caretToEnd(element: HTMLElement) {
  element.focus()
  const range = window.document.createRange()
  range.selectNodeContents(element)
  range.collapse(false)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
}

/** A real focused paste: the composer's own handler reads the clipboard. */
async function paste(text: string) {
  const target = editor()
  caretToEnd(target)

  const event = new Event('paste', { bubbles: true, cancelable: true })

  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: { item: () => null, length: 0 },
      getData: (type: string) => (type === 'text' || type === 'text/plain' ? text : ''),
      items: []
    }
  })

  await act(async () => {
    target.dispatchEvent(event)
  })
  await settle()
}

// Radix opens a dropdown on pointerdown, not on a bare click.
function openPlusMenu() {
  const trigger = screen.getByRole('button', { name: '添加图片、文件和更多' })

  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 })
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 })
  fireEvent.click(trigger)
}

async function openSubmenu(name: string) {
  const row = await screen.findByRole('menuitem', { name: new RegExp(`^${name}`) })

  row.focus()
  fireEvent.keyDown(row, { key: 'ArrowRight' })
  await settle()
}

/** What the open menus show a reader — the image / video rows included: in
 *  tier mode they name no model either (hc-960 exit 31, Kael 2026-10-20). */
const menuText = () =>
  [...window.document.querySelectorAll('[role="menu"]')].map(menu => readableText(menu as HTMLElement)).join('\n')

const toolbarButtons = () => {
  const root = window.document.querySelector('[data-slot="composer-layout"]')!

  return within(root as HTMLElement)
    .queryAllByRole('button')
    .map(button => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '')
}

const video = (path = '/Users/me/Movies/收纳实测.mp4'): ComposerAttachment => ({
  id: `file:${path}`,
  kind: 'file',
  label: path.split('/').pop()!,
  path
})

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

beforeEach(() => {
  stubThreadEnvironment()
  setRuntimeI18nLocale('zh')
  setTierMode(true)
  setToolViewMode('product')
})

afterEach(() => {
  cleanup()
  mainComposerScope.clear()
  // A draft is stashed per session and comes back on the next mount.
  clearSessionDraft(null)
  setTierMode(false)
  setToolViewMode('product')
  $wakeWord.set({ ...$wakeWord.get(), listening: false })
  setRuntimeI18nLocale('en')
  vi.unstubAllGlobals()
})

describe('paste-to-act on the chat composer', () => {
  it('keeps a pasted share text as written and offers the three chips', async () => {
    await renderChatBar()
    await paste(DOUYIN_SHARE)

    // No `@url:` chip: the gateway would fetch the anti-bot page before the turn.
    expect(editor().querySelector('[data-ref-text]')).toBeNull()
    expect(editor().textContent).toContain('https://v.douyin.com/iRNBho6u/')

    const group = await screen.findByRole('group', { name: '用这条视频做什么' })

    expect(
      within(group)
        .getAllByRole('button')
        .map(button => button.textContent)
    ).toEqual(['转逐字稿', '拆它为什么火', '仿写成我的脚本'])
  })

  // The twin of the test above: an ordinary link still chips on a focused
  // paste, so "the share text stays plain" is the short-video rule at work and
  // not a paste path that never chips anything (it didn't, before this PR: a
  // leaked regex lastIndex skipped the paste's first link).
  it('still turns an ordinary pasted link into an @url: chip', async () => {
    await renderChatBar()
    await paste('参考一下 https://example.com/post/1')

    expect(editor().querySelector('[data-ref-text]')).not.toBeNull()
  })

  // Kael (2026-10-20): ordinary links stay web references, and Chinese glued
  // onto one stays prose instead of riding into the chip.
  it('ends an ordinary link’s chip where the Chinese starts', async () => {
    await renderChatBar()
    await paste('看这个https://example.com/post/1，写得好')

    expect(composerPlainText(editor())).toBe('看这个@url:`https://example.com/post/1`，写得好')
  })

  it('sends the chip’s request through the normal submit path and clears the draft', async () => {
    const { onSubmit } = await renderChatBar()
    await paste(DOUYIN_SHARE)
    fireEvent.click(await screen.findByRole('button', { name: '转逐字稿' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toBe('把这条抖音视频转成逐字稿：https://v.douyin.com/iRNBho6u/')
    await waitFor(() => expect(editor().textContent).toBe(''))
    expect(screen.queryByRole('group', { name: '用这条视频做什么' })).toBeNull()
  })

  it('leaves a Xiaohongshu share text whole — the old chip swallowed its Chinese tail', async () => {
    const { onSubmit } = await renderChatBar()
    await paste(XHS_SHARE)

    expect(editor().querySelector('[data-ref-text]')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '仿写成我的脚本' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toBe(
      '照这条小红书笔记的结构和节奏，仿写一个我的口播脚本：http://xhslink.com/a/AbCdEfGhIjK'
    )
  })

  it('lets the user ignore the chips and send their own words', async () => {
    const { onSubmit } = await renderChatBar()
    await paste(DOUYIN_SHARE)
    await screen.findByRole('group', { name: '用这条视频做什么' })

    const target = editor()

    target.append(window.document.createTextNode(' 评论区都在问什么'))
    fireEvent.input(target)
    await act(async () => new Promise(resolve => setTimeout(resolve, 20)))
    fireEvent.keyDown(target, { key: 'Enter' })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const sent = onSubmit.mock.calls[0]![0]

    expect(sent).toContain('https://v.douyin.com/iRNBho6u/')
    expect(sent).toContain('评论区都在问什么')
    expect(sent).not.toContain('@url:')
  })

  it('offers the chips for a dropped local video and sends it along', async () => {
    const { onSubmit } = await renderChatBar()
    const clip = video()

    act(() => mainComposerScope.add(clip))
    fireEvent.click(await screen.findByRole('button', { name: '拆它为什么火' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const [text, options] = onSubmit.mock.calls[0]!

    expect(text).toBe('拆解这个视频为什么火')
    expect(options?.attachments?.map(item => item.path)).toEqual([clip.path])
  })

  // Kael (2026-10-20): a 视频号 video can't be downloaded from its link, so the
  // strip says so up front instead of chips the assistant could only answer
  // with "send me the file".
  it('asks for a 视频号 video to be saved and dragged in, then acts on the video', async () => {
    const { onSubmit } = await renderChatBar()
    await paste(CHANNELS_SHARE)

    const hint = () => window.document.querySelector('[data-slot="composer-paste-hint"]')

    expect(hint()?.textContent).toBe('视频号的视频没法从链接下载：先把视频存到电脑，再拖进来')
    expect(screen.queryByRole('group', { name: '用这条视频做什么' })).toBeNull()
    expect(editor().querySelector('[data-ref-text]')).toBeNull()

    const clip = video('/Users/me/Movies/视频号存下来的.mp4')

    act(() => mainComposerScope.add(clip))
    fireEvent.click(await screen.findByRole('button', { name: '转逐字稿' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const [text, options] = onSubmit.mock.calls[0]!

    expect(text).toBe('把这个视频转成逐字稿')
    expect(options?.attachments?.map(item => item.path)).toEqual([clip.path])
    expect(hint()).toBeNull()
  })

  it('offers nothing for an ordinary link or a non-video file', async () => {
    await renderChatBar()
    await paste('参考一下 https://example.com/post/1')
    act(() => mainComposerScope.add({ ...video('/Users/me/notes.txt') }))
    await act(async () => new Promise(resolve => setTimeout(resolve, 20)))

    expect(screen.queryByRole('group', { name: '用这条视频做什么' })).toBeNull()
  })
})

describe('attach · voice · send', () => {
  it('leaves the row with only the three, on an APEX account', async () => {
    await renderChatBar()

    expect(toolbarButtons()).toEqual(['添加图片、文件和更多', '开始语音对话', '发送'])
  })

  it('still shows the mic when it is live, so folding the settings away hides nothing', async () => {
    $wakeWord.set({ ...$wakeWord.get(), listening: true })
    await renderChatBar()

    expect(toolbarButtons()).toEqual(['添加图片、文件和更多', 'APEX 语音唤醒：正在听', '开始语音对话', '发送'])
  })

  it('keeps every old control one level down under 高级', async () => {
    await renderChatBar()
    openPlusMenu()

    for (const row of ['添加图片', '添加文件或视频', '添加文件夹', '图片', '视频']) {
      expect(screen.getByRole('menuitem', { name: new RegExp(`^${row}`) })).toBeTruthy()
    }

    await openSubmenu('高级')

    for (const row of ['场景…', '审批方式', '语音设置', '已启用技能', '未启用技能', '连接器']) {
      expect(await screen.findByRole('menuitem', { name: new RegExp(`^${row}`) })).toBeTruthy()
    }

    await openSubmenu('审批方式')
    expect((await screen.findAllByRole('menuitemradio')).map(item => item.textContent)).toEqual([
      expect.stringContaining('手动审批'),
      expect.stringContaining('智能审批'),
      expect.stringContaining('完全访问')
    ])

    await openSubmenu('语音设置')
    expect(await screen.findByRole('menuitem', { name: '开始语音对话' })).toBeTruthy()
    expect(screen.getAllByRole('menuitemcheckbox').map(item => item.textContent?.trim())).toEqual([
      '语音听写',
      '朗读回复',
      'APEX 语音唤醒：已关闭'
    ])
  })

  it('changes approvals from 高级 › 审批方式 through the same write the pill used', async () => {
    await renderChatBar()
    openPlusMenu()
    await openSubmenu('高级')
    await openSubmenu('审批方式')
    // The profile default is 智能审批, so pick the other gating tier.
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /手动审批/ }))

    await waitFor(() => expect(applyApprovalMode).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'manual'))
  })

  it('turns read-aloud on from 高级 › 语音设置', async () => {
    await setAutoSpeakReplies(false)
    await renderChatBar()
    openPlusMenu()
    await openSubmenu('高级')
    await openSubmenu('语音设置')
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '朗读回复' }))

    await waitFor(() => expect($autoSpeakReplies.get()).toBe(true))
    await setAutoSpeakReplies(false)
  })

  it('opens the scenario picker from 高级 › 场景', async () => {
    await renderChatBar()
    openPlusMenu()
    await openSubmenu('高级')
    fireEvent.click(await screen.findByRole('menuitem', { name: '场景…' }))

    expect(await screen.findByRole('textbox', { name: '搜索场景…' })).toBeTruthy()
  })

  it('shows no English in the "+" menu or 高级, and no model anywhere in 高级', async () => {
    await renderChatBar()
    openPlusMenu()

    const seen = [menuText()]

    await openSubmenu('高级')
    const advanced = menuText()

    await openSubmenu('审批方式')
    const approval = menuText()

    await openSubmenu('语音设置')
    const voice = menuText()

    seen.push(advanced, approval, voice)

    expect(englishWords(seen.join('\n'))).toEqual([])

    // The image / video rows name no generation model (hc-960 exit 31).
    const generationLabels = [...generationModels('image'), ...generationModels('video')].map(model => model.label)

    expect(generationLabels.filter(label => seen[0]!.includes(label))).toEqual([])

    // On an APEX account the tier lives in the assistant's settings (hc-960):
    // 高级 must not grow a model row back.
    for (const text of [advanced, approval, voice]) {
      expect(text).not.toMatch(/模型|档位/)
      expect(APEX_PUBLIC_LLM_MODELS.filter(model => text.includes(model))).toEqual([])
    }
  })

  it('keeps the full old row in developer mode', async () => {
    setToolViewMode('technical')
    await renderChatBar()

    expect(toolbarButtons()).toEqual(['添加图片、文件和更多', '场景', '审批', '语音', '开始语音对话', '发送'])
  })
})
