/**
 * hc-1130 拿到结果, on the real transcript in single-thread product mode: the
 * chat holds the result and what the assistant says about it, file edits fold
 * into the process area, each result card has its own way to take the file
 * away. An approval a folded edit waits on stays on screen, and code the model
 * writes in its reply stays where it wrote it. The switch-off and developer-mode
 * look is pinned byte for byte in src/result-delivery-identity.test.tsx.
 */
import { type ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type Locale } from '@/i18n'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $previewStatusBySession } from '@/store/preview-status'
import { clearAllPrompts, setApprovalRequest } from '@/store/prompts'
import { $activeSessionId, $connection, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import { $singleThreadFlag } from '@/store/single-thread'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'
import {
  RESULT_AUDIO,
  RESULT_COPY,
  RESULT_DOC,
  RESULT_IMAGE,
  RESULT_SCRIPT,
  RESULT_VIDEO,
  resultDelegateTurn,
  resultImageCardTurn,
  resultTurn,
  resultWritingTurn,
  writeScript
} from '@/test/result-turn'

import { createdAt, stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '../test-utils'
import { PendingApprovalFallback } from '../tool/approval'

import { Thread } from '.'

stubThreadEnvironment()
stubThreadViewportSize()

const SESSION = 'session-result-delivery'

/** The label depends on the platform the test runs on (`pickRevealLabel`). */
const REVEAL = /在访达中显示|打开所在文件夹|在文件资源管理器中显示/

const saveGatewayFile = vi.fn(async () => ({ saved: true }))
const revealPath = vi.fn(async () => true)

function renderIn(messages: ThreadMessage[], locale: Locale = 'zh') {
  setRuntimeI18nLocale(locale)

  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <ThreadRuntime messages={messages}>
        <Thread />
        {/* Mounted beside the thread by the app shell (prompt-overlays.tsx). */}
        <PendingApprovalFallback />
      </ThreadRuntime>
    </I18nProvider>
  )
}

/** The chat's main line: everything but the process footer, which is opt-in. */
function mainLine(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement

  copy.querySelectorAll('[data-single-thread-process]').forEach(node => node.remove())

  return copy.textContent ?? ''
}

async function card(container: HTMLElement, kind: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = container.querySelector<HTMLElement>(`[data-slot="aui_result-media"][data-kind="${kind}"]`)

    expect(found).not.toBeNull()

    return found as HTMLElement
  })
}

let originalDesktop: typeof window.hermesDesktop

beforeEach(() => {
  originalDesktop = window.hermesDesktop
  saveGatewayFile.mockClear()
  revealPath.mockClear()
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { readFileDataUrl: async () => 'data:image/png;base64,AAAA', revealPath, saveGatewayFile }
  })
  setToolViewMode('product')
  $singleThreadFlag.set(true)
  $activeSessionId.set(SESSION)
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
  $previewStatusBySession.set({})
  clearDismissedToolRows()
  clearAllPrompts()
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: originalDesktop })
  $connection.set(null)
  setRuntimeI18nLocale('en')
  setToolViewMode('product')
  $singleThreadFlag.set(false)
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $toolDisclosureStates.set({})
  clearAllPrompts()
})

