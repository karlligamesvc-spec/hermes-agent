import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EngineUpdateSection } from '@/app/settings/about-settings'
import type {
  DesktopEngineHolder,
  DesktopRuntimeUpdateApply,
  DesktopRuntimeUpdateCheck,
  DesktopRuntimeVersion,
  DesktopShellUpdateState
} from '@/global'
import { I18nProvider } from '@/i18n'
import { applyDesktopUpdates } from '@/store/desktop-update'
import { $shellUpdate, endEngineLeftovers } from '@/store/shell-update'

import { DesktopUpdatePill } from './desktop-update-pill'

// hc-1094: a wait on engine holders names them in words, and offers to end them only when every
// one is APEX's own leftover. Ending goes to the main process by PID + start time, then the
// install (or the engine switch) is asked for again through the usual gate.
vi.mock('@/store/desktop-update', async () => {
  const { atom } = await import('nanostores')

  return {
    $desktopUpdateProgress: atom({
      active: false,
      completedStages: [],
      currentStage: null,
      error: null,
      stages: [],
      targetVersion: null
    }),
    applyDesktopUpdates: vi.fn(async () => {}),
    checkDesktopUpdates: vi.fn()
  }
})

const switchToBundledEngine = vi.hoisted(() => vi.fn<() => Promise<DesktopRuntimeUpdateApply>>())

vi.mock('@/store/runtime-update', async () => {
  const { atom } = await import('nanostores')

  return {
    $runtimeUpdateApplying: atom(false),
    $runtimeUpdateCheck: atom<DesktopRuntimeUpdateCheck | null>(null),
    $runtimeUpdateChecking: atom(false),
    $runtimeVersion: atom<DesktopRuntimeVersion | null>(null),
    applyRuntimeUpdate: vi.fn(),
    checkRuntimeUpdate: vi.fn(async () => null),
    loadRuntimeVersion: vi.fn(async () => null),
    switchToBundledEngine
  }
})

import { $runtimeVersion } from '@/store/runtime-update'

const GATEWAY: DesktopEngineHolder = {
  pid: 1347,
  kind: 'leftover_gateway',
  name: 'hermes',
  created: 7.5,
  endable: true
}

const GATEWAY_WORKER: DesktopEngineHolder = {
  pid: 1400,
  kind: 'leftover_gateway',
  name: 'node',
  created: 9.5,
  endable: true
}

const ENGINE: DesktopEngineHolder = { pid: 1500, kind: 'leftover_engine', name: 'hermes', created: 3.5, endable: true }

const TERMINAL: DesktopEngineHolder = {
  pid: 2001,
  kind: 'terminal_hermes',
  name: 'hermes',
  created: 8.5,
  endable: false
}

const OTHER: DesktopEngineHolder = { pid: 3001, kind: 'other', name: 'Code Helper', created: 1.5, endable: false }
const UNKNOWN: DesktopEngineHolder = { pid: 3002, kind: 'other', name: null, created: null, endable: false }

const endLeftovers = vi.fn()

function waiting(holders: DesktopEngineHolder[]): DesktopShellUpdateState {
  return {
    error: null,
    percent: 100,
    phase: 'downloaded',
    releaseNotes: null,
    version: '0.17.67',
    deferred: true,
    deferredReason: 'engine_holders',
    deferredHolders: holders
  }
}

function inLocale(locale: 'en' | 'zh', node: React.ReactNode) {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      {node}
    </I18nProvider>
  )
}

beforeEach(() => {
  endLeftovers.mockReset().mockResolvedValue({ ok: true, ended: { 1347: 'terminated', 1400: 'killed' } })
  vi.mocked(applyDesktopUpdates).mockClear()
  switchToBundledEngine.mockReset()
  $shellUpdate.set(null)
  $runtimeVersion.set(null)
  window.hermesDesktop = {
    shellUpdate: { endLeftovers, getState: async () => $shellUpdate.get(), onEvent: () => () => {} }
  } as unknown as typeof window.hermesDesktop
})

