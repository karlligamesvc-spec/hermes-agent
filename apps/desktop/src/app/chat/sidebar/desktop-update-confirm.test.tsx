import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EngineUpdateSection } from '@/app/settings/about-settings'
import type {
  DesktopEngineHolder,
  DesktopRuntimeUpdateCheck,
  DesktopRuntimeVersion,
  DesktopShellUpdateDeferralReason,
  DesktopShellUpdateState
} from '@/global'
import { I18nProvider } from '@/i18n'
import { DESKTOP_UPDATE_COPY } from '@/i18n/desktop-update'
import { applyDesktopUpdates } from '@/store/desktop-update'
import { $shellUpdate } from '@/store/shell-update'
import { $runtimeUpdateWait } from '@/store/update-wait'

import { DesktopUpdateConfirmDialog } from './desktop-update-confirm'
import { DesktopUpdatePill } from './desktop-update-pill'

// hc-1117: confirming an install that then waits used to end in a done beat and nothing else. It
// now answers with who it waits for and what the user can do, on every update entry.
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
    applyDesktopUpdates: vi.fn(async () => false),
    checkDesktopUpdates: vi.fn()
  }
})

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
    switchToBundledEngine: vi.fn()
  }
})

import { $runtimeUpdateCheck } from '@/store/runtime-update'

const zh = DESKTOP_UPDATE_COPY.zh

const CHILD: DesktopEngineHolder = { pid: 4242, kind: 'leftover_child', name: 'python3.14', created: 7.5, endable: true }
const CHILD_TOOL: DesktopEngineHolder = { pid: 4243, kind: 'leftover_child', name: 'ffmpeg', created: 8.5, endable: true }
const ENGINE: DesktopEngineHolder = { pid: 1500, kind: 'leftover_engine', name: 'hermes', created: 3.5, endable: true }
const OTHER: DesktopEngineHolder = { pid: 3001, kind: 'other', name: 'python3.14', created: 1.5, endable: false }
const TERMINAL: DesktopEngineHolder = { pid: 2001, kind: 'terminal_hermes', name: 'hermes', created: 8.5, endable: false }
const RUNNING: DesktopEngineHolder = { pid: 2002, kind: 'apex_running', name: 'python3.14', created: 8.5, endable: false }

const READY: DesktopShellUpdateState = { error: null, percent: 100, phase: 'downloaded', releaseNotes: null, version: '0.17.69' }

function held(holders: DesktopEngineHolder[]): DesktopShellUpdateState {
  return { ...READY, deferred: true, deferredReason: 'engine_holders', deferredHolders: holders }
}

const endLeftovers = vi.fn()

function inLocale(locale: 'en' | 'zh', node: React.ReactNode) {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      {node}
    </I18nProvider>
  )
}

/** The user clicks 「安装并重启」 and confirms; the install does what `apply` does. */
async function confirmInstall(apply: () => boolean | void = () => true) {
  vi.mocked(applyDesktopUpdates).mockImplementationOnce(async () => Boolean(apply()))
  fireEvent.click(screen.getByRole('button', { name: '安装并重启' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '安装更新' }))
  })
}

const waitDialog = () => screen.queryByTestId('desktop-update-wait')

beforeEach(() => {
  endLeftovers.mockReset().mockResolvedValue({ ok: true, ended: { 4242: 'terminated' } })
  vi.mocked(applyDesktopUpdates).mockReset().mockResolvedValue(false)
  $shellUpdate.set(READY)
  $runtimeUpdateWait.set(null)
  $runtimeUpdateCheck.set(null)
  window.hermesDesktop = {
    shellUpdate: { endLeftovers, getState: async () => $shellUpdate.get(), onEvent: () => () => {} }
  } as unknown as typeof window.hermesDesktop
})

