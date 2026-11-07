import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesModule from '@/hermes'
import { getSession } from '@/hermes'
import { openSecondaryCount } from '@/store/gateway'
import type * as GatewayModule from '@/store/gateway'
import { $mainThreadsByProfile, type MainThreadState } from '@/store/main-thread'
import { $activeGatewayProfile, $gatewaySwapTarget, $profiles } from '@/store/profile'
import { $projectTree } from '@/store/projects'
import { $cronSessions, $messagingSessions, $sessions } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { $toolViewMode } from '@/store/tool-view'
import type { SessionInfo } from '@/types/hermes'

import { cachedSessionRow, resolveSessionProfile, resolveStoredSession } from './utils'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<typeof HermesModule>()),
  getSession: vi.fn()
}))

vi.mock('@/store/gateway', async importActual => {
  const actual = await importActual<typeof GatewayModule>()

  return { ...actual, openSecondaryCount: vi.fn(actual.openSecondaryCount) }
})

const mockGetSession = vi.mocked(getSession)
const mockOpenSecondaryCount = vi.mocked(openSecondaryCount)

const session = (over: Partial<SessionInfo>): SessionInfo => over as SessionInfo

const profiles = (...names: string[]) => names.map(name => ({ name }) as never)

describe('resolveStoredSession profile ownership', () => {
  beforeEach(() => {
    $cronSessions.set([])
    $messagingSessions.set([])
    $sessions.set([])
    $projectTree.set([])
    $profiles.set(profiles('default', 'meta'))
    $activeGatewayProfile.set('meta')
    mockGetSession.mockReset()
  })

  afterEach(() => {
    $cronSessions.set([])
    $messagingSessions.set([])
    $sessions.set([])
    $projectTree.set([])
    $profiles.set([])
    $activeGatewayProfile.set('default')
  })

  it('returns a cached row that carries an owning profile', async () => {
    $sessions.set([session({ id: 's1', profile: 'default' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it.each([
    ['cron', $cronSessions],
    ['messaging', $messagingSessions]
  ])('resolves a %s sidebar row without duplicating it into regular sessions', async (_source, store) => {
    store.set([session({ id: 's1', profile: 'default' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    expect(mockGetSession).not.toHaveBeenCalled()
    expect($sessions.get()).toEqual([])
  })

  it('treats a profile-less cache hit as unresolved when multiple profiles exist', async () => {
    $sessions.set([session({ id: 's1' })])
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'default' }))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    // rung 2 (active profile) then rung 3 (stamped cross-profile probe)
    expect(mockGetSession).toHaveBeenNthCalledWith(1, 's1', 'meta')
    expect(mockGetSession).toHaveBeenNthCalledWith(2, 's1', 'default')
  })

  it('scopes the first by-id lookup so a miss does not skip the active profile', async () => {
    $activeGatewayProfile.set('brain')
    $profiles.set(profiles('default', 'brain'))
    mockGetSession.mockImplementation(async (id, profile) => {
      if (profile === 'brain') {
        return session({ id, profile: 'brain' })
      }

      throw new Error('404: Session not found')
    })

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('brain')
    expect(mockGetSession).toHaveBeenCalledWith('s1', 'brain')
    expect(mockGetSession).not.toHaveBeenCalledWith('s1')
    expect(mockGetSession).not.toHaveBeenCalledWith('s1', 'default')
  })

  it('accepts a profile-less cache hit for single-profile users', async () => {
    $profiles.set(profiles('default'))
    $sessions.set([session({ id: 's1' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.id).toBe('s1')
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('stamps the active profile on a bare by-id hit from an older backend', async () => {
    mockGetSession.mockResolvedValueOnce(session({ id: 's1' }))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('meta')
    expect(mockGetSession).toHaveBeenCalledWith('s1', 'meta')
    // the upserted cache row is owned too, so the next hit short-circuits
    expect($sessions.get().find(s => s.id === 's1')?.profile).toBe('meta')
  })

  it('probed desktop profile overrides a remote backend answering as its own "default"', async () => {
    // Per-profile remote override: Electron strips the desktop alias before
    // forwarding, so the standalone backend stamps its backend-local root.
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'default' }))
    $activeGatewayProfile.set('default')
    $profiles.set(profiles('default', 'meta'))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('meta')
    expect($sessions.get().find(s => s.id === 's1')?.profile).toBe('meta')
  })

  it('stamps the probed profile on a scoped hit from an older backend that omits it', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1' }))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    // the cached row is owned too — no unowned row is ever re-cached
    expect($sessions.get().find(s => s.id === 's1')?.profile).toBe('default')
  })

  it('resolveSessionProfile routes a default-profile session from a non-default gateway', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'default' }))

    await expect(resolveSessionProfile('s1')).resolves.toBe('default')
  })
})

// hc-1146 冷切换要等 30 秒: a switch opens the clicked assistant's thread at once,
// and its resume looks the tip up by id while the assistant being left is still
// the active profile. Each by-id probe can start that profile's engine, so a
// third assistant asked first held the conversation for its 30 s slot wait.
describe('resolveStoredSession asks a known assistant thread of its own assistant first', () => {
  const thread = (profile: string, ...ids: string[]): MainThreadState => ({
    ids,
    profile,
    rootId: ids[0],
    status: 'found',
    tipId: ids.at(-1) ?? null
  })

  type Mode = 'multi-bot' | 'multi-bot in developer mode' | 'one assistant' | 'single thread off'

  function setMode(mode: Mode) {
    setSingleThreadFlagForTest(mode !== 'single thread off')
    setMultiBotFlagForTest(mode === 'multi-bot' || mode === 'multi-bot in developer mode')
    $toolViewMode.set(mode === 'multi-bot in developer mode' ? 'technical' : 'product')
  }

  // Only `owner` holds the id; every other profile answers 404.
  function ownedBy(owner: string) {
    mockGetSession.mockImplementation(async (id, profile) => {
      if (profile === owner) {
        return session({ id, profile: owner })
      }

      throw new Error('404: Session not found')
    })
  }

  const probed = () => mockGetSession.mock.calls.map(([, profile]) => profile)
  const PROFILES_ORDER = ['apex-bot-2', 'default', 'apex-bot-3', 'apex-bot-4']

  beforeEach(() => {
    $cronSessions.set([])
    $messagingSessions.set([])
    $sessions.set([])
    $projectTree.set([])
    $profiles.set(profiles('default', 'apex-bot-2', 'apex-bot-3', 'apex-bot-4'))
    // The assistant being left: a switch has not landed yet.
    $activeGatewayProfile.set('apex-bot-2')
    $gatewaySwapTarget.set('apex-bot-4')
    $mainThreadsByProfile.set({
      'apex-bot-2': thread('apex-bot-2', 'root2'),
      'apex-bot-3': thread('apex-bot-3', 'root3'),
      'apex-bot-4': thread('apex-bot-4', 'root4', 'tip4')
    })
    mockGetSession.mockReset()
    mockOpenSecondaryCount.mockReturnValue(0)
  })

  afterEach(() => {
    setMultiBotFlagForTest(false)
    setSingleThreadFlagForTest(false)
    $toolViewMode.set('product')
    $mainThreadsByProfile.set({})
    $gatewaySwapTarget.set(null)
    $profiles.set([])
    $activeGatewayProfile.set('default')
    $sessions.set([])
    mockOpenSecondaryCount.mockReset()
  })

  it.each<[Mode, string, string[]]>([
    // The fix: the active profile, then the thread's own assistant — never a third one.
    ['multi-bot', 'tip4', ['apex-bot-2', 'apex-bot-4']],
    ['multi-bot', 'root4', ['apex-bot-2', 'apex-bot-4']],
    // Off the multi-bot path the order is $profiles' as before.
    ['multi-bot in developer mode', 'tip4', PROFILES_ORDER],
    ['one assistant', 'tip4', PROFILES_ORDER],
    ['single thread off', 'tip4', PROFILES_ORDER]
  ])('%s, switching to its assistant: looking up %s asks %j', async (mode, id, order) => {
    setMode(mode)
    ownedBy('apex-bot-4')

    const resolved = await resolveStoredSession(id)

    expect(resolved?.profile).toBe('apex-bot-4')
    expect(probed()).toEqual(order)
  })

  it('asks the owner first when its socket is already open, with no switch under way', async () => {
    setMode('multi-bot')
    $gatewaySwapTarget.set(null)
    mockOpenSecondaryCount.mockImplementation(profile => (profile === 'apex-bot-4' ? 1 : 0))
    ownedBy('apex-bot-4')

    await resolveStoredSession('tip4')

    expect(probed()).toEqual(['apex-bot-2', 'apex-bot-4'])
  })

  // Asked first, a cold owner's lookup would start its engine itself, ahead of a
  // switch still queued behind another one (and refused with one engine slot).
  it.each<[string, null | string]>([
    ['another switch is still under way', 'apex-bot-2'],
    ['nothing is starting it', null]
  ])('keeps the $profiles order while %s', async (_case, switchingTo) => {
    setMode('multi-bot')
    $gatewaySwapTarget.set(switchingTo)
    ownedBy('apex-bot-4')

    await resolveStoredSession('tip4')

    expect(probed()).toEqual(PROFILES_ORDER)
  })

  it('keeps the $profiles order for an id that is no assistant thread', async () => {
    setMode('multi-bot')
    ownedBy('apex-bot-4')

    await resolveStoredSession('elsewhere')

    expect(probed()).toEqual(PROFILES_ORDER)
  })

  it('falls back to the other profiles when the thread map is stale', async () => {
    setMode('multi-bot')
    // The window still holds tip4 as apex-bot-4's, but apex-bot-3 owns it now.
    ownedBy('apex-bot-3')

    const resolved = await resolveStoredSession('tip4')

    expect(resolved?.profile).toBe('apex-bot-3')
    expect(probed()).toEqual(['apex-bot-2', 'apex-bot-4', 'default', 'apex-bot-3'])
  })

  it('asks nothing more when the thread is the active assistant own', async () => {
    setMode('multi-bot')
    $activeGatewayProfile.set('apex-bot-4')
    $gatewaySwapTarget.set(null)
    ownedBy('apex-bot-4')

    await resolveStoredSession('tip4')

    expect(probed()).toEqual(['apex-bot-4'])
  })
})

describe('cachedSessionRow owner preference', () => {
  const projectNode = (sessions: SessionInfo[], preview: SessionInfo[] = []) =>
    ({
      previewSessions: preview,
      repos: [{ groups: [{ sessions }] }]
    }) as never

  beforeEach(() => {
    $cronSessions.set([])
    $messagingSessions.set([])
    $sessions.set([])
    $projectTree.set([])
    mockGetSession.mockReset()
  })

  afterEach(() => {
    $cronSessions.set([])
    $messagingSessions.set([])
    $sessions.set([])
    $projectTree.set([])
  })

  it('prefers a self-describing project-tree row over an ownerless Recents duplicate', () => {
    // The same conversation, listed twice: a legacy Recents row with no owner
    // and the profile-scoped project-tree row the gateway stamped. Picking the
    // Recents copy throws away the only routing information there is, and the
    // branch then creates its child on whichever backend is active.
    $sessions.set([session({ cwd: '/wrong', id: 's1' })])
    $projectTree.set([projectNode([session({ connection_id: 'pandora', cwd: '/right', id: 's1', profile: 'work' })])])

    expect(cachedSessionRow('s1')).toMatchObject({ connection_id: 'pandora', cwd: '/right', profile: 'work' })
  })

  it('finds a project-tree preview row when the session is in no other list', () => {
    $projectTree.set([projectNode([], [session({ connection_id: 'rigremote', id: 's1', profile: 'default' })])])

    expect(cachedSessionRow('s1')).toMatchObject({ connection_id: 'rigremote' })
  })

  it('keeps the plain Recents row when nothing carries an owner', () => {
    $sessions.set([session({ cwd: '/only', id: 's1' })])

    expect(cachedSessionRow('s1')).toMatchObject({ cwd: '/only' })
    expect(cachedSessionRow('missing')).toBeUndefined()
  })
})
