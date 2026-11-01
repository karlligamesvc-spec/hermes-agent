import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'
import { SINGLE_THREAD_BOTS_COPY } from '@/i18n/single-thread-bots'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { RUN_IN_REVIEW, RUN_RUNNING_EMPTY, RUN_SUCCEEDED } from '../../../__identity__/fold-deliverables/run-fixtures'
import { seedSignedIn } from '../../../__identity__/fold-projects/render'
import type { WorkflowRunOverview } from '../api/types'

import { AssistantWorkspaceView } from './assistant-page'
import { DeliverablesView } from './deliverables-page'
import { WorkflowRunView } from './workflow-run-page'

/**
 * hc-1129, the product-mode side, on the real components and real read hooks with
 * only the Electron bridge faked: what the run drawer shows, and that 连接助手 asks
 * the server for no deliverables (production answers 404, and desktop.log records it).
 */

vi.mock('../../im-entry', () => ({ ImEntryView: () => <div data-testid="connections" /> }))

const access = vi.fn(async () => ({ available: true }))
const getRun = vi.fn()
const listDeliverables = vi.fn(async () => ({ items: [], nextCursor: null, ok: true }))
const listProjects = vi.fn(async () => ({ items: [], nextCursor: null, ok: true }))
const reviewDeliverable = vi.fn(async () => ({ ok: true }))

const DEVELOPER = { flag: true, toolView: 'technical' } as const
const OFF = { flag: false, toolView: 'product' } as const
const PRODUCT = { flag: true, toolView: 'product' } as const

function setMode({ flag, toolView }: { flag: boolean; toolView: 'product' | 'technical' }) {
  setSingleThreadFlagForTest(flag)
  setToolViewMode(toolView)
}

async function renderRun(overview: WorkflowRunOverview, locale: Locale = 'zh') {
  getRun.mockResolvedValue({ ok: true, overview })

  const view = render(
    <MemoryRouter initialEntries={[`/workflow-runs/${overview.run.id}`]}>
      <I18nProvider configClient={null} initialLocale={locale}>
        <Routes>
          <Route element={<WorkflowRunView />} path="workflow-runs/:runId" />
        </Routes>
      </I18nProvider>
    </MemoryRouter>
  )

  await waitFor(() => expect(view.container.querySelector('[data-run-scroll-container]')).toBeTruthy())

  return view
}

beforeEach(() => {
  seedSignedIn()
  access.mockClear()
  getRun.mockReset()
  listDeliverables.mockClear()
  listProjects.mockClear()
  reviewDeliverable.mockClear()
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { workflowDomain: { access, getRun, listDeliverables, listProjects, reviewDeliverable } }
  })
})

afterEach(async () => {
  cleanup()
  await new Promise(resolve => setTimeout(resolve, 0))
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('hc-1129 连接助手 reads', () => {
  async function renderAssistant() {
    render(
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <AssistantWorkspaceView />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(listProjects).toHaveBeenCalled())
    // The projects read has answered and every effect has run: a deliverables read would have started by now.
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  it('product mode asks the server for no deliverables, and still lists projects for the run rows', async () => {
    setMode(PRODUCT)
    await renderAssistant()

    expect(listDeliverables).not.toHaveBeenCalled()
    expect(listProjects).toHaveBeenCalledTimes(1)
    // Each read asks for access first, and that is the request production answers 404: one read, one line in desktop.log.
    expect(access).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['developer mode', DEVELOPER],
    ['the switch off', OFF]
  ])('%s still reads them', async (_label, mode) => {
    setMode(mode)
    await renderAssistant()

    expect(listDeliverables).toHaveBeenCalled()
  })

  it('the 交付物 page itself passes no option and still reads them', async () => {
    setMode(OFF)
    render(
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <DeliverablesView />
        </I18nProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(listDeliverables).toHaveBeenCalled())
  })
})

describe('hc-1129 the words product mode shows', () => {
  it.each([
    ['zh', '查看和连接消息渠道。'],
    ['zh-hant', '查看和連接訊息渠道。'],
    ['en', 'See and connect your messaging channels.'],
    ['ja', 'メッセージチャネルの確認と接続ができます。'],
    ['ar', 'راجع قنوات الرسائل واربطها.']
  ] as const)('连接助手 says what it is for, with no 交付物 (%s)', (locale, description) => {
    setMode(PRODUCT)
    render(
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale={locale}>
          <AssistantWorkspaceView />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(screen.getByText(description)).toBeTruthy()
  })

  it.each(Object.entries(SINGLE_THREAD_BOTS_COPY))('deleting an assistant names no 交付物 (%s)', (_locale, copy) => {
    expect(copy.deleteBody).not.toMatch(/交付物|deliverable/i)
  })
})

describe('hc-1129 product mode: the run drawer lists no 交付物', () => {
  beforeEach(() => setMode(PRODUCT))

  it.each([
    ['waiting for review', RUN_IN_REVIEW],
    ['finished', RUN_SUCCEEDED],
    ['running with nothing yet', RUN_RUNNING_EMPTY]
  ])('a run %s: no row, no button and nothing to decide', async (_label, overview) => {
    const { container } = await renderRun(overview)

    for (const name of ['批准交付物', '打开交付物', '要求修改']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }

    for (const title of ['交付物与审阅', '需要审阅', '尚无交付物', '当前无待处理事项']) {
      expect(screen.queryByText(title)).toBeNull()
    }

    for (const row of overview.deliverables) {
      expect(screen.queryByText(row.title)).toBeNull()
    }

    expect(container.textContent).not.toContain('交付物')
    expect(container.textContent).toContain(overview.run.triggerRef)
  })

  it('reads the same in English', async () => {
    const { container } = await renderRun(RUN_IN_REVIEW, 'en')

    expect(container.textContent).not.toMatch(/deliverable/i)
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull()
  })

  it('keeps the stage progress and the run details', async () => {
    await renderRun(RUN_IN_REVIEW)

    expect(screen.getByRole('tab', { name: '进展' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '执行详情' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '阶段进度' })).toBeTruthy()
  })

  it.each([
    ['developer mode', DEVELOPER],
    ['the switch off', OFF]
  ])('%s keeps the rows and the buttons', async (_label, mode) => {
    setMode(mode)
    await renderRun(RUN_IN_REVIEW)

    expect(screen.getByRole('button', { name: '批准交付物' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '打开交付物' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: '要求修改' })).toBeTruthy()
  })
})
