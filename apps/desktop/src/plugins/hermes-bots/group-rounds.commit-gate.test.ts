import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as groupChat from './group-chat'
import type * as groupRounds from './group-rounds'
import { createGroupGateway, drain, runTimersInline, scriptedStorage } from './group-test-utils'
import type { GatewayOptions, ScriptedGateway, ScriptedTurn } from './group-test-utils'
import type { GroupChat, GroupMember, GroupMessage } from './types'

// #93127's commit gate drops a member turn that finished after the room epoch
// moved, but only when a NEWER send in the same thread will run that member
// again; otherwise the finished reply is the only copy and must be kept. A
// newer USER entry in the thread is not the same thing as a newer send: a
// mobile or second-Desktop post arrives through the gateway projection merge
// and an answered member question is echoed into the log, and neither one
// bumps the epoch or starts a drive. So the reply must survive whenever this
// Desktop did not itself start a new drive of the thread.

const { host } = vi.hoisted(() => ({ host: {} as Record<string, unknown> }))

vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock } = await import('./group-test-utils')

  return pluginSdkMock(host)
})

interface Room {
  chat: typeof groupChat
  gateway: ScriptedGateway
  rounds: typeof groupRounds
}

type SyncSnapshot = Parameters<typeof groupChat.mergeGroupChatSyncSnapshots>[0]

async function loadRoom(options: GatewayOptions = {}): Promise<Room> {
  vi.resetModules()
  const gateway = createGroupGateway(options)

  for (const key of Object.keys(host)) {
    delete host[key]
  }

  Object.assign(host, gateway.host)

  const [chat, rounds, shared] = await Promise.all([
    import('./group-chat'),
    import('./group-rounds'),
    import('./shared')
  ])

  shared.setPluginCtx(scriptedStorage(gateway.storage))

  return { chat, gateway, rounds }
}

const ROOM_ID = 'room-core'
const T = 'thread-1'
const S = 'thread-2'

const RESEARCH: GroupMember[] = [{ name: 'research', title: '' }]

const PAIR: GroupMember[] = [
  { name: 'research', title: '' },
  { name: 'builder', title: '' }
]

const user = (id: string, at: number, text: string, thread = T): GroupMessage => ({
  at,
  from: { kind: 'user', name: 'You' },
  id,
  text,
  thread
})

const member = (id: string, at: number, name: string, text: string, thread = T): GroupMessage => ({
  at,
  from: { kind: 'member', name },
  id,
  text,
  thread
})

function seededRoom(log: GroupMessage[], watermarks: Record<string, number> = {}): GroupChat {
  return {
    epoch: 0,
    log,
    members: PAIR,
    roomId: ROOM_ID,
    running: false,
    sessions: {},
    syncRevision: 0,
    watermarks
  } as unknown as GroupChat
}

function projection(log: GroupMessage[]): SyncSnapshot {
  return { rooms: { [`id:${ROOM_ID}`]: { log, members: [], name: 'Core', revision: 0, roomId: ROOM_ID } }, version: 3 }
}

/** Keep the timers that fire inside `act` (the newer send's handoff to its own
 *  drive, the mirror debounce) until `release()`, so the superseded drive
 *  finishes its turn before the new drive starts and the two never share the
 *  member's session at once. */
function holdTimers(act: () => void) {
  const held: Array<() => void> = []

  vi.stubGlobal('setTimeout', (fn: () => void) => {
    held.push(fn)

    return 0
  })

  try {
    act()
  } finally {
    runTimersInline()
  }

  return () => {
    for (const fn of held.splice(0)) {
      fn()
    }
  }
}

type MidTurn = (room: Room) => Promise<(() => void) | void>

interface Scenario {
  firstSend: string
  firstReply: string
  members: GroupMember[]
  /** Whose first prompt the mid-turn events interrupt. */
  midTurnMember: string
  seed: GroupChat
}

const ROUND: Scenario = {
  firstSend: 'first question',
  firstReply: 'research answer',
  members: RESEARCH,
  midTurnMember: 'research',
  seed: seededRoom([])
}

/** A user send starts thread T's drive; `midTurnMember`'s first prompt runs
 *  `midTurn` before that member answers `firstReply`. Every other turn answers
 *  by what it was shown. Returns once the T drive and whatever drive the
 *  mid-turn events started have both finished. */
async function runWithMidTurn(midTurn: MidTurn, scenario: Scenario = ROUND) {
  const held: Array<() => void> = []
  let interrupted = false

  const room: Room = await loadRoom({
    turn: async ({ profile, prompt }: ScriptedTurn) => {
      if (profile === scenario.midTurnMember && !interrupted) {
        interrupted = true
        const release = await midTurn(room)

        if (release) {
          held.push(release)
        }

        return scenario.firstReply
      }

      return prompt.includes('side topic') ? 'side answer' : prompt.includes('follow-up') ? 'second answer' : '(pass)'
    }
  })

  room.chat.$groupChats.set({ Core: scenario.seed })
  room.rounds.sendToGroupChat('Core', scenario.members, scenario.firstSend, T)
  // Drives run on inline timers, so each settles within a few ticks. The
  // room's `running` flag cannot say when: a gateway switch clears it.
  await drain(() => true, 50)
  expect(interrupted).toBe(true)
  held.forEach(release => release())
  await drain(() => true, 50)

  return room
}

/** Thread T's member replies, in log order. */
function repliesIn(room: Room, thread: string) {
  return room.chat.$groupChats
    .get()
    .Core.log.filter(entry => entry.from.kind === 'member' && (entry.thread || 'legacy') === thread)
    .map(entry => entry.text)
}

