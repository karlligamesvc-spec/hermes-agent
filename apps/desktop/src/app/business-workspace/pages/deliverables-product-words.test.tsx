import { cleanup, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { useDeliverablesWords } from '../../single-thread/product-words'

import { DeliverableDetailView } from './deliverable-detail-page'
import { DeliverablesView } from './deliverables-page'

/**
 * hc-1123: in product mode the 交付物 pages have no 项目 and no Hermes. The switch
 * off and developer mode are pinned in src/fold-projects-copy-identity.test.tsx.
 */

const hooks = vi.hoisted(() => ({ detail: vi.fn(), list: vi.fn() }))

vi.mock('../hooks/use-workflow-deliverables', () => ({
  useWorkflowDeliverable: hooks.detail,
  useWorkflowDeliverables: hooks.list
}))

const FOLDED_WORD = /项目|專案|project|プロジェクト|مشروع|مشاريع|hermes/i
const LOCALES: readonly Locale[] = ['ar', 'en', 'ja', 'zh', 'zh-hant']
const ISO = '2026-10-20T00:00:00Z'

const ITEM = {
  createdAt: ISO,
  evidence: [],
  executorType: 'hermes',
  executorVersion: null,
  id: 'deliverable-1',
  kind: 'report',
  payload: { summary: '本周的结论' },
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

const wrap = (children: ReactNode, path: string, locale: Locale) => (
  <MemoryRouter initialEntries={[path]}>
    <I18nProvider configClient={null} initialLocale={locale}>
      {children}
    </I18nProvider>
  </MemoryRouter>
)

function renderList(locale: Locale = 'zh') {
  return render(wrap(<DeliverablesView />, '/deliverables', locale))
}

function renderDetail(locale: Locale = 'zh') {
  return render(
    wrap(
      <Routes>
        <Route element={<DeliverableDetailView />} path="/deliverables/:deliverableId" />
      </Routes>,
      '/deliverables/deliverable-1',
      locale
    )
  )
}

const listState = (state: unknown) => ({ loadMore: vi.fn(), refresh: vi.fn(), state })

beforeEach(() => {
  setSingleThreadFlagForTest(true)
  setToolViewMode('product')
  hooks.list.mockReturnValue(listState({ items: [ITEM], mode: 'ready' }))
  hooks.detail.mockReturnValue({
    detail: {
      item: ITEM,
      project: { id: 'project-1', name: '品牌周报' },
      run: { id: 'run-1' },
      workflow: { id: 'workflow-1', name: '竞品监控' }
    },
    mode: 'ready'
  })
})

afterEach(async () => {
  cleanup()
  await new Promise(resolve => setTimeout(resolve, 0))
  setSingleThreadFlagForTest(false)
})

describe('hc-1123 交付物 in product mode', () => {
  it.each(LOCALES)('no string on the pages names 项目 or Hermes but the one row that is gone (%s)', locale => {
    const { result } = renderHook(() => useDeliverablesWords(), {
      wrapper: ({ children }: { children: ReactNode }) => wrap(children, '/', locale)
    })

    const left = Object.entries(result.current).filter(
      ([key, word]) => key !== 'project' && typeof word === 'string' && FOLDED_WORD.test(word)
    )

    expect(left).toEqual([])
  })

  it.each([
    ['zh', '查看、验证并确认 APEX 做好的成果。'],
    ['en', 'Review, verify, and approve what APEX has made.']
  ] as const)('describes the list with no 项目 or Hermes (%s)', (locale, description) => {
    const { container } = renderList(locale)

    expect(screen.getByText(description)).toBeTruthy()
    expect(container.textContent).not.toMatch(FOLDED_WORD)
  })

  it.each([
    ['zh', 'APEX 做好的成果会出现在这里。'],
    ['en', 'What APEX makes will show up here.']
  ] as const)('says the same when it is empty (%s)', (locale, empty) => {
    hooks.list.mockReturnValue(listState({ items: [], mode: 'ready' }))

    const { container } = renderList(locale)

    expect(screen.getByText(empty)).toBeTruthy()
    expect(container.textContent).not.toMatch(FOLDED_WORD)
  })

  it.each([
    ['zh', '所属项目', '工作流', '关联运行'],
    ['en', 'Project', 'Workflow', 'Related run']
  ] as const)('drops the 所属项目 row from a deliverable and keeps the rest (%s)', (locale, project, workflow, run) => {
    renderDetail(locale)

    expect(screen.queryByText(project)).toBeNull()
    expect(screen.queryByText('品牌周报')).toBeNull()
    expect(screen.getByText(workflow)).toBeTruthy()
    expect(screen.getByText('竞品监控')).toBeTruthy()
    expect(screen.getByText(run)).toBeTruthy()
    expect(screen.getByText('本周报告')).toBeTruthy()
  })
})
