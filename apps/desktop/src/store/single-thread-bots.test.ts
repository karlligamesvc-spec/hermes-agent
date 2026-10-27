/**
 * hc-1077 多助手第一期 M1: the switch, the roster read from `profiles.list`,
 * the assistant on screen and its name, and switching assistants.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APEX_AVATAR_COLOR, apexBotColorHex } from '@/components/apex-avatar-look'

import { $activeGatewayProfile, $gatewaySwapTarget } from './profile'
import { setSingleThreadFlagForTest } from './single-thread'
import {
  $botIntent,
  $botLastSessions,
  $botRoster,
  $currentBot,
  $currentBotProfile,
  $multiBotMode,
  APEX_PROFILE,
  botFor,
  botNameForProfile,
  type BotProfileRow,
  botRosterFrom,
  botSwapLabel,
  canDeleteBot,
  canRestyleBot,
  MULTI_BOT_HINT_KEY,
  MULTI_BOT_MAX_DEFAULT,
  multiBotMaxFrom,
  multiBotSwitchFrom,
  openBot,
  refreshBotRoster,
  resetBotRosterForTest,
  setMultiBotFlagForTest,
  withBotName
} from './single-thread-bots'
import { setToolViewMode } from './tool-view'

const { ensureGatewayProfile, pinNewChatProfile, requestFreshSession } = vi.hoisted(() => ({
  ensureGatewayProfile: vi.fn(async (_profile: string) => undefined),
  pinNewChatProfile: vi.fn((name: string) => name),
  requestFreshSession: vi.fn()
}))

vi.mock('./profile', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  ensureGatewayProfile,
  pinNewChatProfile,
  requestFreshSession
}))

const row = (name: string, apex: Record<string, unknown> = {}, extra: Partial<BotProfileRow> = {}): BotProfileRow => ({
  name,
  ui_meta: { apex },
  ...extra
})

beforeEach(() => {
  resetBotRosterForTest()
  $activeGatewayProfile.set('default')
  $gatewaySwapTarget.set(null)
  ensureGatewayProfile.mockClear()
  pinNewChatProfile.mockClear()
  requestFreshSession.mockClear()
})

afterEach(() => {
  setMultiBotFlagForTest(false)
  setSingleThreadFlagForTest(false)
  setToolViewMode('product')
  window.localStorage.removeItem(MULTI_BOT_HINT_KEY)
  vi.useRealTimers()
})

describe('the switch', () => {
  // The same table electron/apex-multi-bot.test.ts runs for main, minus the
  // single-thread half (the renderer reads that from $singleThreadMode).
  it.each([
    [{ payload: { desktop_features: { multi_bot: true } } }, true],
    [{ payload: { desktop_features: { multi_bot: 'true' } } }, false],
    [{ payload: { desktop_features: { single_thread: true } } }, false],
    [{ payload: null }, false],
    [{ installSwitches: { multi_bot: true }, payload: null }, true],
    [{ installSwitches: { multi_bot: false }, payload: { desktop_features: { multi_bot: true } } }, false],
    [{ installSwitches: { single_thread: true }, payload: { desktop_features: { multi_bot: true } } }, true],
    [null, false]
  ])('%j reads as %j', (state, expected) => {
    expect(multiBotSwitchFrom(state as Parameters<typeof multiBotSwitchFrom>[0])).toBe(expected)
  })

  it('counts only in single-thread product mode', () => {
    setMultiBotFlagForTest(true)
    expect($multiBotMode.get()).toBe(false)

    setSingleThreadFlagForTest(true)
    expect($multiBotMode.get()).toBe(true)

    setToolViewMode('technical')
    expect($multiBotMode.get()).toBe(false)

    setToolViewMode('product')
    setMultiBotFlagForTest(false)
    expect($multiBotMode.get()).toBe(false)
  })

  it.each([
    [{ desktop_features: { multi_bot_max: 3 } }, 3],
    [{ desktop_features: { multi_bot_max: 1 } }, 1],
    [{ desktop_features: { multi_bot_max: 0 } }, MULTI_BOT_MAX_DEFAULT],
    [{ desktop_features: { multi_bot_max: -2 } }, MULTI_BOT_MAX_DEFAULT],
    [{ desktop_features: { multi_bot_max: 2.5 } }, MULTI_BOT_MAX_DEFAULT],
    [{ desktop_features: { multi_bot_max: '4' } }, MULTI_BOT_MAX_DEFAULT],
    [{ desktop_features: {} }, MULTI_BOT_MAX_DEFAULT],
    [null, MULTI_BOT_MAX_DEFAULT]
  ])('caps at desktop_features.multi_bot_max %j → %d (K2: APEX + 4 by default)', (payload, max) => {
    expect(multiBotMaxFrom(payload)).toBe(max)
    expect(MULTI_BOT_MAX_DEFAULT).toBe(5)
  })
})

describe('the roster', () => {
  const souls =
    (...names: string[]) =>
    (profile: string) =>
      names.includes(profile)

  it('puts APEX first whatever the list says, purple circle, with its own name only', () => {
    const roster = botRosterFrom(
      [
        row('writer', { name: '小红书文案', created: 1 }),
        row('default', { color: 'rose', name: '小A', shape: 'hexagon' }, { is_default: true })
      ],
      souls('writer')
    )

    expect(roster.map(bot => [bot.profile, bot.name, bot.shape, bot.color])).toEqual([
      [APEX_PROFILE, '小A', 'circle', APEX_AVATAR_COLOR],
      ['writer', '小红书文案', 'squircle', apexBotColorHex('blue')]
    ])
    expect(roster[0]!.isApex).toBe(true)
  })

  it('names APEX 「APEX」 until it is renamed, and lists it even when the list has no default row', () => {
    expect(botRosterFrom([], () => true).map(bot => [bot.profile, bot.name])).toEqual([[APEX_PROFILE, 'APEX']])
  })

  it('lists a named profile only with a SOUL.md and not hidden by Bot Mode', () => {
    const roster = botRosterFrom(
      [
        row('with-soul', { created: 3 }),
        row('no-soul', { created: 1 }),
        row('unknown', { created: 2 }),
        row('hidden', { created: 4 }, { ui_meta: { 'hermes-bots': { hidden: true } } })
      ],
      profile => (profile === 'unknown' ? null : profile !== 'no-soul')
    )

    expect(roster.map(bot => bot.profile)).toEqual([APEX_PROFILE, 'with-soul'])
  })

  it('keeps the rest in the order they were made, undated ones last by name', () => {
    const roster = botRosterFrom(
      [
        row('zeta'),
        row('second', { created: 2_000 }),
        row('alpha'),
        row('bot-mode', {}, { ui_meta: { 'hermes-bots': { created: 1_500 } } }),
        row('first', { created: 1_000 })
      ],
      () => true
    )

    expect(roster.map(bot => bot.profile)).toEqual([APEX_PROFILE, 'first', 'bot-mode', 'second', 'alpha', 'zeta'])
  })

  it.each([
    ['its own look', { color: 'teal', shape: 'cloud' }, 'cloud', apexBotColorHex('teal')],
    ['an unknown shape and colour', { color: 'purple', shape: 'star' }, 'squircle', apexBotColorHex('blue')],
    ['a hex instead of an id', { color: '#6A4CEB', shape: 'drop' }, 'drop', apexBotColorHex('blue')],
    ['nothing', {}, 'squircle', apexBotColorHex('blue')]
  ])('reads %s as its look', (_label, apex, shape, color) => {
    const [, bot] = botRosterFrom([row('one', apex)], () => true)

    expect([bot!.shape, bot!.color]).toEqual([shape, color])
  })

  it('names an assistant by ui_meta.apex.name, else its profile, and carries the key’s revision', () => {
    const [, named, unnamed] = botRosterFrom(
      [
        row('writer', { created: 1, name: '  剪辑助手 ' }, { ui_meta_revisions: { apex: 4, 'hermes-bots': 9 } }),
        row('apex-bot-3', { created: 2, name: '   ' })
      ],
      () => true
    )

    expect([named!.name, named!.revision]).toEqual(['剪辑助手', 4])
    expect([unnamed!.name, unnamed!.revision]).toEqual(['apex-bot-3', 0])
  })

  it('reads through the gateway: one describe per new profile, a yes kept, a no asked again after a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 27, 9, 0))

    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'profiles.list') {
        return {
          profiles: [
            { is_default: true, last_session: { id: 'root-a', preview: '好，定稿了' }, name: 'default' },
            row('writer', { created: 1, name: '小红书文案' }, { last_session: { id: 'w-1', preview: '标题写好了' } }),
            row('scratch')
          ]
        }
      }

      return { soul: params?.name === 'writer' ? '你是小红书文案。' : '' }
    }) as never

    await refreshBotRoster(request)
    expect($botRoster.get().map(bot => bot.name)).toEqual(['APEX', '小红书文案'])
    expect($botLastSessions.get()).toEqual({
      default: { id: 'root-a', preview: '好，定稿了' },
      writer: { id: 'w-1', preview: '标题写好了' }
    })

    const describes = () =>
      (request as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([method]) => method === 'profiles.describe')

    expect(describes().map(([, params]) => params)).toEqual([{ name: 'writer' }, { name: 'scratch' }])

    await refreshBotRoster(request)
    expect(describes()).toHaveLength(2)

    vi.setSystemTime(new Date(2026, 9, 27, 9, 1, 1))
    await refreshBotRoster(request)
    expect(describes().map(([, params]) => params)).toEqual([
      { name: 'writer' },
      { name: 'scratch' },
      { name: 'scratch' }
    ])
  })

  it('carries the profile’s whole ui_meta for the row to read (hc-1079’s apex-intake), and paints it from the cache', async () => {
    const intake = { a1: 2, done: true }

    await refreshBotRoster((async (method: string) =>
      method === 'profiles.list'
        ? {
            profiles: [row('writer', { name: '文案' }, { ui_meta: { apex: { name: '文案' }, 'apex-intake': intake } })]
          }
        : { soul: 'x' }) as never)

    expect($botRoster.get()[1]!.uiMeta['apex-intake']).toEqual(intake)
    expect($botRoster.get()[0]!.uiMeta).toEqual({})

    vi.resetModules()

    const fresh = await import('./single-thread-bots')

    expect(fresh.$botRoster.get()[1]!.uiMeta['apex-intake']).toEqual(intake)
  })

  it('keeps the roster on screen when the list cannot be read', async () => {
    resetBotRosterForTest([...botRosterFrom([row('writer', { name: '小红书文案' })], () => true)])

    await refreshBotRoster((async () => {
      throw new Error('socket closed')
    }) as never)

    expect($botRoster.get().map(bot => bot.profile)).toEqual([APEX_PROFILE, 'writer'])
  })

  it('paints the next launch from the last roster, through the same checks', async () => {
    await refreshBotRoster((async (method: string) =>
      method === 'profiles.list'
        ? { profiles: [row('default', { name: '小A' }), row('writer', { color: 'gold', name: '文案', shape: 'pill' })] }
        : { soul: 'x' }) as never)

    vi.resetModules()

    const fresh = await import('./single-thread-bots')

    expect(fresh.$botRoster.get().map(bot => [bot.profile, bot.name, bot.shape, bot.color, bot.revision])).toEqual([
      [APEX_PROFILE, '小A', 'circle', APEX_AVATAR_COLOR, 0],
      ['writer', '文案', 'pill', apexBotColorHex('gold'), 0]
    ])
  })
})

describe('the assistant on screen', () => {
  beforeEach(() => {
    resetBotRosterForTest([
      ...botRosterFrom([row('default', {}, { is_default: true }), row('writer', { name: '小红书文案' })], () => true)
    ])
  })

  it('is nobody while one assistant is on (every caller keeps its APEX copy)', () => {
    expect($currentBot.get()).toBeNull()
    expect(botNameForProfile('writer')).toBeNull()
    expect(botSwapLabel('writer')).toBe('writer')
  })

  it('follows the click first, then the engine switch, then the active profile', () => {
    setSingleThreadFlagForTest(true)
    setMultiBotFlagForTest(true)

    expect($currentBot.get()?.name).toBe('APEX')

    $gatewaySwapTarget.set('writer')
    expect($currentBotProfile.get()).toBe('writer')
    expect($currentBot.get()?.name).toBe('小红书文案')

    $botIntent.set('default')
    expect($currentBotProfile.get()).toBe('default')

    $botIntent.set(null)
    $gatewaySwapTarget.set(null)
    $activeGatewayProfile.set('writer')
    expect($currentBot.get()?.name).toBe('小红书文案')
    expect(botNameForProfile('writer')).toBe('小红书文案')
    expect(botNameForProfile(null)).toBe('APEX')
    expect(botSwapLabel('writer')).toBe('小红书文案')
  })

  it('says what it can of a profile the roster does not list yet', () => {
    expect(botFor($botRoster.get(), 'apex-bot-9')).toMatchObject({ isApex: false, name: 'apex-bot-9' })
    expect(botFor([], 'default')).toMatchObject({ isApex: true, name: 'APEX', shape: 'circle' })
  })

  it.each([
    ['one assistant', '给 APEX 发消息', null, '给 APEX 发消息'],
    ['APEX itself', '给 APEX 发消息', 'APEX', '给 APEX 发消息'],
    ['another', '让 APEX 停下手上的事', '小红书文案', '让 小红书文案 停下手上的事'],
    ['every mention', 'APEX 想改 APEX 的说明', '剪辑', '剪辑 想改 剪辑 的说明'],
    ['a name with replacement patterns', 'Message APEX', '$& $1', 'Message $& $1']
  ])('names %s in copy', (_label, text, name, expected) => {
    expect(withBotName(text, name)).toBe(expected)
  })

  it('APEX can never be deleted or restyled (K6); the others can', () => {
    const [apex, writer] = $botRoster.get()

    expect([canDeleteBot(apex!), canRestyleBot(apex!)]).toEqual([false, false])
    expect([canDeleteBot(writer!), canRestyleBot(writer!)]).toEqual([true, true])
  })
})

describe('switching assistants', () => {
  it('does nothing for the assistant already on screen', async () => {
    await openBot('default')

    expect(ensureGatewayProfile).not.toHaveBeenCalled()
    expect(requestFreshSession).not.toHaveBeenCalled()
  })

  it('names the target at once, drops to a fresh draft, then activates its engine', async () => {
    let settle!: () => void

    ensureGatewayProfile.mockImplementationOnce(
      () => new Promise<undefined>(resolve => (settle = () => resolve(undefined)))
    )

    const switching = openBot('writer')

    expect($botIntent.get()).toBe('writer')
    expect(pinNewChatProfile).toHaveBeenCalledWith('writer')
    expect(requestFreshSession).toHaveBeenCalledTimes(1)
    expect(ensureGatewayProfile).toHaveBeenCalledWith('writer')

    settle()
    await switching
    expect($botIntent.get()).toBeNull()
  })

  it('clears the intent and rejects when the engine cannot be reached', async () => {
    ensureGatewayProfile.mockRejectedValueOnce(new Error('spawn failed'))

    await expect(openBot('writer')).rejects.toThrow('spawn failed')
    expect($botIntent.get()).toBeNull()
  })

  it('never remembers the assistant as the startup profile (K7: the IM gateway stays on APEX)', () => {
    const source = readFileSync(join(__dirname, 'single-thread-bots.ts'), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      ''
    )

    expect(source).not.toMatch(/selectProfile|profile\??\.remember|profile\??\.set\(|switchProfile/)
    expect(source).toMatch(/ensureGatewayProfile\(target\)/)
  })
})
