import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopTeamResult } from '@/global'

import { $accountTeam, loadAccountTeam, teamFor } from './account-team'

const STUDIO = { isAdmin: false, name: '星河传媒', status: 'active' } as const

type TeamBridge = () => Promise<DesktopTeamResult>

function installBridge(team: TeamBridge | undefined) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = team ? { managed: { team } } : undefined
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(r => {
    resolve = r
  })

  return { promise, resolve }
}

describe('account team cache (hc-971)', () => {
  beforeEach(() => {
    $accountTeam.set({ accountId: null, team: null })
  })

  afterEach(() => {
    installBridge(undefined)
    vi.restoreAllMocks()
  })

  it('reads the team for the signed-in account', async () => {
    installBridge(async () => ({ ok: true, team: STUDIO }))
    await loadAccountTeam('acc-1')
    expect(teamFor($accountTeam.get(), 'acc-1')).toEqual(STUDIO)
  })

  it('never shows one account the team of another', async () => {
    const first = deferred<DesktopTeamResult>()
    installBridge(vi.fn<TeamBridge>().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ok: true, team: null }))

    const late = loadAccountTeam('acc-1')
    await loadAccountTeam('acc-2')
    first.resolve({ ok: true, team: STUDIO })
    await late

    expect($accountTeam.get()).toEqual({ accountId: 'acc-2', team: null })
    expect(teamFor($accountTeam.get(), 'acc-1')).toBeNull()
  })

  it('never hands the menu a team cached for a different account', () => {
    // The render between an account switch and the next read must not show the old team.
    expect(teamFor({ accountId: 'acc-1', team: STUDIO }, 'acc-2')).toBeNull()
    expect(teamFor({ accountId: 'acc-1', team: STUDIO }, null)).toBeNull()
    expect(teamFor({ accountId: 'acc-1', team: STUDIO }, 'acc-1')).toEqual(STUDIO)
  })

  it('drops a team it can no longer confirm', async () => {
    installBridge(async () => ({ ok: true, team: STUDIO }))
    await loadAccountTeam('acc-1')

    installBridge(async () => ({ message: 'FETCH_FAILED', ok: false, team: null }))
    await loadAccountTeam('acc-1')
    expect(teamFor($accountTeam.get(), 'acc-1')).toBeNull()

    installBridge(async () => {
      throw new Error('bridge down')
    })
    await expect(loadAccountTeam('acc-1')).resolves.toBeUndefined()
    expect(teamFor($accountTeam.get(), 'acc-1')).toBeNull()
  })

  it('shares one read per account and asks nothing of an older main process', async () => {
    const team = vi.fn<TeamBridge>(async () => ({ ok: true, team: STUDIO }))
    installBridge(team)
    await Promise.all([loadAccountTeam('acc-1'), loadAccountTeam('acc-1')])
    expect(team).toHaveBeenCalledTimes(1)

    installBridge(undefined)
    await loadAccountTeam('acc-2')
    expect($accountTeam.get()).toEqual({ accountId: 'acc-2', team: null })
    await loadAccountTeam(null)
    expect($accountTeam.get()).toEqual({ accountId: null, team: null })
  })
})
