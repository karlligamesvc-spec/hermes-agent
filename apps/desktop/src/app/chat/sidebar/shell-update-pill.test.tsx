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

const DOWNLOADED: DesktopShellUpdateState = { error: null, percent: 100, phase: 'downloaded', releaseNotes: null, version: '0.16.1' }

beforeEach(() => {
  installShellUpdateMock.mockReset()
  $shellUpdate.set(null)
})

afterEach(() => {
  cleanup()
})

describe('ShellUpdatePill', () => {
  it('stays invisible before any state and through the silent phases (checking/downloading)', () => {
    const { container } = render(<ShellUpdatePill />)

    expect(container.firstChild).toBeNull()

    // 下载中不打扰:downloading 也不出胶囊。
    for (const phase of ['idle', 'disabled', 'checking', 'available', 'downloading', 'error'] as const) {
      $shellUpdate.set({ error: null, percent: 10, phase, releaseNotes: null, version: '0.16.1' })
      expect(container.firstChild).toBeNull()
    }
  })

  it('offers "Restart to update vX.Y.Z" once the update is downloaded', () => {
    $shellUpdate.set(DOWNLOADED)
    render(<ShellUpdatePill />)

    const button = screen.getByRole('button') as HTMLButtonElement

    expect(button.disabled).toBe(false)
    // 裸 semver 展示成 v 前缀(Codex 同款文案)。
    expect(screen.getByText('Restart to update v0.16.1')).toBeTruthy()
  })

  it('keeps an existing v prefix as-is', () => {
    $shellUpdate.set({ ...DOWNLOADED, version: 'v0.17.0' })
    render(<ShellUpdatePill />)

    expect(screen.getByText('Restart to update v0.17.0')).toBeTruthy()
  })

  it('shows no notes line when the release shipped with none (pre-hc-447 behavior, unchanged)', () => {
    $shellUpdate.set(DOWNLOADED)
    const { container } = render(<ShellUpdatePill />)

    expect(container.querySelector('.p5-update-pill-notes')).toBeNull()
  })

  it('renders the hand-authored release notes as human-readable text in the capsule', () => {
    $shellUpdate.set({ ...DOWNLOADED, releaseNotes: 'Faster startup and a fixed crash on launch.' })
    render(<ShellUpdatePill />)

    expect(screen.getByText('Faster startup and a fixed crash on launch.')).toBeTruthy()
  })

  it('collapses multi-line release notes to their first line in the compact pill', () => {
    $shellUpdate.set({ ...DOWNLOADED, releaseNotes: 'Faster startup.\n\nAlso fixed a crash on launch.' })
    render(<ShellUpdatePill />)

    expect(screen.getByText('Faster startup.')).toBeTruthy()
    expect(screen.queryByText('Also fixed a crash on launch.')).toBeNull()
  })

  it('exposes the full notes text via a title tooltip for the truncated/first-line preview', () => {
    const fullNotes = 'Faster startup.\n\nAlso fixed a crash on launch.'
    $shellUpdate.set({ ...DOWNLOADED, releaseNotes: fullNotes })
    render(<ShellUpdatePill />)

    expect(screen.getByText('Faster startup.').getAttribute('title')).toBe(fullNotes)
  })

  it('installs on click and locks the pill while quitting', async () => {
    // 成功路径应用直接退出——promise 挂起不再 resolve 更贴近真实。
    installShellUpdateMock.mockReturnValue(new Promise<void>(() => {}))
    $shellUpdate.set(DOWNLOADED)
    render(<ShellUpdatePill />)

    fireEvent.click(screen.getByRole('button'))

    expect(installShellUpdateMock).toHaveBeenCalledTimes(1)

    const button = screen.getByRole('button') as HTMLButtonElement

    expect(button.disabled).toBe(true)
    expect(button.getAttribute('data-state')).toBe('applying')
    expect(button.querySelector('.animate-spin')).toBeTruthy()

    // 锁定中重复点击不再触发第二次安装。
    fireEvent.click(button)

    expect(installShellUpdateMock).toHaveBeenCalledTimes(1)
  })

  it('re-arms the pill when install fails (autoInstallOnAppQuit still covers exit)', async () => {
    installShellUpdateMock.mockRejectedValue(new Error('spawn failed'))
    $shellUpdate.set(DOWNLOADED)
    render(<ShellUpdatePill />)

    fireEvent.click(screen.getByRole('button'))

    await waitFor(() => {
      expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false)
    })
    expect(screen.getByRole('button').getAttribute('data-state')).toBe('idle')
  })
})
