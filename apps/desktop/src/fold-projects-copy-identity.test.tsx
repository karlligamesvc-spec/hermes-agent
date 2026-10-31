// First, before any app module: the zone the shell goldens are recorded in.
import './__identity__/single-thread-shell/time-zone'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DeliverableDetailView } from '@/app/business-workspace/pages/deliverable-detail-page'
import { DeliverablesView } from '@/app/business-workspace/pages/deliverables-page'
import { ProjectPicker } from '@/app/chat/composer/project-picker'
import { I18nProvider, type Locale } from '@/i18n'
import { $recentProjects } from '@/store/recent-projects'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { bodyHtml, seedSignedIn } from './__identity__/fold-projects/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1123 identity guard (hard rule 11): the composer's folder picker and the
 * 交付物 pages, whose wording changes in product mode only. With the switch off
 * and in developer mode they are byte-identical to the goldens in
 * `__identity__/fold-projects/`, recorded on fork main d3d2199cab before any of
 * that wording changed. A diff means the off path moved: fix the code.
 */

const hooks = vi.hoisted(() => ({ detail: vi.fn(), list: vi.fn(), notifyError: vi.fn() }))

vi.mock('@/app/business-workspace/hooks/use-workflow-deliverables', () => ({
  useWorkflowDeliverable: hooks.detail,
  useWorkflowDeliverables: hooks.list
}))
vi.mock('@/store/notifications', async importOriginal => ({
  ...(await importOriginal<object>()),
  notifyError: hooks.notifyError
}))

// cmdk, inside the picker's popover, measures its list.
vi.stubGlobal(
  'ResizeObserver',
  class {
    disconnect() {}
    observe() {}
    unobserve() {}
  }
)
Element.prototype.scrollIntoView = () => {}

const ISO = '2026-10-20T00:00:00Z'

const DELIVERABLE = {
  createdAt: ISO,
  evidence: [],
  executorType: 'hermes',
  executorVersion: null,
  id: 'deliverable-1',
  kind: 'report',
  payload: { highlights: ['需求增长'], summary: '本周的结论' },
  projectId: 'project-1',
  reviews: [],
  runId: 'run-1',
  schemaVersion: '1',
  sourceCapturedAt: null,
  status: 'ready',
  storageTarget: null,
  title: '本周报告',
  updatedAt: ISO,
  verifierResult: null
}

const DETAIL = {
  item: DELIVERABLE,
  project: { id: 'project-1', name: '品牌周报' },
  run: { id: 'run-1' },
  workflow: { id: 'workflow-1', name: '竞品监控' }
}

function shell(children: ReactNode, path: string, locale: Locale) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider configClient={null} initialLocale={locale}>
        {children}
      </I18nProvider>
    </MemoryRouter>
  )
}

const LABELS = {
  en: { create: 'New blank project…', existing: 'Open existing folder…', parent: 'Choose parent folder…' },
  zh: { create: '新建空白项目…', existing: '使用现有文件夹…', parent: '选择上级文件夹…' }
} as const

const selectPaths = vi.fn()
const createProjectDir = vi.fn()

function renderPicker(locale: Locale, cwd: null | string = null) {
  return shell(<ProjectPicker cwd={cwd} onChangeCwd={vi.fn()} />, '/', locale)
}

async function openPicker() {
  fireEvent.click(screen.getByRole('button'))
  await screen.findByRole('dialog')
}

beforeEach(() => {
  seedSignedIn()
  selectPaths.mockReset()
  createProjectDir.mockReset()
  hooks.notifyError.mockReset()
  hooks.detail.mockReturnValue({ detail: DETAIL, mode: 'ready' })
  hooks.list.mockReturnValue({
    loadMore: vi.fn(),
    refresh: vi.fn(),
    state: { items: [DELIVERABLE], mode: 'ready' }
  })
  $recentProjects.set([{ lastUsed: 1, name: 'campaign', path: '/Users/fixture/work/campaign' }])
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { createProjectDir, selectPaths } })
})

afterEach(async () => {
  cleanup()
  await new Promise(resolve => setTimeout(resolve, 0))
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  $recentProjects.set([])
})

afterAll(restoreRecordingTimeZone)