describe('file edits fold out of the chat', () => {
  it('leaves no card, diff, count, script or path on the main line', async () => {
    const { container } = renderIn(resultTurn())

    await screen.findByText('字幕我顺手加上。')

    const line = mainLine(container)

    expect(container.querySelector('[data-tool-row]')).toBeNull()
    expect(container.querySelector('[data-slot="file-diff-panel"]')).toBeNull()
    expect(container.querySelector('[data-slot="aui_changed-files"]')).toBeNull()

    for (const leak of [
      'burn.py',
      '文案.txt',
      'import os',
      'ffmpeg',
      '/Users/',
      '+1',
      '−1',
      '个文件有改动',
      '查看改动'
    ]) {
      expect(line).not.toContain(leak)
    }

    expect(line).toContain('做好了，这条成片你先看：')
    expect(line).toContain('拆解写成了文档：')
  })

  it('keeps each edit in the process area, one click behind 「看内容」', async () => {
    const { container } = renderIn(resultTurn())

    fireEvent.click(await screen.findByRole('button', { name: '看过程' }))

    const steps = await waitFor(() => {
      const rows = [...container.querySelectorAll<HTMLElement>('[data-process-step]')]

      expect(rows.length).toBeGreaterThan(0)

      return rows
    })

    // Folded until asked for: the step list itself names no file.
    expect(container.querySelector('[data-process-files]')).toBeNull()
    expect(steps.map(step => step.textContent).join(' ')).not.toContain('burn.py')

    const toggles = screen.getAllByRole('button', { name: '看内容' })

    expect(toggles.length).toBeGreaterThanOrEqual(2)
    toggles.forEach(toggle => fireEvent.click(toggle))

    const files = await waitFor(() => {
      const rows = [...container.querySelectorAll<HTMLElement>('[data-process-file]')]

      expect(rows).toHaveLength(3)

      return rows
    })

    const text = files.map(row => row.textContent).join('\n')

    expect(text).toContain('burn.py')
    expect(text).toContain('文案.txt')
    expect(text).toContain('caps = 12')
    expect(text).toContain('乱的根，是东西只能往里堆')
    expect(container.querySelectorAll('[data-process-file] [data-slot="file-diff-panel"]')).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: '收起内容' }).length).toBeGreaterThanOrEqual(2)
  })

  it('still shows what a write put in the file once a reload has lost its diff', async () => {
    const reloaded: ThreadMessage[] = [
      {
        id: 'reload-ask',
        role: 'user',
        content: [{ type: 'text', text: '写个脚本' }],
        attachments: [],
        createdAt,
        metadata: { custom: {} }
      } as ThreadMessage,
      {
        id: 'reload-answer',
        role: 'assistant',
        content: [writeScript({ result: { bytes_written: 120 } }), { type: 'text', text: '写好了。' }],
        status: { type: 'complete', reason: 'stop' },
        createdAt,
        metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
      } as unknown as ThreadMessage
    ]

    const { container } = renderIn(reloaded)

    fireEvent.click(await screen.findByRole('button', { name: '看过程' }))
    fireEvent.click(await screen.findByRole('button', { name: '看内容' }))

    const file = await waitFor(() => {
      const row = container.querySelector<HTMLElement>('[data-process-file]')

      expect(row).not.toBeNull()

      return row as HTMLElement
    })

    expect(file.textContent).toContain('burn.py')
    expect(file.textContent).toContain('import os')
  })

  it('finds the file inside a reloaded tool_call bridge, and a patch that names no path', async () => {
    const reloaded: ThreadMessage[] = [
      {
        id: 'bridge-answer',
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'bridge',
            toolName: 'tool_call',
            args: { name: 'write_file', arguments: { path: RESULT_COPY, content: '桥里写的文案\n' } },
            argsText: '{}',
            result: { bytes_written: 12 }
          },
          {
            type: 'tool-call',
            toolCallId: 'v4a',
            toolName: 'patch',
            args: { mode: 'patch', patch: '*** Begin Patch\n+补丁里的一行\n*** End Patch' },
            argsText: '{}',
            result: { success: true }
          },
          { type: 'text', text: '都好了。' }
        ],
        status: { type: 'complete', reason: 'stop' },
        createdAt,
        metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
      } as unknown as ThreadMessage
    ]

    const { container } = renderIn(reloaded)

    expect(container.textContent).not.toContain('桥里写的文案')

    fireEvent.click(await screen.findByRole('button', { name: '看过程' }))
    screen.getAllByRole('button', { name: '看内容' }).forEach(toggle => fireEvent.click(toggle))

    const rows = await waitFor(() => {
      const found = [...container.querySelectorAll<HTMLElement>('[data-process-file]')]

      expect(found).toHaveLength(2)

      return found
    })

    const [bridged, patched] = rows
    const fileName = (row: HTMLElement) => row.querySelector('[data-process-file-name]')?.textContent

    expect(fileName(bridged)).toBe('文案.txt')
    expect(bridged.textContent).toContain('桥里写的文案')
    // The patch has no path to name: it reads as a file, and offers nothing to save or reveal.
    expect(fileName(patched)).toBe('文件')
    expect(patched.textContent).toContain('补丁里的一行')
    expect(within(patched).queryByRole('button', { name: '下载' })).toBeNull()
  })

  it('leaves a relative path to the session that wrote it', async () => {
    const relative: ThreadMessage[] = [
      {
        id: 'relative-answer',
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'relative',
            toolName: 'write_file',
            args: { path: '文案.txt', content: '相对路径\n' },
            argsText: '{}',
            result: { bytes_written: 12 }
          },
          { type: 'text', text: '写好了。' }
        ],
        status: { type: 'complete', reason: 'stop' },
        createdAt,
        metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
      } as unknown as ThreadMessage
    ]

    $selectedStoredSessionId.set('stored-session')

    const { container } = renderIn(relative)

    fireEvent.click(await screen.findByRole('button', { name: '看过程' }))
    fireEvent.click(await screen.findByRole('button', { name: '看内容' }))

    const file = await waitFor(() => {
      const row = container.querySelector<HTMLElement>('[data-process-file]')

      expect(row).not.toBeNull()

      return row as HTMLElement
    })

    expect(within(file).queryByRole('button', { name: REVEAL })).toBeNull()

    fireEvent.click(within(file).getByRole('button', { name: '下载' }))
    await waitFor(() =>
      expect(saveGatewayFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: '文案.txt', sessionId: 'stored-session', suggestedName: '文案.txt' })
      )
    )
  })

  it('gives a failed edit no contents to open: it changed nothing', async () => {
    const failed: ThreadMessage[] = [
      {
        id: 'fail-answer',
        role: 'assistant',
        content: [
          { ...writeScript({ result: { success: false, error: 'disk full' } }), isError: true },
          { type: 'text', text: '没写成。' }
        ],
        status: { type: 'complete', reason: 'stop' },
        createdAt,
        metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
      } as unknown as ThreadMessage
    ]

    renderIn(failed)

    await screen.findByText('没写成。')
    expect(screen.queryByRole('button', { name: '看内容' })).toBeNull()
  })

  it('keeps the preview chip for a page the assistant wrote', async () => {
    const page = '/Users/me/APEX/落地页/index.html'

    const turn: ThreadMessage[] = [
      {
        id: 'page-answer',
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'write-page',
            toolName: 'write_file',
            args: { path: page, content: '<html></html>' },
            argsText: '{}',
            result: { bytes_written: 13 }
          },
          { type: 'text', text: '页面好了。' }
        ],
        status: { type: 'complete', reason: 'stop' },
        createdAt,
        metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} }
      } as unknown as ThreadMessage
    ]

    renderIn(turn)

    await screen.findByText('页面好了。')
    await waitFor(() => expect($previewStatusBySession.get()[SESSION]?.map(item => item.target)).toEqual([page]))
  })
})

