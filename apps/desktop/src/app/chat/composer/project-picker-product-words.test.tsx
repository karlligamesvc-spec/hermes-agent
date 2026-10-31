import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'
import { $recentProjects } from '@/store/recent-projects'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { useFolderPickerWords } from '../../single-thread/product-words'

import { ProjectPicker } from './project-picker'

/**
 * hc-1123: in product mode the composer chip is a folder picker in every word it
 * shows. It does what it did. The switch off and developer mode are pinned in
 * src/fold-projects-copy-identity.test.tsx.
 */

const notifyError = vi.hoisted(() => vi.fn())

vi.mock('@/store/notifications', async importOriginal => ({ ...(await importOriginal<object>()), notifyError }))

vi.stubGlobal(
  'ResizeObserver',
  class {
    disconnect() {}
    observe() {}
    unobserve() {}
  }
)

Element.prototype.scrollIntoView = () => {}

const PROJECT_WORD = /项目|專案|project|プロジェクト|مشروع|مشاريع/i
const LOCALES: readonly Locale[] = ['ar', 'en', 'ja', 'zh', 'zh-hant']
const selectPaths = vi.fn()
const createProjectDir = vi.fn()
const onChangeCwd = vi.fn()

function renderPicker(locale: Locale = 'zh') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <ProjectPicker cwd={null} onChangeCwd={onChangeCwd} />
    </I18nProvider>
  )
}

async function openPicker() {
  fireEvent.click(screen.getByRole('button'))
  await screen.findByRole('dialog')
}

/** Everything a person can read or hear from it, attributes included. */
const allWords = () =>
  [
    document.body.textContent ?? '',
    ...[...document.body.querySelectorAll('*')].flatMap(node =>
      ['aria-label', 'placeholder', 'title'].map(name => node.getAttribute(name) ?? '')
    )
  ].join('\n')

beforeEach(() => {
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  selectPaths.mockReset()
  createProjectDir.mockReset()
  onChangeCwd.mockReset()
  notifyError.mockReset()
  $recentProjects.set([{ lastUsedAt: 1, name: 'campaign', path: '/Users/fixture/work/campaign' }])
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { createProjectDir, selectPaths } })
})

afterEach(async () => {
  cleanup()
  await new Promise(resolve => setTimeout(resolve, 0))
  setSingleThreadFlagForTest(false)
  $recentProjects.set([])
})

describe('hc-1123 the composer chip in product mode', () => {
  it.each(LOCALES)('has no word for a project in any string (%s)', locale => {
    const { result } = renderHook(() => useFolderPickerWords(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <I18nProvider configClient={null} initialLocale={locale}>
          {children}
        </I18nProvider>
      )
    })

    expect(Object.entries(result.current).filter(([, word]) => PROJECT_WORD.test(word))).toEqual([])
  })

  it('reads 选择文件夹 on the chip, its tooltip and its accessible name', () => {
    renderPicker()

    const chip = screen.getByRole('button', { name: '文件夹' })

    expect(chip.textContent).toBe('选择文件夹')
    expect(chip.getAttribute('title')).toBe('选择文件夹')
  })

  it('reads Choose folder in English', () => {
    renderPicker('en')

    const chip = screen.getByRole('button', { name: 'Folder' })

    expect(chip.textContent).toBe('Choose folder')
    expect(chip.getAttribute('title')).toBe('Choose folder')
  })

  it.each([
    ['zh', '搜索文件夹…', '最近用过的文件夹', '还没有用过的文件夹'],
    ['en', 'Search folders…', 'Recent folders', 'No folders yet']
  ] as const)('words the list as folders (%s)', async (locale, placeholder, heading, empty) => {
    renderPicker(locale)
    await openPicker()

    expect(screen.getByPlaceholderText(placeholder)).toBeTruthy()
    expect(screen.getByText(heading)).toBeTruthy()
    expect(allWords()).not.toMatch(PROJECT_WORD)
    cleanup()

    $recentProjects.set([])
    renderPicker(locale)
    await openPicker()

    expect(screen.getByText(empty)).toBeTruthy()
    expect(allWords()).not.toMatch(PROJECT_WORD)
  })

  it('finds nothing with the folder wording when the search matches nothing', async () => {
    renderPicker()
    await openPicker()
    fireEvent.change(screen.getByPlaceholderText('搜索文件夹…'), { target: { value: 'zzz' } })

    expect(await screen.findByText('没有匹配的文件夹')).toBeTruthy()
  })

  it.each([
    ['zh', '新建空白文件夹…', '新建文件夹', '文件夹名称', '选择上级文件夹…'],
    ['en', 'New blank folder…', 'New folder', 'Folder name', 'Choose parent folder…']
  ] as const)('words the form for a new folder (%s)', async (locale, entry, title, placeholder, parent) => {
    renderPicker(locale)
    await openPicker()
    fireEvent.click(screen.getByText(entry))

    expect(await screen.findByText(title)).toBeTruthy()
    expect(screen.getByPlaceholderText(placeholder)).toBeTruthy()
    expect(screen.getByText(parent)).toBeTruthy()
    expect(allWords()).not.toMatch(PROJECT_WORD)
  })

  it('titles the system dialogs as folders, and still binds what is picked', async () => {
    selectPaths.mockResolvedValue(['/Users/fixture/work/picked'])
    renderPicker()
    await openPicker()
    fireEvent.click(screen.getByText('使用现有文件夹…'))

    await waitFor(() => expect(onChangeCwd).toHaveBeenCalledWith('/Users/fixture/work/picked'))
    expect(selectPaths.mock.lastCall?.[0]).toMatchObject({ title: '选择文件夹' })
    cleanup()

    selectPaths.mockResolvedValue([])
    renderPicker()
    await openPicker()
    fireEvent.click(screen.getByText('新建空白文件夹…'))
    fireEvent.click(await screen.findByText('选择上级文件夹…'))

    await waitFor(() => expect(selectPaths.mock.lastCall?.[0]).toMatchObject({ title: '选择新文件夹放在哪里' }))
  })

  it('still binds a recent folder and still creates a new one, and says so as folders when that fails', async () => {
    renderPicker()
    await openPicker()
    fireEvent.click(screen.getByText('campaign'))

    await waitFor(() => expect(onChangeCwd).toHaveBeenCalledWith('/Users/fixture/work/campaign'))
    cleanup()

    selectPaths.mockResolvedValue(['/Users/fixture/work'])
    createProjectDir.mockResolvedValue({ error: '', ok: false })
    renderPicker()
    await openPicker()
    fireEvent.click(screen.getByText('新建空白文件夹…'))
    fireEvent.click(await screen.findByText('选择上级文件夹…'))
    await screen.findByText('/Users/fixture/work')
    fireEvent.change(screen.getByPlaceholderText('文件夹名称'), { target: { value: 'next' } })
    await act(async () => {
      fireEvent.keyDown(screen.getByPlaceholderText('文件夹名称'), { key: 'Enter' })
    })

    await waitFor(() => expect(createProjectDir).toHaveBeenCalledWith('/Users/fixture/work', 'next'))
    await waitFor(() => expect(notifyError.mock.lastCall?.[1]).toBe('无法创建文件夹'))
  })
})
