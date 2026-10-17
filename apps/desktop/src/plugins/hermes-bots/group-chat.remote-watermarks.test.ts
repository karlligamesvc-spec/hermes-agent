import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as groupChat from './group-chat'
import type * as groupRounds from './group-rounds'
import { createGroupGateway, drain, runTimersInline, scriptedStorage } from './group-test-utils'
import type { GatewayOptions, ScriptedGateway } from './group-test-utils'
import type * as groupTurns from './group-turns'
import type { GroupChat, GroupMember, GroupMessage } from './types'

// A member's watermark is an INDEX into the room log: its next delta is
// `log.slice(watermark)` narrowed to the thread. Entries from another device
// (mobile, a second Desktop) reach this log through the gateway projection
// merge, at whatever moment the next pull happens. If that merge places a
// remote entry in front of entries a member already saw, the index now points
// at the wrong entry: the member is shown something it already saw and never
// shown the remote one. A remote entry that lands while a member's turn is in
// flight must likewise stay in that member's next delta.

const { host } = vi.hoisted(() => ({ host: {} as Record<string, unknown> }))

vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock } = await import('./group-test-utils')

  return pluginSdkMock(host)
})

interface Room {
  chat: typeof groupChat
  gateway: ScriptedGateway
  rounds: typeof groupRounds
  turns: typeof groupTurns
}

type SyncSnapshot = Parameters<typeof groupChat.mergeGroupChatSyncSnapshots>[0]

async function loadRoom(options: GatewayOptions = {}): Promise<Room> {
  vi.resetModules()
  const gateway = createGroupGateway(options)

  for (const key of Object.keys(host)) {
    delete host[key]
  }

  Object.assign(host, gateway.host)

  const [chat, rounds, turns, shared] = await Promise.all([
    import('./group-chat'),
    import('./group-rounds'),
    import('./group-turns'),
    import('./shared')
  ])

  shared.setPluginCtx(scriptedStorage(gateway.storage))

  return { chat, gateway, rounds, turns }
}

beforeEach(() => {
  runTimersInline()
})

const ROOM_ID = 'room-core'
const T = 'thread-1'
const S = 'thread-2'

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

/** The projection another device published: this room's entries as the
 *  gateway holds them, plus whatever that device added. */
function projection(log: GroupMessage[]): SyncSnapshot {
  return { rooms: { [`id:${ROOM_ID}`]: { log, members: [], name: 'Core', revision: 0, roomId: ROOM_ID } }, version: 3 }
}

function seededRoom(log: GroupMessage[], watermarks: Record<string, number>): GroupChat {
  return {
    epoch: 0,
    log,
    members: [{ name: 'research' }, { name: 'builder' }],
    roomId: ROOM_ID,
    running: false,
    sessions: {},
    syncRevision: 0,
    watermarks
  } as unknown as GroupChat
}

/** What a member is shown on its next turn, read the way both delta sites
 *  read it (group-round-members.ts): slice at the watermark, keep the thread. */
function nextDelta(room: GroupChat, thread: string, memberKey: string) {
  const seen = room.watermarks[`${thread}::${memberKey}`] || 0

  return room.log
    .slice(seen)
    .filter(entry => (entry.thread || 'legacy') === thread)
    .map(entry => entry.text)
}

/** The delta lines of a turn prompt, between its header and the rules. */
function promptDelta(prompt: string) {
  const lines = prompt.split('\n')
  const start = lines.indexOf('New messages in the room since your last turn (oldest first):') + 1

  return lines.slice(start, lines.indexOf('', start)).map(line => line.trim())
}