describe('a delegated task', () => {
  it('keeps its goal and drops the ticker, which relays commands and paths', async () => {
    const { container } = renderIn(resultDelegateTurn())

    await screen.findByText('找好了。')

    const line = mainLine(container)

    expect(container.querySelector('[data-delegate-card]')).not.toBeNull()
    expect(line).toContain('找对标账号')
    expect(line).not.toContain('python3')
    expect(line).not.toContain('/Users/')
  })
})

describe('an approval is never folded away with its edit', () => {
  it('hangs off the activity line while a file write waits, buttons and command included', async () => {
    setApprovalRequest({
      command: 'write_file /Users/me/.apexnodes/SOUL.md',
      description: 'Write to protected agent-instruction file',
      sessionId: SESSION
    })

    const { container } = renderIn(resultWritingTurn())

    const explained = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        '[data-single-thread-activity] [data-slot="tool-approval-explained"]'
      )

      expect(found).not.toBeNull()

      return found as HTMLElement
    })

    expect(explained.textContent).toContain('APEX')
    expect(within(explained).getAllByRole('button').length).toBeGreaterThanOrEqual(2)
    // The file edit's own card is folded; the bar is not, and it shows once.
    expect(container.querySelector('[data-tool-row]')).toBeNull()
    expect(container.querySelector('[data-slot="tool-approval-fallback"]')).toBeNull()
    expect(screen.queryByText('等你确认')).not.toBeNull()
  })

  it('falls back to the floating bar when the write is no longer the running step', async () => {
    setApprovalRequest({
      command: 'write_file /Users/me/.apexnodes/SOUL.md',
      description: 'Write to protected agent-instruction file',
      sessionId: SESSION
    })

    const [ask, work] = resultWritingTurn()

    // Text after the call: the fold reads it as settled, so no step is running.
    const later = {
      ...work,
      content: [...work.content, { type: 'text', text: '等一下。' }]
    } as unknown as ThreadMessage

    const { container } = renderIn([ask, later])

    await waitFor(() => {
      expect(container.querySelector('[data-slot="tool-approval-fallback"]')).not.toBeNull()
    })
  })
})

describe('code the model writes in its reply stays in the reply', () => {
  it('shows a fenced block on the main line, next to folded file edits', async () => {
    const { container } = renderIn(resultTurn('你要的脚本：\n\n```python\nprint("你好 APEX")\n```'))

    await waitFor(() => expect(container.textContent).toContain('print("你好 APEX")'))
    expect(mainLine(container)).toContain('print("你好 APEX")')
    expect(container.querySelector('[data-tool-row]')).toBeNull()
  })
})

