/**
 * hc-1189: a verbatim-transcript .docx named after a long Chinese video title opens in
 * the preview with its whole path, on the real transcript in product mode.
 *
 * liusession 10-08 ran Desktop 0.17.52. Its two transcript files were named after their
 * titles (about 60 characters, spaces, `!`, full-width `！` and `，`). The assistant blamed
 * the failed preview on the long Chinese name with no evidence. 0.17.52 cut a standalone
 * MEDIA path at its first space (fixed in 0.17.53, fork #378) and had no Word body preview
 * at all (added in 0.17.54, fork #379). This pins the current behaviour on those exact
 * names, plus the title characters a Douyin title can carry that a URL or Markdown link
 * would read specially (`#` hashtags, `?`, `%`, an unbalanced `(` left by the 60-character
 * cut): the card saves and previews the exact file, and the preview shows the body.
 */
import { type ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LocalFilePreview } from '@/app/chat/right-rail/preview-file'
import { ReturnedItems } from '@/app/single-thread/handoff/cards'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { replyAttachments } from '@/lib/handoff-text'
import { mediaMarkdownHref, mediaPathFromMarkdownHref } from '@/lib/media'
import { previewMarkdownHref, previewTargetFromMarkdownHref } from '@/lib/preview-targets'
import { $previewTabs, $previewTarget } from '@/store/preview'
import { $previewStatusBySession } from '@/store/preview-status'
import { clearAllPrompts } from '@/store/prompts'
import { $activeSessionId, $gatewayState } from '@/store/session'
import { $singleThreadFlag } from '@/store/single-thread'
import { clearDismissedToolRows } from '@/store/tool-dismiss'
import { $toolDisclosureStates, setToolViewMode } from '@/store/tool-view'
import { resultTurn } from '@/test/result-turn'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '../test-utils'

import { Thread } from '.'

const { readData } = vi.hoisted(() => ({ readData: vi.fn() }))

vi.mock('@/lib/desktop-fs', async importOriginal => ({
  ...(await importOriginal<object>()),
  readDesktopFileDataUrl: readData
}))

stubThreadEnvironment()
stubThreadViewportSize()

const DOCS = '/Users/liuxinli/.apexnodes/cache/documents'

// The two files of liusession 10-08, byte for byte.
const INCIDENT_A = `${DOCS}/高三必看逆袭方法 高三考生如何正确看待模块？我们跟踪大量往届高三生，发现逆袭规律：提分不是疯狂刷题，学会运用错题，定能事_逐字稿_600fb131.docx`
const INCIDENT_B = `${DOCS}/27高考报名早准备! 陕西27届高考生家长注意了！陕西高考报名通常从11月1号开始，但材料需要提前准备，这6 大关键事项_逐字稿_7119593c.docx`

const NAMES: [string, string][] = [
  ['incident A', INCIDENT_A],
  ['incident B', INCIDENT_B],
  ['hashtags', `${DOCS}/家常菜做法 #家常菜 #快手菜 #下饭菜_逐字稿_1a2b3c4d.docx`],
  ['question mark and percent', `${DOCS}/涨了50%? 真的假的_逐字稿_5e6f7a8b.docx`],
  ['unbalanced parenthesis', `${DOCS}/实测三款咖啡机(上_逐字稿_9c0d1e2f.docx`]
]

const BODY =
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  '<w:p><w:r><w:t>陕西的高三家长注意了。</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>国庆假期结束后，高考报名即将启动。</w:t></w:r></w:p></w:body></w:document>'

const DOCX = `data:application/octet-stream;base64,${Buffer.from(zipSync({ 'word/document.xml': strToU8(BODY) })).toString('base64')}`

const saveGatewayFile = vi.fn(async () => ({ saved: true }))

function renderTurn(messages: ThreadMessage[]) {
  setRuntimeI18nLocale('zh')

  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ThreadRuntime messages={messages}>
        <Thread />
      </ThreadRuntime>
    </I18nProvider>
  )
}

let originalDesktop: typeof window.hermesDesktop

beforeEach(() => {
  originalDesktop = window.hermesDesktop
  saveGatewayFile.mockClear()
  readData.mockReset()
  readData.mockResolvedValue(DOCX)
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { readFileDataUrl: async () => DOCX, revealPath: vi.fn(async () => true), saveGatewayFile }
  })
  setToolViewMode('product')
  $singleThreadFlag.set(true)
  $activeSessionId.set('session-hc1189')
  $gatewayState.set('open')
  $toolDisclosureStates.set({})
  $previewStatusBySession.set({})
  $previewTabs.set([])
  clearDismissedToolRows()
  clearAllPrompts()
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: originalDesktop })
  setRuntimeI18nLocale('en')
  $singleThreadFlag.set(false)
  $activeSessionId.set(null)
  $previewTabs.set([])
  clearAllPrompts()
})

describe('a transcript .docx named after its title', () => {
  it.each(NAMES)('%s: the card saves and previews the exact file, and the preview shows the body', async (_label, path) => {
    const { container } = renderTurn(resultTurn(`第二条视频转写完成，逐字稿已生成：\n\nMEDIA:${path}\n\n如果文档打不开，回我一声。`))

    const save = await waitFor(() => {
      const buttons = within(container).getAllByRole('button', { name: '下载' })

      expect(buttons).toHaveLength(1)

      return buttons[0]!
    })

    const row = save.parentElement as HTMLElement

    fireEvent.click(save)
    await waitFor(() => expect(saveGatewayFile).toHaveBeenCalledWith(expect.objectContaining({ path })))

    fireEvent.click(within(row.parentElement as HTMLElement).getByRole('button', { name: /预览/ }))
    await waitFor(() => expect($previewTarget.get()?.path).toBe(path))

    cleanup()
    render(
      <I18nProvider configClient={null} initialLocale="zh">
        <LocalFilePreview reloadKey={0} target={$previewTarget.get()!} />
      </I18nProvider>
    )
    await screen.findByText('陕西的高三家长注意了。')
    expect(readData).toHaveBeenCalledWith(path)
  })
})

describe('every hash href a file travels in', () => {
  const path = NAMES.at(-1)![1]

  it.each([
    ['#media:', mediaMarkdownHref(path), mediaPathFromMarkdownHref],
    ['#preview/', previewMarkdownHref(path), previewTargetFromMarkdownHref]
  ])('%s carries no bare parenthesis and decodes back to the path', (_label, href, decode) => {
    expect(href).not.toMatch(/[()]/)
    expect(decode(href)).toBe(path)
  })

  it('a relay carries back the whole path of a standalone tag, and inline tags still end at a space', () => {
    const reply = `逐字稿已生成：\nMEDIA:${INCIDENT_B}\n音频：MEDIA:/tmp/voice.mp3 和 MEDIA:/tmp/b.mp3\n`

    expect(replyAttachments(reply).files).toEqual([INCIDENT_B, '/tmp/voice.mp3', '/tmp/b.mp3'])
  })

  it('a file a relay hands back gets its card', async () => {
    const { container } = render(
      <I18nProvider configClient={null} initialLocale="zh">
        <ReturnedItems files={[path]} links={[]} />
      </I18nProvider>
    )

    fireEvent.click(await within(container).findByRole('button', { name: '下载' }))
    await waitFor(() => expect(saveGatewayFile).toHaveBeenCalledWith(expect.objectContaining({ path })))
  })
})