afterEach(() => {
  cleanup()
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

describe('confirming an install that goes ahead', () => {
  it('shows the usual confirmation and no wait', async () => {
    inLocale('zh', <DesktopUpdatePill />)
    await confirmInstall(() => false)

    expect(applyDesktopUpdates).toHaveBeenCalledTimes(1)
    expect(waitDialog()).toBeNull()
    expect(screen.getByRole('dialog').textContent).toContain('完成')
  })
})

describe('confirming an install that waits', () => {
  it.each<[DesktopShellUpdateDeferralReason]>([['active_work'], ['activity_unknown'], ['engine_holders'], ['gateway_busy'], ['previous_worker']])(
    'says what %s means and what the user can do',
    async reason => {
      inLocale('zh', <DesktopUpdatePill />)
      await confirmInstall(() => {
        $shellUpdate.set({ ...READY, deferred: true, deferredReason: reason })

        return true
      })

      const dialog = screen.getByTestId('desktop-update-wait')

      expect(dialog.textContent).toContain(zh.wait.title)
      expect(dialog.textContent).toContain(`${zh.deferred[reason]}${zh.wait.next[reason]}`)
      expect(dialog.textContent).not.toContain('完成')
      expect(screen.getAllByRole('dialog')).toHaveLength(1)
      expect(screen.queryByTestId('desktop-update-wait-end')).toBeNull()
    }
  )

  it('never claims done on its way there', async () => {
    inLocale('zh', <DesktopUpdatePill />)
    await confirmInstall(() => {
      $shellUpdate.set(held([OTHER]))

      return true
    })

    expect(screen.getAllByRole('dialog').map(dialog => dialog.getAttribute('data-testid'))).toEqual(['desktop-update-wait'])
    expect(screen.queryByText('完成')).toBeNull()
  })

  it('hands over once: the confirmation asks to be closed one time, with no timed close after it', async () => {
    vi.useFakeTimers()

    try {
      const onClose = vi.fn()

      vi.mocked(applyDesktopUpdates).mockImplementationOnce(async () => {
        $shellUpdate.set(held([OTHER]))

        return true
      })
      inLocale('zh', <DesktopUpdateConfirmDialog apply={applyDesktopUpdates} onClose={onClose} open />)
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '安装更新' }))
      })
      expect(onClose).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each<[string, DesktopEngineHolder[], string]>([
    ['another program', [OTHER], `其他程序（python3.14）在用 APEX 引擎，它退出后自动安装更新。${zh.wait.closeProgram}`],
    ['hermes in a terminal', [TERMINAL], `终端里运行的 hermes 在用 APEX 引擎，它退出后自动安装更新。${zh.holders.terminal}`],
    ["APEX's own running work", [RUNNING], `APEX 自己的后台进程在用 APEX 引擎，它退出后自动安装更新。${zh.wait.ownWork}`],
    [
      'a terminal and another program',
      [TERMINAL, OTHER],
      `终端里运行的 hermes、其他程序（python3.14）在用 APEX 引擎，它们退出后自动安装更新。${zh.holders.terminal}${zh.wait.closeProgram}`
    ],
    ['a leftover beside another program', [CHILD, OTHER], `APEX 之前留下的后台进程、其他程序（python3.14）在用 APEX 引擎，它们退出后自动安装更新。${zh.wait.closeProgram}`]
  ])('names %s and offers nothing to end', async (_label, holders, text) => {
    inLocale('zh', <DesktopUpdatePill />)
    await confirmInstall(() => {
      $shellUpdate.set(held(holders))

      return true
    })

    expect(screen.getByTestId('desktop-update-wait').textContent).toContain(text)
    expect(screen.queryByTestId('desktop-update-wait-end')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: zh.wait.close }))
    await waitFor(() => expect(waitDialog()).toBeNull())
    expect(screen.getByTestId('desktop-update-deferred').textContent).toContain('在用 APEX 引擎')
  })

  it('makes the confirmation to end APEX\'s own leftover, by PID and start time, and asks to install again', async () => {
    inLocale('zh', <DesktopUpdatePill />)
    await confirmInstall(() => {
      $shellUpdate.set(held([CHILD, CHILD_TOOL]))

      return true
    })

    const dialog = screen.getByTestId('desktop-update-wait')

    expect(dialog.textContent).toContain('APEX 之前留下的后台进程在用 APEX 引擎，它退出后自动安装更新。这是 APEX 之前没关干净留下的，可以直接结束。')
    expect(dialog.textContent).toContain('将结束：APEX 之前留下的后台进程（进程 4242、4243）。')
    expect(dialog.textContent).toContain(zh.holders.childNote)
    expect(endLeftovers).not.toHaveBeenCalled()

    vi.mocked(applyDesktopUpdates).mockClear().mockImplementationOnce(async () => {
      $shellUpdate.set(READY)

      return false
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('desktop-update-wait-end'))
    })

    expect(endLeftovers).toHaveBeenCalledExactlyOnceWith([
      { pid: 4242, created: 7.5 },
      { pid: 4243, created: 8.5 }
    ])
    expect(applyDesktopUpdates).toHaveBeenCalledTimes(1)
    expect(vi.mocked(applyDesktopUpdates).mock.invocationCallOrder[0]).toBeGreaterThan(endLeftovers.mock.invocationCallOrder[0]!)
    await waitFor(() => expect(waitDialog()).toBeNull())
  })

  it.each([
    ['the request failed', { ok: false, error: 'scan failed' }],
    ['a process survived', { ok: true, ended: { 4242: 'survived' } }],
    ['the process could not be signalled', { ok: true, ended: { 4242: 'denied' } }]
  ])('stays open with the reason and installs nothing when %s', async (_label, result) => {
    endLeftovers.mockResolvedValue(result)
    inLocale('zh', <DesktopUpdatePill />)
    await confirmInstall(() => {
      $shellUpdate.set(held([CHILD]))

      return true
    })
    vi.mocked(applyDesktopUpdates).mockClear()

    await act(async () => {
      fireEvent.click(screen.getByTestId('desktop-update-wait-end'))
    })

    expect(screen.getByTestId('desktop-update-wait').textContent).toContain(zh.holders.endFailed)
    expect(applyDesktopUpdates).not.toHaveBeenCalled()
    expect((screen.getByTestId('desktop-update-wait-end') as HTMLButtonElement).disabled).toBe(false)
  })

  it('follows the wait: a new holder after ending is named, and the end of the wait closes it', async () => {
    inLocale('zh', <DesktopUpdatePill />)
    await confirmInstall(() => {
      $shellUpdate.set(held([CHILD]))

      return true
    })

    vi.mocked(applyDesktopUpdates).mockImplementationOnce(async () => {
      $shellUpdate.set(held([OTHER]))

      return true
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('desktop-update-wait-end'))
    })

    expect(screen.getByTestId('desktop-update-wait').textContent).toContain('其他程序（python3.14）')
    expect(screen.queryByTestId('desktop-update-wait-end')).toBeNull()

    act(() => $shellUpdate.set(READY))
    expect(waitDialog()).toBeNull()
  })

  it('leaves a failed install after ending to the install overlay', async () => {
    inLocale('zh', <DesktopUpdatePill />)
    await confirmInstall(() => {
      $shellUpdate.set(held([CHILD]))

      return true
    })

    vi.mocked(applyDesktopUpdates).mockRejectedValueOnce(new Error('install_failed'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('desktop-update-wait-end'))
    })

    expect(waitDialog()).toBeNull()
  })

  it('does not reopen by itself once dismissed, and answers again on the next request', async () => {
    inLocale('zh', <DesktopUpdatePill />)
    await confirmInstall(() => {
      $shellUpdate.set(held([OTHER]))

      return true
    })
    fireEvent.click(screen.getByRole('button', { name: zh.wait.close }))
    await waitFor(() => expect(waitDialog()).toBeNull())

    act(() => $shellUpdate.set(held([TERMINAL])))
    expect(waitDialog()).toBeNull()

    await confirmInstall()
    expect(screen.getByTestId('desktop-update-wait').textContent).toContain('终端里运行的 hermes')
  })

  it('answers the same way for an engine update, which has no state in the main process to read', async () => {
    $shellUpdate.set(null)
    $runtimeUpdateCheck.set({ current: { key: 'old', version: 'v1' }, latest: { compatibilityNotes: null, key: 'new', version: 'v2' }, ok: true, updateAvailable: true })
    inLocale('zh', <DesktopUpdatePill />)
    expect(screen.queryByTestId('desktop-update-deferred')).toBeNull()

    await confirmInstall(() => {
      $runtimeUpdateWait.set({ reason: 'engine_holders', holders: [CHILD] })

      return true
    })

    expect(screen.getByTestId('desktop-update-wait').textContent).toContain('APEX 之前留下的后台进程在用 APEX 引擎')
    expect(screen.getByTestId('desktop-update-deferred').textContent).toContain('APEX 之前留下的后台进程在用 APEX 引擎')
    expect(screen.getByTestId('engine-holders-end')).toBeTruthy()
  })

  it('names an engine update\'s other waits on the card too', () => {
    $shellUpdate.set(null)
    $runtimeUpdateCheck.set({ current: { key: 'old', version: 'v1' }, latest: { compatibilityNotes: null, key: 'new', version: 'v2' }, ok: true, updateAvailable: true })
    $runtimeUpdateWait.set({ reason: 'gateway_busy', holders: null })
    inLocale('zh', <DesktopUpdatePill />)

    expect(screen.getByTestId('desktop-update-deferred').textContent).toBe(zh.deferred.gateway_busy)
  })

  it('prefers the app install\'s wait over an engine wait', () => {
    $shellUpdate.set(held([OTHER]))
    $runtimeUpdateWait.set({ reason: 'gateway_busy', holders: null })
    inLocale('zh', <DesktopUpdatePill />)

    expect(screen.getByTestId('desktop-update-deferred').textContent).toContain('其他程序（python3.14）')
  })

  it('says it in English', async () => {
    vi.mocked(applyDesktopUpdates).mockImplementationOnce(async () => {
      $shellUpdate.set(held([CHILD]))

      return true
    })
    inLocale('en', <DesktopUpdatePill />)
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install update' }))
    })

    const dialog = screen.getByTestId('desktop-update-wait')

    expect(dialog.textContent).toContain("APEX can't install yet")
    expect(dialog.textContent).toContain('A background process an earlier APEX left running is using the APEX engine. The update installs once it exits. It was left behind by APEX and can be ended.')
    expect(screen.getByTestId('desktop-update-wait-end').textContent).toBe('End and install')
  })
})