afterEach(() => {
  cleanup()
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

describe('the update pill', () => {
  it.each<[string, DesktopEngineHolder[], string]>([
    [
      'a leftover gateway and its worker',
      [GATEWAY, GATEWAY_WORKER],
      '上一次留下的消息网关在用 APEX 引擎，它退出后自动安装更新。这是 APEX 之前没关干净留下的，可以直接结束。'
    ],
    [
      'two kinds of leftover',
      [GATEWAY, ENGINE],
      '上一次留下的消息网关、上一次 APEX 的引擎在用 APEX 引擎，它们退出后自动安装更新。这些是 APEX 之前没关干净留下的，可以直接结束。'
    ],
    [
      'hermes in a terminal',
      [TERMINAL],
      '终端里运行的 hermes 在用 APEX 引擎，它退出后自动安装更新。在运行 hermes 的终端里按 Ctrl+C 退出它。'
    ],
    ['another program', [OTHER], '其他程序（Code Helper）在用 APEX 引擎，它退出后自动安装更新。'],
    ['a program the scan could not inspect', [UNKNOWN], '其他程序在用 APEX 引擎，它退出后自动安装更新。'],
    [
      "APEX's own running work",
      [{ ...ENGINE, kind: 'apex_running', endable: false }],
      'APEX 自己的后台进程在用 APEX 引擎，它退出后自动安装更新。'
    ]
  ])('names %s', (_label, holders, text) => {
    $shellUpdate.set(waiting(holders))
    inLocale('zh', <DesktopUpdatePill />)

    expect(screen.getByTestId('desktop-update-deferred').textContent).toBe(text)
    expect(screen.getByTestId('desktop-update-deferred').className).toBe('p5-update-pill-deferred')
  })

  it.each<[string, DesktopEngineHolder[]]>([
    ['a terminal hermes beside a leftover', [GATEWAY, TERMINAL]],
    ['another program beside a leftover', [GATEWAY, OTHER]],
    ['a leftover without a start time', [{ ...GATEWAY, created: null }]],
    ["APEX's own running work", [{ ...ENGINE, kind: 'apex_running', endable: false }]]
  ])('offers no end action for %s: ending would not unblock the install', (_label, holders) => {
    $shellUpdate.set(waiting(holders))
    inLocale('zh', <DesktopUpdatePill />)

    expect(screen.queryByTestId('engine-holders-end')).toBeNull()
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['安装并重启'])
  })

  it('ends the confirmed leftovers by PID and start time, then asks to install again', async () => {
    $shellUpdate.set(waiting([GATEWAY, GATEWAY_WORKER]))
    inLocale('zh', <DesktopUpdatePill />)

    fireEvent.click(screen.getByTestId('engine-holders-end'))

    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('结束 APEX 留下的进程？')
    expect(dialog.textContent).toContain(
      '将结束：上一次留下的消息网关（进程 1347、1400）。APEX 会先请它们自己退出，10 秒内没退出就强制结束，然后安装更新并重启。它停下后，微信、飞书等消息渠道要等 APEX 重新打开才会恢复。'
    )
    expect(endLeftovers).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '结束并安装' }))
    })

    await waitFor(() => expect(applyDesktopUpdates).toHaveBeenCalledTimes(1))
    expect(endLeftovers).toHaveBeenCalledExactlyOnceWith([
      { pid: 1347, created: 7.5 },
      { pid: 1400, created: 9.5 }
    ])
    expect(vi.mocked(applyDesktopUpdates).mock.invocationCallOrder[0]).toBeGreaterThan(
      endLeftovers.mock.invocationCallOrder[0]!
    )
  })

  it.each([
    ['the request failed', { ok: false, error: 'scan failed' }],
    ['a process survived', { ok: true, ended: { 1347: 'survived' } }],
    ['the process could not be signalled', { ok: true, ended: { 1347: 'denied' } }]
  ])('keeps the confirmation open and installs nothing when %s', async (_label, result) => {
    endLeftovers.mockResolvedValue(result)
    $shellUpdate.set(waiting([GATEWAY]))
    inLocale('zh', <DesktopUpdatePill />)

    fireEvent.click(screen.getByTestId('engine-holders-end'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '结束并安装' }))
    })

    await waitFor(() =>
      expect(screen.getByRole('dialog').textContent).toContain(
        '没能结束这些进程。请完全退出 APEX 后重新打开，或重启电脑。'
      )
    )
    expect(applyDesktopUpdates).not.toHaveBeenCalled()
  })

  it('says it in English', () => {
    $shellUpdate.set(waiting([GATEWAY, TERMINAL, OTHER]))
    inLocale('en', <DesktopUpdatePill />)

    expect(screen.getByTestId('desktop-update-deferred').textContent).toBe(
      'The messaging gateway left from an earlier session, hermes running in a terminal, and another program (Code Helper) are using the APEX engine. The update installs once they exit. Press Ctrl+C in the terminal running hermes to stop it.'
    )
  })

  it('keeps the hc-1030 line when the gate named no holders', () => {
    $shellUpdate.set({ ...waiting([]), deferredHolders: null })
    inLocale('zh', <DesktopUpdatePill />)

    expect(screen.getByTestId('desktop-update-deferred').textContent).toBe(
      '有别的程序在用 APEX 引擎，它退出后自动安装更新。'
    )
    expect(screen.queryByTestId('engine-holders-end')).toBeNull()
  })
})