describe.each([
  ['the switch off', false, 'product'],
  ['developer mode with the switch on', true, 'technical']
] as const)('hc-1123 %s: byte-identical to main', (_label, flag, toolView) => {
  beforeEach(() => {
    setSingleThreadFlagForTest(flag)
    setToolViewMode(toolView)
  })

  describe.each(['zh', 'en'] as const)('the folder picker (%s)', locale => {
    const golden = (name: string) => `./__identity__/fold-projects/picker-${name}.${locale}.html`

    it('renders the chip', async () => {
      renderPicker(locale)

      await expect(bodyHtml()).toMatchFileSnapshot(golden('chip'))
    })

    it('renders the list, with a recent folder and with none', async () => {
      renderPicker(locale)
      await openPicker()

      await expect(bodyHtml()).toMatchFileSnapshot(golden('list'))
      cleanup()

      $recentProjects.set([])
      renderPicker(locale)
      await openPicker()

      await expect(bodyHtml()).toMatchFileSnapshot(golden('list-empty'))
    })

    it('renders the form for a new one', async () => {
      renderPicker(locale)
      await openPicker()
      fireEvent.click(screen.getByText(LABELS[locale].create))
      await screen.findByText(LABELS[locale].parent)

      await expect(bodyHtml()).toMatchFileSnapshot(golden('create'))
    })

    it('titles the native dialogs and words the failures the way main does', async () => {
      const out: Record<string, unknown> = {}

      selectPaths.mockResolvedValue([])
      renderPicker(locale)
      await openPicker()
      fireEvent.click(screen.getByText(LABELS[locale].existing))
      await waitFor(() => expect(selectPaths).toHaveBeenCalledTimes(1))
      out.existingTitle = (selectPaths.mock.lastCall?.[0] as { title: string }).title
      cleanup()

      renderPicker(locale)
      await openPicker()
      fireEvent.click(screen.getByText(LABELS[locale].create))
      fireEvent.click(await screen.findByText(LABELS[locale].parent))
      await waitFor(() => expect(selectPaths).toHaveBeenCalledTimes(2))
      out.parentTitle = (selectPaths.mock.lastCall?.[0] as { title: string }).title
      cleanup()

      selectPaths.mockRejectedValue(new Error('dialog failed'))
      renderPicker(locale)
      await openPicker()
      fireEvent.click(screen.getByText(LABELS[locale].existing))
      await waitFor(() => expect(hooks.notifyError).toHaveBeenCalledTimes(1))
      out.pickFailed = hooks.notifyError.mock.lastCall?.[1]
      cleanup()

      selectPaths.mockResolvedValue(['/Users/fixture/work'])
      createProjectDir.mockResolvedValue({ error: '', ok: false })
      renderPicker(locale)
      await openPicker()
      fireEvent.click(screen.getByText(LABELS[locale].create))
      fireEvent.click(await screen.findByText(LABELS[locale].parent))
      await screen.findByText('/Users/fixture/work')
      fireEvent.change(document.querySelector('input')!, { target: { value: 'next' } })
      await act(async () => {
        fireEvent.keyDown(document.querySelector('input')!, { key: 'Enter' })
      })
      await waitFor(() => expect(hooks.notifyError).toHaveBeenCalledTimes(2))
      out.createFailed = hooks.notifyError.mock.lastCall?.[1]

      await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(golden('words').replace('.html', '.json'))
    })
  })

  describe.each(['zh', 'en'] as const)('交付物 (%s)', locale => {
    const golden = (name: string) => `./__identity__/fold-projects/deliverables-${name}.${locale}.html`

    it('renders the list', async () => {
      shell(<DeliverablesView />, '/deliverables', locale)

      await expect(bodyHtml()).toMatchFileSnapshot(golden('list'))
    })

    it('renders it empty', async () => {
      hooks.list.mockReturnValue({ loadMore: vi.fn(), refresh: vi.fn(), state: { items: [], mode: 'ready' } })
      shell(<DeliverablesView />, '/deliverables', locale)

      await expect(bodyHtml()).toMatchFileSnapshot(golden('empty'))
    })

    it.each(['unavailable', 'failed'])('renders a %s read', async mode => {
      hooks.list.mockReturnValue({ loadMore: vi.fn(), refresh: vi.fn(), state: { mode } })
      shell(<DeliverablesView />, '/deliverables', locale)

      await expect(bodyHtml()).toMatchFileSnapshot(golden(mode))
    })

    it('renders one deliverable, with its 所属项目', async () => {
      shell(
        <Routes>
          <Route element={<DeliverableDetailView />} path="/deliverables/:deliverableId" />
        </Routes>,
        '/deliverables/deliverable-1',
        locale
      )

      await expect(bodyHtml()).toMatchFileSnapshot(golden('detail'))
    })
  })
})
