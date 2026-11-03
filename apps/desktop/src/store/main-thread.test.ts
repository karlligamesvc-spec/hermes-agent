import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeSessionInfo } from '@/test/session-info'

import {
  $mainThread,
  $mainThreadsByProfile,
  $segmentStarts,
  $threadSegmentStarts,
  isMainThreadStoredId,
  MAIN_THREAD_TITLE,
  noteMainThreadClaimed,
  recordSegmentStart,
  resetMainThreadForTest,
  resolveMainThread,
  resolveProfileThread
} from './main-thread'
import { $activeSessionStoredIdRotation } from './session'

function gatewayAnswering(rows: unknown[] | Error) {
  return vi.fn(async (_method: string, _params?: Record<string, unknown>) => {
    if (rows instanceof Error) {
      throw rows
    }

    return { sessions: rows } as never
  })
}

afterEach(() => {
  resetMainThreadForTest()
  $activeSessionStoredIdRotation.set(null)
})

describe('hc-1014 the thread is found by its title, never by a stored id', () => {
  it('asks for the exact title, hidden rows included, on the active profile', async () => {
    const request = gatewayAnswering([])

    await resolveMainThread(request, 'default')

    expect(request).toHaveBeenCalledWith('session.list', {
      include_hidden: true,
      limit: 200,
      profile: 'default',
      title: MAIN_THREAD_TITLE
    })
  })

  it('opens the live tip of a compressed thread and keeps the root as its identity', async () => {
    const state = await resolveMainThread(
      gatewayAnswering([{ id: 'root-1', resolved_id: 'tip-3', title: MAIN_THREAD_TITLE }]),
      'default'
    )

    expect(state).toMatchObject({ profile: 'default', rootId: 'root-1', status: 'found', tipId: 'tip-3' })
    expect(state.ids).toEqual(['root-1', 'tip-3'])
  })

  it('matches the lineage root title, and ignores a row that only looks similar', async () => {
    expect(
      (
        await resolveMainThread(
          gatewayAnswering([{ id: 'r', root_title: MAIN_THREAD_TITLE, title: '改过的名字' }]),
          'a'
        )
      ).status
    ).toBe('found')
    expect((await resolveMainThread(gatewayAnswering([{ id: 'x', title: 'APEX 主线 2' }]), 'b')).status).toBe('absent')
  })

  it('fails closed: a failed lookup is an error, never "no thread yet"', async () => {
    expect((await resolveMainThread(gatewayAnswering(new Error('socket closed')), 'default')).status).toBe('error')
  })

  it('never downgrades a thread it holds because one later read failed or came back empty', async () => {
    await resolveMainThread(gatewayAnswering([{ id: 'root-1', title: MAIN_THREAD_TITLE }]), 'default')

    expect((await resolveMainThread(gatewayAnswering(new Error('busy')), 'default')).status).toBe('found')
    expect((await resolveMainThread(gatewayAnswering([]), 'default')).rootId).toBe('root-1')
  })

  it('lands only the newest lookup, so a profile switch mid-read keeps the new profile', async () => {
    let answerOld: (value: unknown) => void = () => undefined
    const slow = vi.fn(() => new Promise(resolve => (answerOld = resolve))) as never

    const first = resolveMainThread(slow, 'work')
    await resolveMainThread(gatewayAnswering([]), 'default')
    answerOld({ sessions: [{ id: 'work-root', title: MAIN_THREAD_TITLE }] })
    await first

    expect($mainThread.get()).toMatchObject({ profile: 'default', status: 'absent' })
  })

  it('takes a claimed first session as the thread', () => {
    noteMainThreadClaimed('default', 'new-1')

    expect($mainThread.get()).toMatchObject({ rootId: 'new-1', status: 'found', tipId: 'new-1' })
  })
})