describe('remote merge keeps member watermarks on the entries they name', () => {
  // u1 → research answered (m1) → builder answered (m2). research has seen
  // u1 and m1, builder has seen everything. Each row merges one remote entry
  // and states exactly what each member must be shown next: everything it
  // had not seen before the merge plus the remote entry when it is in that
  // member's thread, and nothing it had already seen.
  const local = () => [
    user('u1', 1_000, 'first question'),
    member('m1', 3_000, 'research', 'research answer'),
    member('m2', 4_000, 'builder', 'builder answer')
  ]

  const watermarks = { [`${T}::builder`]: 3, [`${T}::research`]: 2 }

  it.each([
    [
      'older than entries both members already saw',
      user('r1', 2_000, 'mobile question'),
      { builder: ['mobile question'], research: ['builder answer', 'mobile question'] }
    ],
    [
      'older than the whole room',
      user('r1', 500, 'mobile question'),
      { builder: ['mobile question'], research: ['builder answer', 'mobile question'] }
    ],
    [
      'in the same millisecond as an entry a member saw',
      user('r1', 3_000, 'mobile question'),
      { builder: ['mobile question'], research: ['builder answer', 'mobile question'] }
    ],
    [
      'in another thread, older than both watermarks',
      user('r1', 2_000, 'mobile side question', S),
      { builder: [], research: ['builder answer'] }
    ],
    // Control: an entry newer than the room tail never moved anything.
    [
      'newer than the whole room',
      user('r1', 5_000, 'mobile question'),
      { builder: ['mobile question'], research: ['builder answer', 'mobile question'] }
    ]
  ])('a remote entry %s', async (_case, remote, expected) => {
    const { chat } = await loadRoom()
    const before = local()

    const merged = chat.mergeRemoteGroupChatSnapshotIntoRooms(
      projection([...before, remote].sort((a, b) => a.at - b.at)),
      { Core: seededRoom(before, watermarks) }
    ).Core

    // Which entries, not their order: the order an arrival is shown in is
    // the prompt tests' business below.
    expect(merged.log.map(entry => entry.id).sort()).toEqual(['m1', 'm2', 'r1', 'u1'])
    expect(nextDelta(merged, T, 'research').sort()).toEqual(expected.research.sort())
    expect(nextDelta(merged, T, 'builder').sort()).toEqual(expected.builder.sort())
  })

  it('shows the member a remote entry on its next turn, and nothing it already saw', async () => {
    const room = await loadRoom({ turn: () => 'research follow-up answer' })
    const members: GroupMember[] = [{ name: 'research', title: '' }]

    room.chat.$groupChats.set({
      Core: seededRoom(
        [user('u1', 1_000, 'first question'), member('m1', 3_000, 'research', 'research answer')],
        { [`${T}::research`]: 2 }
      )
    })

    // Another device posted into the thread before research answered, but
    // this Desktop only pulls it now.
    room.gateway.uiMeta['hermes-bots-groups'] = projection([
      user('u1', 1_000, 'first question'),
      user('r1', 2_000, 'mobile question'),
      member('m1', 3_000, 'research', 'research answer')
    ])

    expect(await room.chat.pullGroupChatServerState('local')).toBe(true)

    room.rounds.sendToGroupChat('Core', members, 'follow-up', T)
    await drain(() => Boolean(room.chat.$groupChats.get().Core?.running))

    expect(promptDelta(room.gateway.calls[0].prompt)).toEqual([
      'You (user): mobile question',
      'You (user): follow-up'
    ])
  })

  it('keeps a remote entry that lands mid-turn in the member’s next delta', async () => {
    const room: Room = await loadRoom({
      turn: async ({ n }) => {
        if (n === 1) {
          // Another device posts into the thread while research is thinking,
          // and the read-back after some other write pulls it in.
          const current = room.chat.$groupChats.get().Core.log

          room.gateway.uiMeta['hermes-bots-groups'] = projection([
            ...current,
            user('r1', current[current.length - 1].at + 1, 'mobile mid-turn question')
          ])
          await room.chat.pullGroupChatServerState('local')

          return 'research first answer'
        }

        return 'research second answer'
      }
    })

    const members: GroupMember[] = [{ name: 'research', title: '' }]

    room.chat.$groupChats.set({ Core: seededRoom([], {}) })
    room.rounds.sendToGroupChat('Core', members, 'first question', T)
    await drain(() => Boolean(room.chat.$groupChats.get().Core?.running))

    expect(promptDelta(room.gateway.calls[0].prompt)).toEqual(['You (user): first question'])
    // The second turn is research being shown the entry it never saw, next
    // to its own reply that landed after it.
    expect(room.gateway.calls).toHaveLength(2)
    expect(promptDelta(room.gateway.calls[1].prompt)).toEqual([
      'You (user): mobile mid-turn question',
      'research (you): research first answer'
    ])
  })
  it('keeps a remote entry that lands during a continuation turn in that member’s next delta', async () => {
    let builderTurns = 0

    const room: Room = await loadRoom({
      turn: async ({ profile }) => {
        if (profile === 'builder' && ++builderTurns === 1) {
          const current = room.chat.$groupChats.get().Core.log

          room.gateway.uiMeta['hermes-bots-groups'] = projection([
            ...current,
            user('r1', current[current.length - 1].at + 1, 'mobile mid-turn question')
          ])
          await room.chat.pullGroupChatServerState('local')

          return 'verified'
        }

        return '(pass)'
      }
    })

    const members: GroupMember[] = [
      { name: 'research', title: '' },
      { name: 'builder', title: '' }
    ]

    // research handed off to @builder; the user's newer message names only
    // research, who has already seen it. builder's only way in is the
    // continuation turn for the unanswered handoff (#94478).
    room.chat.$groupChats.set({
      Core: {
        ...seededRoom(
          [
            member('handoff', 1_000, 'research', '@builder please verify'),
            user('input', 2_000, '@research status?')
          ],
          { [`${T}::research`]: 2 }
        ),
        running: true
      }
    })

    await room.rounds.runGroupChatRounds('Core', members, T)

    const builderPrompts = room.gateway.calls.filter(call => call.profile === 'builder')

    expect(promptDelta(builderPrompts[0].prompt)).toEqual([
      'research: @builder please verify',
      'You (user): @research status?'
    ])
    expect(builderPrompts).toHaveLength(2)
    expect(promptDelta(builderPrompts[1].prompt)).toEqual([
      'You (user): mobile mid-turn question',
      'builder (you): verified'
    ])
  })

  it('a stranded reply harvested late leaves what landed meanwhile in the member’s next delta', async () => {
    const room = await loadRoom()

    // research timed out on u1 (watermark past it, marker left behind). While
    // it was stranded a mobile post was pulled into the thread.
    room.chat.$groupChats.set({
      Core: {
        ...seededRoom([user('u1', 1_000, 'first question'), user('r1', 2_000, 'mobile question')], {
          [`${T}::research`]: 1
        }),
        sessions: { research: 'sid-research' },
        stranded: { research: { before: 0, thread: T } }
      } as unknown as GroupChat
    })
    room.gateway.sessions.set('sid-research', {
      messages: [
        { content: 'the turn prompt', role: 'user' },
        { content: 'late research result', role: 'assistant' }
      ],
      profile: 'research',
      runtime: 'rt-research',
      stored: 'sid-research',
      title: 'Group: room-core'
    })

    await room.turns.harvestStrandedGroupReply('Core', { name: 'research', title: '' })

    const core = room.chat.$groupChats.get().Core

    expect(core.log.map(entry => entry.text)).toEqual(['first question', 'mobile question', 'late research result'])
    expect(nextDelta(core, T, 'research')).toEqual(['mobile question', 'late research result'])
  })
})

