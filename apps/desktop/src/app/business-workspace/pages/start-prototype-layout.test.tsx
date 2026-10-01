import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { ar } from '@/i18n/ar'
import { en } from '@/i18n/en'
import { ja } from '@/i18n/ja'
import { zh } from '@/i18n/zh'
import { zhHant } from '@/i18n/zh-hant'
import { $authState } from '@/store/auth'

import type { WorkflowDomainBridge, WorkflowVideoCatalogResult } from '../api/types'

import { BusinessStartHome } from './start-page'

const primary = [
  ['market-launch', en.home.primaryPaths.commerce.title, 7],
  ['geo-brand-audit', en.home.primaryPaths.geo.title, 3],
  ['content-review', en.home.primaryPaths.content.title, 2]
] as const

const originalAuth = $authState.get()

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })

  return { promise, resolve }
}

function account(id: string) {
  $authState.set({ ...originalAuth, accountId: id, enabled: true, status: 'signed-in' })
}

function Location() {
  const location = useLocation()

  return <output data-testid="location">{JSON.stringify({ pathname: location.pathname, state: location.state })}</output>
}

function NewOwnerEntry() {
  const navigate = useNavigate()

  return <button onClick={() => navigate('/', { state: { businessStartSelection: true, businessGoalDraft: 'New owner brief' } })}>New owner Start</button>
}

function installCatalog(items: { id: string; slug: string; version: number }[], ok = true) {
  const bridge = {
    access: vi.fn(async () => ({ available: true })),
    getCatalog: vi.fn(async () => ({ ok, version: 'workflow-catalog/v1', items: items.map((item, index) => ({ ...item, businessPath: 'fixture', position: index + 1, recommended: true })) })),
    getVideoCatalog: vi.fn<NonNullable<WorkflowDomainBridge['getVideoCatalog']>>(async () => ({ ok: true, items: [], version: 'video/v1' })),
    listProjects: vi.fn(async () => ({ ok: true, items: [], total: 0 })),
    startGoal: vi.fn<WorkflowDomainBridge['startGoal']>(async () => ({ ok: false }))
  }

  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { workflowDomain: bridge } })

  return bridge
}

afterEach(() => {
  cleanup()
  $authState.set(originalAuth)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: undefined })
})

function renderStart(chat: (goal: string) => Promise<boolean>) {
  render(<MemoryRouter><I18nProvider configClient={null} initialLocale="en">
    <BusinessStartHome onSubmitGoal={chat} /><Location /><NewOwnerEntry />
  </I18nProvider></MemoryRouter>)

  return screen.getByRole('textbox', { name: 'Business goal' }) as HTMLTextAreaElement
}

async function selectCommerce() {
  const choice = screen.getByRole('button', { name: `${en.home.primaryPaths.commerce.title} · ${en.businessWorkspace.workflows.use}` })

  await waitFor(() => expect(choice.hasAttribute('disabled')).toBe(false))
  fireEvent.click(choice)
}

function enterNewOwner() {
  act(() => account('B'))
  fireEvent.click(screen.getByRole('button', { name: 'New owner Start' }))
}