describe('hc-1014 which stored ids are the thread', () => {
  it('recognizes every segment of the lineage through the session list', async () => {
    await resolveMainThread(
      gatewayAnswering([{ id: 'root-1', resolved_id: 'tip-2', title: MAIN_THREAD_TITLE }]),
      'default'
    )

    const sessions = [
      makeSessionInfo({ _lineage_ids: ['root-1', 'mid', 'tip-2'], _lineage_root_id: 'root-1', id: 'tip-2' }),
      makeSessionInfo({ id: 'older-chat' })
    ]

    const state = $mainThread.get()

    expect(isMainThreadStoredId('tip-2', state, sessions)).toBe(true)
    expect(isMainThreadStoredId('mid', state, sessions)).toBe(true)
    expect(isMainThreadStoredId('older-chat', state, sessions)).toBe(false)
    expect(isMainThreadStoredId(null, state, sessions)).toBe(false)
    expect(isMainThreadStoredId('root-1', { ...state, status: 'absent' }, sessions)).toBe(false)
  })

  it('follows a rotation onto a tip the session list has not seen yet', async () => {
    await resolveMainThread(gatewayAnswering([{ id: 'root-1', title: MAIN_THREAD_TITLE }]), 'default')

    $activeSessionStoredIdRotation.set({
      nextStoredSessionId: 'tip-new',
      previousStoredSessionId: 'root-1',
      runtimeSessionId: 'rt-1'
    })

    expect(isMainThreadStoredId('tip-new', $mainThread.get(), [])).toBe(true)
    expect($mainThread.get().tipId).toBe('tip-new')
  })

  it('ignores a rotation of some other conversation', async () => {
    await resolveMainThread(gatewayAnswering([{ id: 'root-1', title: MAIN_THREAD_TITLE }]), 'default')

    $activeSessionStoredIdRotation.set({
      nextStoredSessionId: 'other-tip',
      previousStoredSessionId: 'other-root',
      runtimeSessionId: 'rt-2'
    })

    expect(isMainThreadStoredId('other-tip', $mainThread.get(), [])).toBe(false)
  })
})

describe('hc-1014 segment starts', () => {
  it('are kept per thread root and read for the thread this window holds', () => {
    noteMainThreadClaimed('default', 'root-1')
    recordSegmentStart('root-1', 100)
    recordSegmentStart('root-1', 200)
    recordSegmentStart('someone-else', 300)

    expect($threadSegmentStarts.get()).toEqual([100, 200])
    expect($segmentStarts.get()['someone-else']).toEqual([300])
  })
})

describe('hc-1077 every assistant’s thread, by profile', () => {
  const tip = (rows: unknown[]) => gatewayAnswering(rows)

  it('keeps the active profile’s thread under its profile too', async () => {
    await resolveMainThread(tip([{ id: 'apex-root', resolved_id: 'apex-tip', title: MAIN_THREAD_TITLE }]), 'default')

    expect($mainThreadsByProfile.get().default).toMatchObject({
      rootId: 'apex-root',
      status: 'found',
      tipId: 'apex-tip'
    })
  })

  it('looks another assistant’s thread up by name on its own profile, without touching the active one', async () => {
    noteMainThreadClaimed('default', 'apex-root')

    const request = tip([{ id: 'writer-root', title: MAIN_THREAD_TITLE }])
    const state = await resolveProfileThread(request, 'writer')

    expect(request).toHaveBeenCalledWith('session.list', {
      include_hidden: true,
      limit: 200,
      profile: 'writer',
      title: MAIN_THREAD_TITLE
    })
    expect(state).toMatchObject({ profile: 'writer', rootId: 'writer-root', status: 'found' })
    expect($mainThread.get()).toMatchObject({ profile: 'default', rootId: 'apex-root' })
    expect(Object.keys($mainThreadsByProfile.get()).sort()).toEqual(['default', 'writer'])
  })

  it('never downgrades a thread it holds for a background assistant', async () => {
    await resolveProfileThread(tip([{ id: 'writer-root', title: MAIN_THREAD_TITLE }]), 'writer')
    await resolveProfileThread(gatewayAnswering(new Error('offline')), 'writer')
    await resolveProfileThread(tip([]), 'writer')

    expect($mainThreadsByProfile.get().writer).toMatchObject({ rootId: 'writer-root', status: 'found' })
  })

  it('records an assistant with no thread yet as absent, and a failed read as an error', async () => {
    await resolveProfileThread(tip([]), 'fresh')
    await resolveProfileThread(gatewayAnswering(new Error('offline')), 'down')

    expect($mainThreadsByProfile.get().fresh?.status).toBe('absent')
    expect($mainThreadsByProfile.get().down?.status).toBe('error')
  })

  it('follows a background assistant’s rotation onto its new tip', async () => {
    noteMainThreadClaimed('default', 'apex-root')
    await resolveProfileThread(tip([{ id: 'writer-root', title: MAIN_THREAD_TITLE }]), 'writer')

    $activeSessionStoredIdRotation.set({
      nextStoredSessionId: 'writer-tip-2',
      previousStoredSessionId: 'writer-root',
      runtimeSessionId: 'rt-writer'
    })

    expect($mainThreadsByProfile.get().writer).toMatchObject({
      ids: ['writer-root', 'writer-tip-2'],
      rootId: 'writer-root',
      tipId: 'writer-tip-2'
    })
    expect($mainThread.get().tipId).toBe('apex-root')
  })
})