/** Another device's post into T, as the gateway projection now holds it. */
function stageRemotePostIntoT(room: Room) {
  const current = room.chat.$groupChats.get().Core.log

  room.gateway.uiMeta['hermes-bots-groups'] = projection([
    ...current,
    user('remote-1', current[current.length - 1].at + 1, 'mobile question')
  ])
}

async function pullRemotePost(room: Room) {
  expect(await room.chat.pullGroupChatServerState('local')).toBe(true)
  expect(room.chat.$groupChats.get().Core.log.filter(entry => entry.id === 'remote-1')).toHaveLength(1)
}

/** A mobile/second-Desktop post into T, pulled the way every sync flush pulls. */
async function remotePostIntoT(room: Room) {
  stageRemotePostIntoT(room)
  await pullRemotePost(room)
}

/** What group-chat-parts.tsx appends when the user answers a member's
 *  clarify/approval card: a user entry in the member's thread, no drive. */
function answerEchoIntoT(room: Room) {
  room.chat.appendGroupChatEntry('Core', { kind: 'user', name: 'You' }, 'use the ops account', T)
}

const sendInto = (room: Room, thread: string, text: string, members = RESEARCH) =>
  holdTimers(() => {
    room.rounds.sendToGroupChat('Core', members, text, thread)
  })

beforeEach(() => {
  runTimersInline()
  // Every entry gets its own millisecond: same-millisecond entries can swap
  // places on the next projection merge (hc-915), which would move the
  // index watermarks under these tests for a reason they are not about.
  // Steps of 10 leave room for the remote post stamped one after the tail.
  let clock = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10))
})

describe('a finished turn is dropped only when this Desktop re-drives its thread', () => {
  it.each<[string, MidTurn]>([
    [
      'a remote post into the thread, then a local send into another thread',
      async room => {
        await remotePostIntoT(room)

        return sendInto(room, S, 'side topic')
      }
    ],
    [
      'a local send into another thread, then a remote post into the thread',
      async room => {
        const release = sendInto(room, S, 'side topic')
        await remotePostIntoT(room)

        return release
      }
    ],
    [
      'an answered member question echoed into the thread, then a local send into another thread',
      async room => {
        answerEchoIntoT(room)

        return sendInto(room, S, 'side topic')
      }
    ],
    [
      'a remote post into the thread pulled by a gateway switch',
      async room => {
        stageRemotePostIntoT(room)
        room.chat.handleSessionsGatewayTransition()
        // The switch pulls in the background; land it before the turn ends.
        await pullRemotePost(room)
      }
    ],
    // Controls: these never carried a user entry into T, so the epoch move
    // alone already kept the reply.
    ['a local send into another thread', async room => sendInto(room, S, 'side topic')],
    ['a remote post into the thread with no epoch move', async room => remotePostIntoT(room)]
  ])('keeps the reply after %s', async (_case, midTurn) => {
    const room = await runWithMidTurn(midTurn)

    expect(repliesIn(room, T)).toEqual(['research answer'])
    // Exactly one turn ever ran in T: nothing would have regenerated the reply.
    expect(room.gateway.calls.filter(call => call.prompt.includes('first question'))).toHaveLength(1)
  })

  // The re-drive record is runtime state on the room, so every write that
  // replaces the room record between the send and the gate must carry it.
  it.each<[string, MidTurn]>([
    ['a local send into the thread', async room => sendInto(room, T, 'follow-up')],
    [
      'a remote post into the thread, then a local send into it',
      async room => {
        await remotePostIntoT(room)

        return sendInto(room, T, 'follow-up')
      }
    ],
    [
      'a local send into the thread, then a remote post pulled into it',
      async room => {
        const release = sendInto(room, T, 'follow-up')
        await remotePostIntoT(room)

        return release
      }
    ],
    [
      'a local send into the thread, then a gateway switch',
      async room => {
        const release = sendInto(room, T, 'follow-up')
        room.chat.handleSessionsGatewayTransition()

        return release
      }
    ]
  ])('drops the superseded reply after %s, and the re-drive delivers once', async (_case, midTurn) => {
    const room = await runWithMidTurn(midTurn)

    expect(repliesIn(room, T)).toEqual(['second answer'])
    expect(room.gateway.calls).toHaveLength(2)
    expect(room.gateway.calls[1].prompt).toContain('first question')
    expect(room.gateway.calls[1].prompt).toContain('follow-up')
  })
})

describe('a continuation turn takes the same commit decision', () => {
  // research handed off to @builder; the user's send names only research,
  // who passes. builder's only way in is the continuation turn for the
  // unanswered handoff (#94478).
  const HANDOFF: Scenario = {
    firstSend: '@research status?',
    firstReply: 'verified',
    members: PAIR,
    midTurnMember: 'builder',
    seed: seededRoom([member('handoff', 1_000, 'research', '@builder please verify')], { [`${T}::research`]: 1 })
  }

  it('keeps a continuation reply after a local send into another thread', async () => {
    const room = await runWithMidTurn(async live => sendInto(live, S, 'side topic', PAIR), HANDOFF)

    expect(room.gateway.calls.slice(0, 2).map(call => call.profile)).toEqual(['research', 'builder'])
    expect(repliesIn(room, T)).toEqual(['@builder please verify', 'verified'])
  })

  it('drops a continuation reply when a local send re-drives the same thread', async () => {
    const room = await runWithMidTurn(async live => sendInto(live, T, 'follow-up', PAIR), HANDOFF)

    expect(room.gateway.calls.slice(0, 2).map(call => call.profile)).toEqual(['research', 'builder'])
    expect(repliesIn(room, T)).not.toContain('verified')
  })
})