describe('the other update entries', () => {
  it('the About page answers a confirmed install the same way', async () => {
    inLocale('zh', <EngineUpdateSection />)
    await confirmInstall(() => {
      $shellUpdate.set(held([CHILD]))

      return true
    })

    expect(screen.getByTestId('desktop-update-wait').textContent).toContain('将结束：APEX 之前留下的后台进程（进程 4242）')
  })

  it('the About page names the holders of an engine update too', () => {
    $shellUpdate.set(null)
    $runtimeUpdateWait.set({ reason: 'engine_holders', holders: [ENGINE] })
    inLocale('zh', <EngineUpdateSection />)

    expect(screen.getByTestId('desktop-update-deferred').textContent).toContain('上一次 APEX 的引擎在用 APEX 引擎')
  })

  it('every entry that asks to install goes through the dialog that answers a wait', () => {
    const src = resolve(__dirname, '../../..')

    const entries = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name)

        if (entry.isDirectory()) {
          return entries(path)
        }

        return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) && readFileSync(path, 'utf8').includes('applyDesktopUpdates') ? [relative(src, path)] : []
      })

    const asking = entries(src).sort()

    // The note asks again after ending a leftover, from a wait already on screen.
    expect(asking).toEqual(['app/chat/sidebar/desktop-update-pill.tsx', 'app/chat/sidebar/engine-holders-note.tsx', 'app/command-center/index.tsx', 'app/settings/about-settings.tsx'])

    for (const entry of ['app/chat/sidebar/desktop-update-pill.tsx', 'app/command-center/index.tsx', 'app/settings/about-settings.tsx']) {
      expect(readFileSync(join(src, entry), 'utf8')).toContain('<DesktopUpdateConfirmDialog apply={applyDesktopUpdates}')
    }

    for (const entry of asking) {
      expect(readFileSync(join(src, entry), 'utf8')).not.toContain('onConfirm={() => applyDesktopUpdates()}')
    }
  })
})