describe('every result card has a way to take the file away', () => {
  it.each([
    ['video', RESULT_VIDEO, '一条 15 秒的竖屏短视频 分三个镜头', '一条 15 秒的竖屏短视频 分三个镜头.mp4'],
    ['audio', RESULT_AUDIO, '配音 口播', '配音 口播.mp3'],
    ['image', RESULT_IMAGE, '收纳架封面 带字', '收纳架封面 带字.png']
  ])(
    'a %s card: short title, 下载 under that title, 在访达中显示 at the real path',
    async (kind, path, title, saved) => {
      const { container } = renderIn(resultTurn())
      const found = await card(container, kind)

      await within(found).findByText(title)
      expect(found.textContent).not.toContain('/Users/')
      expect(found.textContent).not.toContain('4a2ea035')

      fireEvent.click(within(found).getByRole('button', { name: '下载' }))
      await waitFor(() => expect(saveGatewayFile).toHaveBeenCalledTimes(1))
      expect(saveGatewayFile).toHaveBeenCalledWith(expect.objectContaining({ path, suggestedName: saved }))

      fireEvent.click(within(found).getByRole('button', { name: REVEAL }))
      await waitFor(() => expect(revealPath).toHaveBeenCalledWith(path))
    }
  )

  it('a document card keeps 下载 and 预览, saves under its short title and gains the file manager', async () => {
    const { container } = renderIn(resultTurn())
    const name = await screen.findByText('拆解报告.docx')
    const row = name.parentElement as HTMLElement

    expect(name.getAttribute('title')).toBe('拆解报告.docx')
    expect(container.innerHTML).not.toContain(`title="${RESULT_DOC}"`)

    fireEvent.click(within(row).getByRole('button', { name: '下载' }))
    await waitFor(() =>
      expect(saveGatewayFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: RESULT_DOC, suggestedName: '拆解报告.docx' })
      )
    )

    fireEvent.click(within(row).getByRole('button', { name: REVEAL }))
    await waitFor(() => expect(revealPath).toHaveBeenCalledWith(RESULT_DOC))
  })

  it('a document named after its prompt shows and saves under its short title', async () => {
    const long = '/Users/me/APEX/成片/一份_很长的_拆解报告_带着提示词_的名字_一直到_超过二十四个字符_aa11bb22.docx'
    const { container } = renderIn(resultTurn(`MEDIA:${long}`))
    const name = await screen.findByText('一份 很长的 拆解报告 带着提示词 的名字.docx')
    const row = name.parentElement as HTMLElement

    expect(container.textContent).not.toContain('aa11bb22')

    fireEvent.click(within(row).getByRole('button', { name: '下载' }))
    await waitFor(() =>
      expect(saveGatewayFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: long, suggestedName: '一份 很长的 拆解报告 带着提示词 的名字.docx' })
      )
    )
  })

  it('an image the model embeds as markdown gets the same card', async () => {
    const { container } = renderIn(resultTurn(`封面：\n\n![封面](${RESULT_IMAGE})`))
    const found = await card(container, 'image')

    expect(within(found).getByRole('button', { name: '下载' })).toBeTruthy()
  })

  it('an image_generate card has the row too, and its hover button saves the same way', async () => {
    const { container } = renderIn(resultImageCardTurn())

    const row = await waitFor(() => {
      const image = container.querySelector<HTMLImageElement>('[data-slot="aui_generated-image"] img')

      expect(image).not.toBeNull()
      fireEvent.load(image as HTMLImageElement)

      const actions = container.querySelector<HTMLElement>('[data-slot="aui_result-actions"]')

      expect(actions).not.toBeNull()

      return actions as HTMLElement
    })

    fireEvent.click(within(row).getByRole('button', { name: '下载' }))
    await waitFor(() =>
      expect(saveGatewayFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: RESULT_IMAGE, suggestedName: '收纳架封面 带字.png' })
      )
    )
  })

  it('the button on the image itself saves the file too, under the same title', async () => {
    const { container } = renderIn(resultTurn())
    const found = await card(container, 'image')

    fireEvent.click(await within(found).findByRole('button', { name: /下载图片|保存图片/ }))

    await waitFor(() =>
      expect(saveGatewayFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: RESULT_IMAGE, suggestedName: '收纳架封面 带字.png' })
      )
    )
  })

  it('an image_generate card: the button on the image saves the same way', async () => {
    const { container } = renderIn(resultImageCardTurn())

    const button = await waitFor(() => {
      const image = container.querySelector<HTMLImageElement>('[data-slot="aui_generated-image"] img')

      expect(image).not.toBeNull()
      fireEvent.load(image as HTMLImageElement)

      return within(container.querySelector('[data-slot="aui_generated-image"]') as HTMLElement).getByRole('button', {
        name: /下载图片|保存图片/
      })
    })

    fireEvent.click(button)
    await waitFor(() =>
      expect(saveGatewayFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: RESULT_IMAGE, suggestedName: '收纳架封面 带字.png' })
      )
    )
  })

  it('takes the native download off the player, and leaves the rest of its controls', async () => {
    const { container } = renderIn(resultTurn())

    const video = await waitFor(() => {
      const found = container.querySelector('video')

      expect(found).not.toBeNull()

      return found as HTMLVideoElement
    })

    const audio = container.querySelector('audio') as HTMLAudioElement

    expect(video.getAttribute('controlslist')).toBe('nodownload')
    expect(audio.getAttribute('controlslist')).toBe('nodownload')
    expect(video.hasAttribute('controls')).toBe(true)
    expect(audio.hasAttribute('controls')).toBe(true)
  })

  it('hands a link to the browser: no save dialog, no file manager', async () => {
    const link = 'https://cdn.example.com/a/%E6%88%90%E7%89%87.mp4'
    const open = vi.fn(async () => {})

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { openExternal: open, revealPath, saveGatewayFile }
    })

    const { container } = renderIn(resultTurn(`MEDIA:${link}`))
    const found = await card(container, 'video')

    expect(within(found).getByText('成片')).toBeTruthy()
    expect(within(found).queryByRole('button', { name: REVEAL })).toBeNull()

    fireEvent.click(within(found).getByRole('button', { name: '下载' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith(link))
    expect(saveGatewayFile).not.toHaveBeenCalled()
  })

  it('offers no file manager for a file on a remote gateway', async () => {
    $connection.set({ mode: 'remote', profile: 'remote-work' } as never)

    const { container } = renderIn(resultTurn())
    const found = await card(container, 'video')

    expect(within(found).getByRole('button', { name: '下载' })).toBeTruthy()
    expect(within(found).queryByRole('button', { name: REVEAL })).toBeNull()
  })

  it('says so when the file has gone, instead of opening nothing', async () => {
    revealPath.mockResolvedValueOnce(false)

    const { $notifications } = await import('@/store/notifications')
    const { container } = renderIn(resultTurn())
    const found = await card(container, 'video')

    fireEvent.click(within(found).getByRole('button', { name: REVEAL }))

    await waitFor(() =>
      expect($notifications.get().at(-1)?.message).toBe('这个文件已经不在原来的位置了，可能被移走或清理了。')
    )
  })
})