describe('the About update section', () => {
  it('names the holders and offers the same end action', async () => {
    $shellUpdate.set(waiting([ENGINE]))
    inLocale('zh', <EngineUpdateSection />)

    expect(screen.getByTestId('desktop-update-deferred').textContent).toBe(
      '上一次 APEX 的引擎在用 APEX 引擎，它退出后自动安装更新。这是 APEX 之前没关干净留下的，可以直接结束。'
    )
    fireEvent.click(screen.getByTestId('engine-holders-end'))
    expect(screen.getByRole('dialog').textContent).not.toContain('消息渠道')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '结束并安装' }))
    })
    await waitFor(() => expect(applyDesktopUpdates).toHaveBeenCalledTimes(1))
    expect(endLeftovers).toHaveBeenCalledExactlyOnceWith([{ pid: 1500, created: 3.5 }])
  })

  it.each(['active_work', 'gateway_busy'] as const)('still says nothing about a %s wait, as before', reason => {
    $shellUpdate.set({ ...waiting([ENGINE]), deferredReason: reason })
    inLocale('zh', <EngineUpdateSection />)

    expect(screen.queryByTestId('desktop-update-deferred')).toBeNull()
  })
})

describe('the kept-back engine notice', () => {
  it('names the holders of a busy switch and switches again after ending them', async () => {
    $runtimeVersion.set({
      ok: true,
      version: null,
      commit: null,
      branch: null,
      key: null,
      keptBack: { reason: 'upgrade-failed', bundledVersion: 'v2026.10.28-fork.aa8e554e' }
    })
    switchToBundledEngine.mockResolvedValue({ ok: true, deferred: true, reason: 'engine_holders', holders: [GATEWAY] })
    inLocale('zh', <EngineUpdateSection />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '换成自带引擎' }))
    })

    const banner = screen.getByTestId('engine-kept-back-banner')
    expect(screen.getByTestId('desktop-update-deferred').textContent).toBe(
      '上一次留下的消息网关在用 APEX 引擎，它退出后自动安装更新。这是 APEX 之前没关干净留下的，可以直接结束。'
    )
    expect(banner.textContent).not.toContain('APEX 还有任务在用引擎')

    fireEvent.click(screen.getByRole('button', { name: '结束并换引擎' }))
    expect(screen.getByRole('dialog').textContent).toContain('然后换成自带引擎。')
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: '结束并换引擎' }).at(-1)!)
    })

    await waitFor(() => expect(switchToBundledEngine).toHaveBeenCalledTimes(2))
    expect(endLeftovers).toHaveBeenCalledExactlyOnceWith([{ pid: 1347, created: 7.5 }])
  })

  it('keeps its own line for a busy switch that names no holders', async () => {
    $runtimeVersion.set({
      ok: true,
      version: null,
      commit: null,
      branch: null,
      key: null,
      keptBack: { reason: 'upgrade-failed', bundledVersion: 'v2026.10.28-fork.aa8e554e' }
    })
    switchToBundledEngine.mockResolvedValue({ ok: true, deferred: true, reason: 'active_work', holders: null })
    inLocale('zh', <EngineUpdateSection />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '换成自带引擎' }))
    })

    expect(screen.getByTestId('engine-kept-back-banner').textContent).toContain(
      'APEX 还有任务在用引擎，做完后再点一次。'
    )
    expect(screen.queryByTestId('desktop-update-deferred')).toBeNull()
  })
})

describe('endEngineLeftovers', () => {
  it('sends only endable holders with a start time, whatever the caller passes', async () => {
    await endEngineLeftovers([GATEWAY, TERMINAL, { ...ENGINE, created: null }, OTHER])

    expect(endLeftovers).toHaveBeenCalledExactlyOnceWith([{ pid: 1347, created: 7.5 }])
  })

  it('answers unsupported on a shell without the bridge', async () => {
    delete (window as { hermesDesktop?: unknown }).hermesDesktop

    await expect(endEngineLeftovers([GATEWAY])).resolves.toEqual({ ok: false, error: 'unsupported' })
  })
})
