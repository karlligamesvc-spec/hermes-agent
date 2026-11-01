// First, before any app module: the zone the shell goldens are recorded in.
import './__identity__/single-thread-shell/time-zone'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkflowRunView } from '@/app/business-workspace/pages/workflow-run-page'
import { I18nProvider, type Locale } from '@/i18n'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setToolViewMode } from '@/store/tool-view'

import { RUN_IN_REVIEW, RUN_RUNNING_EMPTY, RUN_SUCCEEDED } from './__identity__/fold-deliverables/run-fixtures'
import { bodyHtml, seedSignedIn } from './__identity__/fold-projects/render'
import { restoreRecordingTimeZone } from './__identity__/single-thread-shell/time-zone'

/**
 * hc-1129 identity guard (hard rule 11): the run drawer's deliverable area, on the
 * real WorkflowRunView, with the switch off and in developer mode. The goldens in
 * `__identity__/fold-deliverables/` were recorded on fork main b881175df2 before
 * any hc-1129 code existed. A diff means the off path moved: fix the code;
 * re-record only for a change meant to reach every user.
 */

const FIXED_NOW = new Date('2026-10-20T12:00:00Z')
const getRun = vi.fn()
const reviewDeliverable = vi.fn(async () => ({ ok: true }))

function Where() {
  const location = useLocation()

  return (
    <output data-testid="where">
      {JSON.stringify({ state: location.state, to: `${location.pathname}${location.search}${location.hash}` })}
    </output>
  )
}

async function renderRun(overview: typeof RUN_IN_REVIEW, locale: Locale = 'zh') {
  getRun.mockResolvedValue({ ok: true, overview })
  const opener = { hash: '', pathname: '/assistant', search: '', state: null }

  render(
    <MemoryRouter initialEntries={[{ pathname: `/workflow-runs/${overview.run.id}`, state: { opener } }]}>
      <I18nProvider configClient={null} initialLocale={locale}>
        <Where />
        <Routes>
          <Route element={<WorkflowRunView />} path="workflow-runs/:runId" />
          <Route element={null} path="*" />
        </Routes>
      </I18nProvider>
    </MemoryRouter>
  )

  await waitFor(() => expect(document.querySelector('[data-run-scroll-container]')).toBeTruthy())
}

const where = () => JSON.parse(screen.getByTestId('where').textContent!) as { state: unknown; to: string }

beforeEach(() => {
  seedSignedIn()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)
  getRun.mockReset()
  reviewDeliverable.mockClear()
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { workflowDomain: { getRun, reviewDeliverable } }
  })
})

afterEach(async () => {
  cleanup()
  await new Promise(resolve => setTimeout(resolve, 0))
  vi.useRealTimers()
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  Reflect.deleteProperty(window, 'hermesDesktop')
})

afterAll(restoreRecordingTimeZone)

describe.each([
  ['the switch off', false, 'product'],
  ['developer mode with the switch on', true, 'technical']
] as const)('hc-1129 %s: the run drawer is what main shows', (_label, flag, toolView) => {
  beforeEach(() => {
    setSingleThreadFlagForTest(flag)
    setToolViewMode(toolView)
  })

  it.each(['zh', 'en'] as const)('a run waiting for review (%s)', async locale => {
    await renderRun(RUN_IN_REVIEW, locale)

    await expect(bodyHtml()).toMatchFileSnapshot(`./__identity__/fold-deliverables/run-review.${locale}.html`)
  })

  it('a finished run', async () => {
    await renderRun(RUN_SUCCEEDED)

    await expect(bodyHtml()).toMatchFileSnapshot('./__identity__/fold-deliverables/run-succeeded.html')
  })

  it('a running run with nothing yet', async () => {
    await renderRun(RUN_RUNNING_EMPTY)

    await expect(bodyHtml()).toMatchFileSnapshot('./__identity__/fold-deliverables/run-empty.html')
  })

  it('goes where main goes from every deliverable button', async () => {
    const out: Record<string, unknown> = {}

    for (const name of ['打开交付物', '要求修改']) {
      await renderRun(RUN_IN_REVIEW)
      fireEvent.click(screen.getAllByRole('button', { name })[0]!)
      out[name] = where()
      cleanup()
    }

    await renderRun(RUN_IN_REVIEW)
    fireEvent.click(screen.getByRole('button', { name: '批准交付物' }))
    await waitFor(() => expect(reviewDeliverable).toHaveBeenCalledTimes(1))
    out['批准交付物'] = reviewDeliverable.mock.calls[0]

    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
      './__identity__/fold-deliverables/run-clicks.json'
    )
  })
})