describe('watermark advance by entry identity', () => {
  const a = user('a', 1, 'a')
  const b = member('b', 2, 'research', 'b')
  const other = user('o', 3, 'other thread', S)
  const own = member('own', 4, 'research', 'own')
  const legacyFirst = { at: 1, from: { kind: 'user', name: 'You' }, text: 'old', thread: T } as GroupMessage
  const legacyLast = { at: 2, from: { kind: 'user', name: 'You' }, text: 'old too', thread: T } as GroupMessage

  it.each([
    ['an entry by id, wherever it sits now', [b, a], a, 1],
    ['an id-less entry by identity, not the first id-less one', [legacyFirst, legacyLast], legacyLast, 1],
    ['an entry no longer in the log', [b], a, -1]
  ])('finds %s', async (_case, log, entry, expected) => {
    const { chat } = await loadRoom()

    expect(chat.groupChatEntryIndex(log, entry)).toBe(expected)
  })

  it.each([
    ['past the last shown entry, not over what landed after it', [a, b, own], b, 0, 2],
    ['to where it already is when the shown entry was trimmed away', [own], b, 0, 0],
    ['never backward', [a, b, own], a, 3, 3]
  ])('after a turn moves %s', async (_case, log, lastShown, seen, expected) => {
    const { chat } = await loadRoom()

    expect(chat.groupWatermarkPastShown(log, lastShown, seen)).toBe(expected)
  })

  it.each([
    ['past its own entry when it directly follows', [a, own], 1, 2],
    ['past its own entry over another thread’s entries', [a, other, own], 1, 3],
    ['nowhere when a same-thread entry it was not shown precedes it', [a, b, own], 1, 1],
    ['nowhere when its own entry is already behind the watermark', [own, a], 2, 2]
  ])('after its own entry moves %s', async (_case, log, seen, expected) => {
    const { chat } = await loadRoom()

    expect(chat.groupWatermarkPastOwnEntry(log, own, T, seen)).toBe(expected)
  })
})
