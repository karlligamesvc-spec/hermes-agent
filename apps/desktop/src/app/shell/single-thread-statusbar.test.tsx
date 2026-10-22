import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { useApprovalModeStatusbarItem } from '@/app/shell/approval-mode-menu'
import { singleThreadStatusbarItems, useSingleThreadStatusbar } from '@/app/shell/single-thread-statusbar'
import { StatusbarControls, type StatusbarItem } from '@/app/shell/statusbar-controls'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $approvalModes } from '@/store/approval-mode'
import { $activeGatewayProfile } from '@/store/profile'
import { $singleThreadFlag } from '@/store/single-thread'
import { $statusbarHiddenIds, STATUSBAR_HIDDEN_BY_DEFAULT } from '@/store/statusbar-prefs'
import { setToolViewMode } from '@/store/tool-view'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

const item = (id: string): StatusbarItem => ({ id, label: id, variant: 'text' })

// Every core id useStatusbarItems builds today.
const CORE = [
  'command-center',
  'gateway-switcher',
  'gateway-health',
  'free-tier',
  'workspace-cwd',
  'agents',
  'cron',
  'webhooks',
  'running-timer',
  'context-usage',
  'cache-hit-rate',
  'tokens-per-second',
  'session-timer',
  'system-resources',
  'approval-mode',
  'terminal',
  'version-client',
  'version-backend'
].map(item)

const ids = (items: readonly StatusbarItem[]) => items.map(entry => entry.id)

beforeAll(() => {
  stubResizeObserver()
  stubMenuDomApis()
})

afterEach(() => {
  cleanup()
  $singleThreadFlag.set(false)
  setToolViewMode('product')
})

describe('the status bar in single-thread mode', () => {
  it.each([
    [{ approvalsOff: false, updatePending: false }, []],
    [{ approvalsOff: true, updatePending: false }, ['approval-mode']],
    [{ approvalsOff: false, updatePending: true }, ['version-client']],
    [{ approvalsOff: true, updatePending: true }, ['approval-mode', 'version-client']]
  ])('keeps only what needs the user: %j → %j', (keep, kept) => {
    expect(ids(singleThreadStatusbarItems(CORE, [], keep))).toEqual(kept)
  })

  it('passes a plugin’s own items through', () => {
    const radio = item('player')

    expect(
      ids(singleThreadStatusbarItems([...CORE, radio], [radio], { approvalsOff: false, updatePending: false }))
    ).toEqual(['player'])
  })

  it('draws no bar when nothing is left, and the usual bar otherwise', () => {
    $singleThreadFlag.set(true)

    const { unmount } = render(
      <MemoryRouter>
        <StatusbarControls items={[]} leftItems={[]} />
      </MemoryRouter>
    )

    expect(screen.queryByRole('contentinfo')).toBeNull()
    unmount()

    $singleThreadFlag.set(false)
    render(
      <MemoryRouter>
        <StatusbarControls items={[]} leftItems={[]} />
      </MemoryRouter>
    )

    expect(screen.getByRole('contentinfo')).toBeTruthy()
  })
})

describe('useStatusbarItems, narrowed', () => {
  const plugin = item('player')
  const sets = { leftStatusbarItems: CORE.slice(0, 5), statusbarItems: [...CORE.slice(5), plugin] }
  const extras = { extraLeftItems: [], extraRightItems: [plugin] }

  afterEach(() => $approvalModes.set({}))

  it('hands the items back untouched with the switch off', () => {
    const { result } = renderHook(() => useSingleThreadStatusbar(sets, extras))

    expect(result.current).toBe(sets)
  })

  it('keeps ⚡ only while this profile’s approvals are off, plus plugin items', () => {
    $singleThreadFlag.set(true)
    $activeGatewayProfile.set('default')

    const { rerender, result } = renderHook(() => useSingleThreadStatusbar(sets, extras))

    expect(ids(result.current.leftStatusbarItems)).toEqual([])
    expect(ids(result.current.statusbarItems)).toEqual(['player'])

    $approvalModes.set({ default: 'off' })
    rerender()

    expect(ids(result.current.statusbarItems)).toEqual(['approval-mode', 'player'])
  })

  it('stays as it was in developer mode', () => {
    $singleThreadFlag.set(true)
    setToolViewMode('technical')

    const { result } = renderHook(() => useSingleThreadStatusbar(sets, extras))

    expect(result.current).toBe(sets)
  })
})

describe('⚡ while approvals are off: the one place left to change them', () => {
  afterEach(() => {
    $approvalModes.set({})
    $statusbarHiddenIds.set([...STATUSBAR_HIDDEN_BY_DEFAULT])
    setRuntimeI18nLocale('en')
  })

  function Bar({
    requestGateway
  }: {
    requestGateway: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  }) {
    const approval = useApprovalModeStatusbarItem('default', requestGateway)
    const plain = item('gateway-health')

    const { leftStatusbarItems, statusbarItems } = useSingleThreadStatusbar(
      // As use-statusbar-items.tsx adds it: a toggleLabel is what lets the user hide an item.
      { leftStatusbarItems: [plain], statusbarItems: [{ ...approval, toggleLabel: '审批' }] },
      { extraLeftItems: [], extraRightItems: [] }
    )

    return <StatusbarControls items={statusbarItems} leftItems={leftStatusbarItems} />
  }

  it('shows even when the user once hid it, and its menu switches approvals back on', async () => {
    setRuntimeI18nLocale('zh')
    $singleThreadFlag.set(true)
    $activeGatewayProfile.set('default')
    $statusbarHiddenIds.set([...STATUSBAR_HIDDEN_BY_DEFAULT, 'approval-mode'])

    const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) =>
      method === 'config.get' ? { value: 'off' } : { value: params?.value }
    )

    render(
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="zh">
          <Bar requestGateway={requestGateway} />
        </I18nProvider>
      </MemoryRouter>
    )

    const zap = await screen.findByRole('button', { name: /关闭/ })

    expect(screen.queryByText('gateway-health')).toBeNull()

    await act(async () => {
      fireEvent.pointerDown(zap, { button: 0, pointerId: 1, pointerType: 'mouse' })
      fireEvent.pointerUp(zap, { button: 0, pointerId: 1, pointerType: 'mouse' })
      fireEvent.click(zap)
    })

    fireEvent.click(await screen.findByRole('menuitemradio', { name: /智能/ }))

    await waitFor(() =>
      expect(requestGateway).toHaveBeenCalledWith('config.set', { key: 'approvals.mode', value: 'smart' })
    )
  })
})
