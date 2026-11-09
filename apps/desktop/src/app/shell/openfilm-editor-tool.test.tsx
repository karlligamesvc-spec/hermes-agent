// @vitest-environment jsdom
/**
 * hc-1201: the titlebar's 剪辑 beside 打开设置 (openfilm-editor-tool.tsx). Only while the editor is open to this
 * account; it says 打开剪辑, or 隐藏剪辑 while the editor shows; the first time, its popover lists the check of
 * this computer and how far the install is. No word of the editor's upstream name reaches the person.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { atom } from 'nanostores'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as TreeStore from '@/components/pane-shell/tree/store'
import { I18nProvider } from '@/i18n'
import { OPENFILM_STUDIO_COPY } from '@/i18n/openfilm-studio'
import type { Locale } from '@/i18n/types'
import { $openfilmSetup, closeOpenfilmSetup, type OpenfilmSetup } from '@/lib/openfilm-editor-entry'
import { $openfilmStudioOn, OPENFILM_STUDIO_TAB_ID } from '@/lib/openfilm-studio'
import { $previewTabs, closeRightRail } from '@/store/preview'
import { stubResizeObserver } from '@/test/jsdom'

import { formatSize, OpenfilmSetupBody } from './openfilm-editor-tool'
import { TitlebarControls } from './titlebar-controls'

const { visible } = vi.hoisted(() => ({ visible: { pane: null as null | ReturnType<typeof atom<boolean>> } }))

vi.mock('@/components/pane-shell/tree/store', async importOriginal => {
  const actual = await importOriginal<typeof TreeStore>()

  return {
    ...actual,
    $paneVisible: (paneId: string) => {
      if (paneId !== `preview-tile:${OPENFILM_STUDIO_TAB_ID}`) {
        return actual.$paneVisible(paneId)
      }

      visible.pane ??= atom(false)

      return visible.pane
    }
  }
})

type Bridge = NonNullable<Window['hermesDesktop']['openfilmStudio']>

function renderTitlebar(locale: Locale = 'zh') {
  return render(
    <MemoryRouter initialEntries={['/chat-a']}>
      <I18nProvider configClient={null} initialLocale={locale}>
        <TitlebarControls onOpenSettings={() => {}} />
      </I18nProvider>
    </MemoryRouter>
  )
}

const rightCluster = () => screen.getByLabelText('应用控件')

describe('the 剪辑 switch in the titlebar', () => {
  const original = window.hermesDesktop

  beforeEach(() => {
    stubResizeObserver()
    visible.pane ??= atom(false)
    visible.pane.set(false)
    closeRightRail()
  })

  afterEach(() => {
    cleanup()
    act(() => {
      closeOpenfilmSetup()
      $openfilmStudioOn.set(false)
    })
    closeRightRail()
    window.hermesDesktop = original
    vi.unstubAllGlobals()
  })

  it('is not there while the editor is not open to this account', () => {
    renderTitlebar()

    expect(screen.queryByLabelText('打开剪辑')).toBeNull()
    expect(within(rightCluster()).getByLabelText('打开设置')).toBeTruthy()
  })

  it('sits right before 打开设置 when it is', () => {
    $openfilmStudioOn.set(true)
    renderTitlebar()

    const labels = within(rightCluster())
      .getAllByRole('button')
      .map(button => button.getAttribute('aria-label'))

    expect(labels.slice(0, 2)).toEqual(['打开剪辑', '打开设置'])
  })

  it('says 隐藏剪辑 while the editor shows, and hides it', () => {
    $openfilmStudioOn.set(true)
    visible.pane?.set(true)
    $previewTabs.set([{ id: OPENFILM_STUDIO_TAB_ID, target: { kind: 'url', label: 'cook', source: 's', url: 'http://x' } }])
    renderTitlebar()

    const button = screen.getByLabelText('隐藏剪辑')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)

    expect($previewTabs.get().some(tab => tab.id === OPENFILM_STUDIO_TAB_ID)).toBe(false)
  })

  it('the first time, its popover checks this computer and shows the install as it goes', async () => {
    $openfilmStudioOn.set(true)

    const bridge = {
      check: vi.fn(async () => ({
        browser: { ready: true, bytes: 190_970_181 },
        toolkit: { ready: false, bytes: 41_612_524 },
        disk: { free: 120e9, needed: 4e8 }
      })),
      lastProject: vi.fn(async () => null),
      open: vi.fn(),
      prefetch: vi.fn(async () => 'started' as const),
      progress: vi.fn(async () => ({ failed: false, progress: null })),
      status: vi.fn(async () => ({ on: true, ready: false, preparing: true }))
    } as unknown as Bridge

    window.hermesDesktop = { ...(window.hermesDesktop ?? {}), openfilmStudio: bridge } as Window['hermesDesktop']
    renderTitlebar()

    fireEvent.click(screen.getByLabelText('打开剪辑'))

    const popover = await screen.findByTestId('openfilm-editor-setup')
    await waitFor(() => expect(popover.textContent).toContain('剪辑编辑器 · 等待下载'))
    expect(popover.textContent).toContain('第一次使用剪辑，先检查一下环境')
    expect(popover.textContent).toContain('账号可以使用剪辑')
    expect(popover.textContent).toContain('磁盘空间够用（还剩 120.0 GB）')
    expect(popover.textContent).toContain('出片用的渲染组件 · 已就绪')
    expect(bridge.prefetch).toHaveBeenCalledWith(true)

    // A second click closes it.
    fireEvent.click(screen.getByLabelText('打开剪辑'))
    await waitFor(() => expect(screen.queryByTestId('openfilm-editor-setup')).toBeNull())
  })
})

const CHECK = {
  browser: { ready: false, bytes: 190_970_181 },
  toolkit: { ready: false, bytes: 41_612_524 },
  disk: { free: 120e9, needed: 9.5e8 }
}

describe('what the popover says', () => {
  afterEach(() => cleanup())

  const say = (setup: OpenfilmSetup, locale: Locale = 'zh') =>
    render(<OpenfilmSetupBody copy={OPENFILM_STUDIO_COPY[locale].setup} setup={setup} />).container

  it.each<[string, OpenfilmSetup, string[]]>([
    ['checking', { phase: 'checking' }, ['第一次使用剪辑，先检查一下环境', '正在检查…']],
    [
      'the browser downloading',
      { phase: 'preparing', check: CHECK, progress: { step: 'browser', done: 95_000_000, total: 190_970_181 } },
      ['出片用的渲染组件 · 下载中 95.0 MB / 191.0 MB', '剪辑编辑器 · 等待下载']
    ],
    [
      'the browser in, the editor downloading',
      { phase: 'preparing', check: CHECK, progress: { step: 'toolkit', done: 10_000_000, total: 41_612_524 } },
      ['出片用的渲染组件 · 已就绪', '剪辑编辑器 · 下载中 10.0 MB / 41.6 MB']
    ],
    [
      'the editor downloaded, being installed',
      { phase: 'preparing', check: CHECK, progress: { step: 'toolkit', done: 41_612_524, total: 41_612_524 } },
      ['剪辑编辑器 · 正在安装']
    ],
    [
      'not enough disk',
      { phase: 'disk', check: { ...CHECK, disk: { free: 300e6, needed: 9.5e8 } } },
      ['磁盘空间不够：还剩 300.0 MB，需要 950.0 MB', '空出一些磁盘空间后，再检查一次。', '重新检查']
    ],
    ['a failed install', { phase: 'failed', check: CHECK }, ['下载没有完成，可能是网络不稳定。', '重试']],
    ['nothing to open', { phase: 'empty' }, ['还没有可以剪的工程。让助手做一条短视频，就会生成可以在这里改的工程。']]
  ])('%s', (_label, setup, lines) => {
    const text = say(setup).textContent ?? ''

    for (const line of lines) {
      expect(text).toContain(line)
    }
  })

  it('shows a bar while a download runs, and none once it is in', () => {
    const running = say({ phase: 'preparing', check: CHECK, progress: { step: 'toolkit', done: 1, total: 4 } })
    expect(running.querySelector('[role="progressbar"]')).not.toBeNull()
    cleanup()
    const done = say({ phase: 'preparing', check: CHECK, progress: { step: 'toolkit', done: 4, total: 4 } })
    expect(done.querySelector('[role="progressbar"]')).toBeNull()
  })

  it.each<Locale>(['zh', 'zh-hant', 'en'])('%s: every phase, and never the editor’s upstream name', locale => {
    const phases: OpenfilmSetup[] = [
      { phase: 'checking' },
      { phase: 'preparing', check: CHECK, progress: { step: 'browser', done: 1, total: 2 } },
      { phase: 'disk', check: CHECK },
      { phase: 'failed', check: null },
      { phase: 'empty' }
    ]

    for (const setup of phases) {
      const text = say(setup, locale).textContent ?? ''
      expect(text.trim()).not.toBe('')
      expect(text).not.toMatch(/openfilm|studio/i)
      cleanup()
    }

    const copy = OPENFILM_STUDIO_COPY[locale]
    expect(`${copy.openEditor} ${copy.hideEditor} ${copy.tab}`).not.toMatch(/openfilm|studio/i)
  })
})

describe('sizes', () => {
  it.each<[number, string]>([
    [41_612_524, '41.6 MB'],
    [190_970_181, '191.0 MB'],
    [1_200_000_000, '1.2 GB'],
    [0, '0.1 MB']
  ])('%d bytes read %s', (bytes, text) => {
    expect(formatSize(bytes)).toBe(text)
  })
})

describe('the switch’s popover state is the module’s', () => {
  it('starts closed', () => {
    expect($openfilmSetup.get()).toBeNull()
  })
})