describe('prototype Start paths with the real catalog contract', () => {
  it('locks every template-change entry until the issued workflow request settles', async () => {
    const bridge = installCatalog(primary.map(([id, , version]) => ({ id, slug: id, version })))
    const result = deferred<Awaited<ReturnType<WorkflowDomainBridge['startGoal']>>>()
    bridge.startGoal.mockReturnValueOnce(result.promise)
    const chat = vi.fn(async () => false)
    const goal = renderStart(chat)
    await selectCommerce()
    fireEvent.change(goal, { target: { value: 'Issued commerce brief' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }))
    await waitFor(() => expect(bridge.startGoal).toHaveBeenCalledTimes(1))
    const primaryRegion = window.document.querySelector('[data-start-primary-workflows]') as HTMLElement
    const secondaryRegion = window.document.querySelector('[data-start-recommended-workflows]') as HTMLElement
    const form = goal.closest('form')!
    const change = screen.getByRole('button', { name: en.businessWorkspace.goalLauncher.changeWorkflow })
    const footer = within(form).getByRole('button', { name: `${en.businessWorkspace.goalLauncher.confirmationTemplate}${en.home.primaryPaths.commerce.title}` })
    const catalog = screen.getByRole('button', { name: en.businessWorkspace.workflows.title })
    const changes = [...within(primaryRegion).getAllByRole('button'), ...within(secondaryRegion).getAllByRole('button'), change, footer, catalog]
    const disabled = changes.map(button => button.hasAttribute('disabled'))

    for (const button of changes) {
      fireEvent.click(button)
    }

    expect(goal.value).toBe('Issued commerce brief')
    expect(within(primaryRegion).getByRole('button', { pressed: true }).textContent).toContain(en.home.primaryPaths.commerce.title)
    expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/')
    expect(disabled.every(Boolean)).toBe(true)
    expect(bridge.startGoal).toHaveBeenCalledTimes(1)
    expect(chat).not.toHaveBeenCalled()
    await act(async () => result.resolve({ ok: false }))
    await screen.findByRole('alert')
    expect(change.hasAttribute('disabled')).toBe(false)
    expect(within(secondaryRegion).getAllByRole('button').every(button => !button.hasAttribute('disabled'))).toBe(true)
    fireEvent.click(within(primaryRegion).getByRole('button', { name: `${en.home.primaryPaths.geo.title} · ${en.businessWorkspace.workflows.use}` }))
    expect(within(primaryRegion).getByRole('button', { pressed: true }).textContent).toContain(en.home.primaryPaths.geo.title)
  })

  it.each(['present', 'missing'] as const)('does not adopt the new owner after a pending home-video catalog becomes %s', async availability => {
    account('A')
    const bridge = installCatalog([])

    const video: WorkflowVideoCatalogResult = { ok: true, version: 'video/v1', items: [{
      id: 'viral-video-remake', slug: 'viral-video-remake', version: 4, kind: 'pipeline', name: 'Fixture video',
      position: 1, recommended: true, stepCount: 1, summary: 'Fixture'
    }] }

    bridge.getVideoCatalog.mockResolvedValue(video)
    const chat = vi.fn(async () => true)
    const goal = renderStart(chat)

    await waitFor(() => expect(bridge.getVideoCatalog).toHaveBeenCalledTimes(1))
    await act(async () => { await bridge.getVideoCatalog.mock.results[0]?.value })
    fireEvent.click(screen.getByRole('button', { name: `${en.businessWorkspace.workflows.homePaths.viralRemake.title} · ${en.businessWorkspace.workflows.use}` }))
    expect(screen.getByRole('region', { name: en.businessWorkspace.goalLauncher.confirmationEyebrow })).toBeTruthy()
    const pending = deferred<WorkflowVideoCatalogResult>()
    bridge.getVideoCatalog.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }))
    await waitFor(() => expect(bridge.getVideoCatalog).toHaveBeenCalledTimes(2))
    enterNewOwner()
    expect(goal.value).toBe('New owner brief')
    await act(async () => pending.resolve(availability === 'present' ? video : { ok: true, items: [] }))
    await waitFor(() => expect(goal.disabled).toBe(false))
    expect(bridge.startGoal).not.toHaveBeenCalled()
    expect(chat).not.toHaveBeenCalled()
    expect(goal.value).toBe('New owner brief')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/')
  })

  it('does not fall back to the new owner chat when old workflow access settles unavailable', async () => {
    account('A')
    const bridge = installCatalog([{ id: 'market-launch', slug: 'market-launch', version: 7 }])
    const chat = vi.fn(async () => true)
    const goal = renderStart(chat)
    await selectCommerce()
    const access = deferred<{ available: boolean }>()
    bridge.access.mockReturnValueOnce(access.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }))
    await waitFor(() => expect(goal.disabled).toBe(true))
    enterNewOwner()
    await act(async () => access.resolve({ available: false }))
    await waitFor(() => expect(goal.disabled).toBe(false))
    expect(chat).not.toHaveBeenCalled()
    expect(bridge.startGoal).not.toHaveBeenCalled()
    expect(goal.value).toBe('New owner brief')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not publish the old workflow acknowledgement into the new owner Start', async () => {
    account('A')
    const bridge = installCatalog([{ id: 'market-launch', slug: 'market-launch', version: 7 }])
    const pending = deferred<Awaited<ReturnType<WorkflowDomainBridge['startGoal']>>>()
    bridge.startGoal.mockReturnValueOnce(pending.promise)
    const chat = vi.fn(async () => true)
    const goal = renderStart(chat)
    await selectCommerce()
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }))
    await waitFor(() => expect(bridge.startGoal).toHaveBeenCalledTimes(1))
    enterNewOwner()
    await act(async () => pending.resolve({ ok: true, run: { id: 'old-owner-run' } }))
    await waitFor(() => expect(goal.disabled).toBe(false))
    expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/')
    expect(goal.value).toBe('New owner brief')
    expect(chat).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('preserves the new owner draft after an already-dispatched ordinary chat accepts', async () => {
    account('A')
    const bridge = installCatalog([{ id: 'market-launch', slug: 'market-launch', version: 7 }])
    const pending = deferred<boolean>()
    const chat = vi.fn(() => pending.promise)
    const goal = renderStart(chat)
    fireEvent.change(goal, { target: { value: 'Old owner chat' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start goal' }))
    await waitFor(() => expect(chat).toHaveBeenCalledExactlyOnceWith('Old owner chat'))
    enterNewOwner()
    await act(async () => pending.resolve(true))
    await waitFor(() => expect(goal.disabled).toBe(false))
    expect(goal.value).toBe('New owner brief')
    expect(bridge.startGoal).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['en', en], ['zh', zh], ['zh-hant', zhHant], ['ja', ja], ['ar', ar]
  ] as const)('prepares the localized primary goal in %s without starting work', async (locale, copy) => {
    const bridge = installCatalog([{ id: 'market-launch', slug: 'market-launch', version: 7 }])
    render(<MemoryRouter><I18nProvider configClient={null} initialLocale={locale}><BusinessStartHome /></I18nProvider></MemoryRouter>)
    const choice = screen.getByRole('button', { name: `${copy.home.primaryPaths.commerce.title} · ${copy.businessWorkspace.workflows.use}` })

    await waitFor(() => expect(choice.hasAttribute('disabled')).toBe(false))
    fireEvent.click(choice)
    expect((screen.getByRole('textbox', { name: copy.businessWorkspace.goalLauncher.label }) as HTMLTextAreaElement).value).toBe(copy.home.primaryPaths.commerce.prompt)
    expect(screen.getByRole('region', { name: copy.businessWorkspace.goalLauncher.confirmationEyebrow })).toBeTruthy()
    expect(bridge.startGoal).not.toHaveBeenCalled()
  })

  it('uses each exact primary catalog identity only after explicit goal confirmation and retains a failed brief', async () => {
    const bridge = installCatalog(primary.map(([id, , version]) => ({ id, slug: id, version })))
    const chat = vi.fn(async () => false)
    render(<MemoryRouter><I18nProvider configClient={null} initialLocale="en"><BusinessStartHome onSubmitGoal={chat} /></I18nProvider></MemoryRouter>)
    const goal = screen.getByRole('textbox', { name: 'Business goal' }) as HTMLTextAreaElement
    const primaryRegion = window.document.querySelector('[data-start-primary-workflows]') as HTMLElement
    expect(within(primaryRegion).getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true)

    for (const [id, title, version] of primary) {
      const choice = within(primaryRegion).getByRole('button', { name: `${title} · ${en.businessWorkspace.workflows.use}` })
      await waitFor(() => expect(choice.hasAttribute('disabled')).toBe(false))
      const brief = `My edited goal for ${id}`
      fireEvent.change(goal, { target: { value: brief } })
      const priorCalls = bridge.startGoal.mock.calls.length
      fireEvent.click(choice)
      expect(goal.value).toBe(brief)
      expect(choice.getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByRole('region', { name: en.businessWorkspace.goalLauncher.confirmationEyebrow })).toBeTruthy()
      expect(screen.getByText(`${en.businessWorkspace.goalLauncher.confirmationTemplate}${title} · ${en.businessWorkspace.workflows.version(version)}`)).toBeTruthy()
      expect(bridge.startGoal).toHaveBeenCalledTimes(priorCalls)
      expect(chat).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Start goal' }))
      await waitFor(() => expect(bridge.startGoal).toHaveBeenCalledTimes(priorCalls + 1))
      expect(bridge.startGoal).toHaveBeenLastCalledWith(expect.objectContaining({ objective: brief, starter: expect.objectContaining({ id, slug: id, version }) }))
      await screen.findByRole('alert')
      expect(goal.value).toBe(brief)
    }

    for (const copy of Object.values(en.businessWorkspace.workflows.homePaths)) {
      expect(screen.getByRole('button', { name: `${copy.title} · ${en.businessWorkspace.workflows.use}` })).toBeTruthy()
    }
  })

  it.each(['unavailable', 'mismatched-slug'] as const)('keeps %s primary templates disabled and the footer chooser preserves the brief without sending it', async mode => {
    const bridge = installCatalog(primary.map(([id, , version]) => ({ id, slug: `${id}-not-matching`, version })), mode !== 'unavailable')
    const chat = vi.fn(async () => false)
    render(<MemoryRouter><I18nProvider configClient={null} initialLocale="en"><BusinessStartHome onSubmitGoal={chat} /><Location /></I18nProvider></MemoryRouter>)
    await waitFor(() => expect(screen.queryByText(en.home.catalogLoading)).toBeNull())

    if (mode === 'unavailable') {
      expect(screen.getByText(en.businessWorkspace.workflows.catalogUnavailable)).toBeTruthy()
    }

    const primaryRegion = window.document.querySelector('[data-start-primary-workflows]') as HTMLElement

    for (const button of within(primaryRegion).getAllByRole('button')) {
      expect(button.hasAttribute('disabled')).toBe(true)
      fireEvent.click(button)
    }

    const goal = screen.getByRole('textbox', { name: 'Business goal' }) as HTMLTextAreaElement
    fireEvent.change(goal, { target: { value: 'Keep my business brief' } })
    const form = goal.closest('form')!
    fireEvent.click(within(form).getByRole('button', { name: 'Choose workflow' }))
    await waitFor(() => expect(JSON.parse(screen.getByTestId('location').textContent!).pathname).toBe('/workflows'))
    expect(JSON.parse(screen.getByTestId('location').textContent!).state).toMatchObject({ businessStartSelection: true, businessGoalDraft: 'Keep my business brief' })
    expect(bridge.startGoal).not.toHaveBeenCalled()
    expect(chat).not.toHaveBeenCalled()
  })
})