describe('the words read in the interface language', () => {
  it('English: cards and contents toggle', async () => {
    const { container } = renderIn(resultTurn(), 'en')
    const found = await card(container, 'video')

    expect(within(found).getByRole('button', { name: 'Download' })).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: 'See the process' }))
    const toggle = (await screen.findAllByRole('button', { name: 'See the contents' }))[0]

    fireEvent.click(toggle)
    expect(await screen.findByRole('button', { name: 'Hide the contents' })).toBeTruthy()
  })

  it('a nameless file titles itself by kind, in the interface language', async () => {
    const nameless = '/Users/me/.apexnodes/cache/media/media_4a2ea035.mp4'
    const zh = renderIn(resultTurn(`MEDIA:${nameless}`))

    expect(await within(await card(zh.container, 'video')).findByText('视频')).toBeTruthy()
    zh.unmount()

    const en = renderIn(resultTurn(`MEDIA:${nameless}`), 'en')

    expect(await within(await card(en.container, 'video')).findByText('Video')).toBeTruthy()
  })
})

describe('the files the process area lists are real paths', () => {
  it('passes the edit path through to the actions', async () => {
    const { container } = renderIn(resultTurn())

    fireEvent.click(await screen.findByRole('button', { name: '看过程' }))
    screen.getAllByRole('button', { name: '看内容' }).forEach(toggle => fireEvent.click(toggle))

    const copyFile = await waitFor(() => {
      const row = [...container.querySelectorAll<HTMLElement>('[data-process-file]')].find(item =>
        item.textContent?.includes('文案.txt')
      )

      expect(row).toBeTruthy()

      return row as HTMLElement
    })

    fireEvent.click(within(copyFile).getByRole('button', { name: REVEAL }))
    await waitFor(() => expect(revealPath).toHaveBeenCalledWith(RESULT_COPY))
    expect(revealPath).not.toHaveBeenCalledWith(RESULT_SCRIPT)
  })
})
