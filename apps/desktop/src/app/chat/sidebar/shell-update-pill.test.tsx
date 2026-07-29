// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopShellUpdateState } from '@/global'

const installShellUpdateMock = vi.fn<() => Promise<void>>()

// 真 atom + stub 掉 IPC 动作(同 runtime-update-pill.test.tsx 的做法):
// useStore 驱动的重渲染和生产一致,只有主进程桥被替换。
vi.mock('@/store/shell-update', async () => {
  const { atom } = await import('nanostores')

  return {
    $shellUpdate: atom<DesktopShellUpdateState | null>(null),
    initShellUpdateSubscription: vi.fn(),
    installShellUpdate: () => installShellUpdateMock()
  }
})

import { $shellUpdate } from '@/store/shell-update'

import { ShellUpdatePill } from './shell-update-pill'

const DOWNLOADED: DesktopShellUpdateState = {
  error: null,
  percent: 100,
  phase: 'downloaded',
  releaseNotes: null,
  version: '0.17.2'
}

beforeEach(() => {
  installShellUpdateMock.mockReset()
  $shellUpdate.set(null)
})

afterEach(() => {
  cleanup()
})

describe('ShellUpdatePill', () => {
  it('stays invisible before any state and through the states that need nothing from the user', () => {
    const { container } = render(<ShellUpdatePill />)

    expect(container.firstChild).toBeNull()

    // 检查中 / 无更新 / dev 停用 / 静默失败:一律不打扰。
    for (const phase of ['idle', 'disabled', 'checking', 'error'] as const) {
      $shellUpdate.set({ error: null, percent: null, phase, releaseNotes: null, version: '0.17.2' })
      expect(container.firstChild).toBeNull()
    }
  })

  // hc-605 的三态核心:发现 / 下载中 / 已就绪 三个阶段必须各自可辨,而且只有
  // 第三态可以点(前两态点了也没有可装的包)。
  describe('the three distinguishable states', () => {
    it('announces the found version and that the download is already running', () => {
      $shellUpdate.set({ error: null, percent: null, phase: 'available', releaseNotes: null, version: '0.17.2' })
      render(<ShellUpdatePill />)

      expect(screen.getByTestId('shell-update-pill').getAttribute('data-state')).toBe('available')
      expect(screen.getByText('New version v0.17.2 found')).toBeTruthy()
      expect(screen.getByText('Downloading in the background…')).toBeTruthy()
      // 没有可装的包 → 没有任何按钮可点。
      expect(screen.queryByRole('button')).toBeNull()
    })

    it('reports download progress with a determinate bar once electron-updater ticks', () => {
      $shellUpdate.set({ error: null, percent: 42.6, phase: 'downloading', releaseNotes: null, version: '0.17.2' })
      render(<ShellUpdatePill />)

      expect(screen.getByTestId('shell-update-pill').getAttribute('data-state')).toBe('downloading')
      expect(screen.getByText('Downloading v0.17.2')).toBeTruthy()
      expect(screen.getByText('43% downloaded')).toBeTruthy()

      const progress = screen.getByTestId('shell-update-progress')

      expect(progress.getAttribute('data-indeterminate')).toBeNull()
      expect((progress.firstElementChild as HTMLElement).style.width).toBe('43%')
      expect(screen.queryByRole('button')).toBeNull()
    })

    it('pulses indeterminate instead of claiming a fake 0% before the first progress tick', () => {
      $shellUpdate.set({ error: null, percent: null, phase: 'downloading', releaseNotes: null, version: '0.17.2' })
      render(<ShellUpdatePill />)

      const progress = screen.getByTestId('shell-update-progress')

      expect(progress.getAttribute('data-indeterminate')).toBe('true')
      expect((progress.firstElementChild as HTMLElement).style.width).toBe('')
      expect(screen.getByText('Downloading in the background…')).toBeTruthy()
      expect(screen.queryByText('0% downloaded')).toBeNull()
    })

    it('spells out that the ready update only installs after quitting, and offers the restart CTA', () => {
      $shellUpdate.set(DOWNLOADED)
      render(<ShellUpdatePill />)

      expect(screen.getByTestId('shell-update-pill').getAttribute('data-state')).toBe('ready')
      expect(screen.getByText('v0.17.2 is ready to install')).toBeTruthy()
      // 这一行是整张票的要害:不说这句,用户就一直开着应用等一个永远不来的更新。
      expect(screen.getByText('It only installs after you quit the app')).toBeTruthy()

      const cta = screen.getByRole('button') as HTMLButtonElement

      expect(cta.textContent).toContain('Restart now to update')
      expect(cta.disabled).toBe(false)
    })
  })

  it('keeps an existing v prefix as-is', () => {
    $shellUpdate.set({ ...DOWNLOADED, version: 'v0.17.2' })
    render(<ShellUpdatePill />)

    expect(screen.getByText('v0.17.2 is ready to install')).toBeTruthy()
  })

  it('names the update generically when electron-updater reported no version', () => {
    $shellUpdate.set({ ...DOWNLOADED, version: null })
    render(<ShellUpdatePill />)

    expect(screen.getByText('New version is ready to install')).toBeTruthy()
  })

  it('shows no notes line when the release shipped with none (hc-447 behavior, unchanged)', () => {
    $shellUpdate.set(DOWNLOADED)
    const { container } = render(<ShellUpdatePill />)

    expect(container.querySelector('.p5-update-pill-notes')).toBeNull()
  })

  it('renders the hand-authored release notes as human-readable text in the capsule (hc-447)', () => {
    $shellUpdate.set({ ...DOWNLOADED, releaseNotes: 'Faster startup and a fixed crash on launch.' })
    render(<ShellUpdatePill />)

    expect(screen.getByText('Faster startup and a fixed crash on launch.')).toBeTruthy()
  })

  it('collapses multi-line release notes to their first line in the compact pill (hc-447)', () => {
    $shellUpdate.set({ ...DOWNLOADED, releaseNotes: 'Faster startup.\n\nAlso fixed a crash on launch.' })
    render(<ShellUpdatePill />)

    expect(screen.getByText('Faster startup.')).toBeTruthy()
    expect(screen.queryByText('Also fixed a crash on launch.')).toBeNull()
  })

  it('exposes the full notes text via a title tooltip for the truncated/first-line preview (hc-447)', () => {
    const fullNotes = 'Faster startup.\n\nAlso fixed a crash on launch.'
    $shellUpdate.set({ ...DOWNLOADED, releaseNotes: fullNotes })
    render(<ShellUpdatePill />)

    expect(screen.getByText('Faster startup.').getAttribute('title')).toBe(fullNotes)
  })

  it('triggers quit + install from the CTA and locks it while quitting', () => {
    // 成功路径应用直接退出——promise 挂起不再 resolve 更贴近真实。
    installShellUpdateMock.mockReturnValue(new Promise<void>(() => {}))
    $shellUpdate.set(DOWNLOADED)
    render(<ShellUpdatePill />)

    fireEvent.click(screen.getByTestId('shell-update-install'))

    expect(installShellUpdateMock).toHaveBeenCalledTimes(1)

    const cta = screen.getByTestId('shell-update-install') as HTMLButtonElement

    expect(cta.disabled).toBe(true)
    expect(cta.textContent).toContain('Restarting…')
    expect(cta.querySelector('.animate-spin')).toBeTruthy()

    // 锁定中重复点击不再触发第二次安装。
    fireEvent.click(cta)

    expect(installShellUpdateMock).toHaveBeenCalledTimes(1)
  })

  it('re-arms the CTA when install fails (autoInstallOnAppQuit still covers exit)', async () => {
    installShellUpdateMock.mockRejectedValue(new Error('spawn failed'))
    $shellUpdate.set(DOWNLOADED)
    render(<ShellUpdatePill />)

    fireEvent.click(screen.getByTestId('shell-update-install'))

    await waitFor(() => {
      expect((screen.getByTestId('shell-update-install') as HTMLButtonElement).disabled).toBe(false)
    })
    expect(screen.getByTestId('shell-update-install').textContent).toContain('Restart now to update')
  })

  it('never quits the app on its own — nothing installs without a click on the CTA', () => {
    $shellUpdate.set(DOWNLOADED)
    render(<ShellUpdatePill />)

    // 用户可能正在对话中:渲染 ready 态本身绝不能触发 quitAndInstall。
    expect(installShellUpdateMock).not.toHaveBeenCalled()

    // 卡片本身不是点击目标,只有 CTA 是(避免误点直接关掉应用)。
    fireEvent.click(screen.getByTestId('shell-update-pill'))

    expect(installShellUpdateMock).not.toHaveBeenCalled()
  })
})
