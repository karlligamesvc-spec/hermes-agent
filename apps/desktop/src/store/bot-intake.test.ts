import { beforeEach, describe, expect, it } from 'vitest'

import { divisionSection } from '@/app/single-thread/bot-intake-soul'
import { fakeProfileEngine } from '@/test/fake-profile-engine'

import {
  $botIntake,
  BOT_INTAKE_META_KEY,
  loadBotIntake,
  parseBotIntakeRecord,
  resetBotIntakeForTest,
  saveBotIntakeAnswers,
  undoBotIntake
} from './bot-intake'
import { $botRoster, botFor, botRosterFrom, resetBotRosterForTest } from './single-thread-bots'

const TEMPLATE = 'You are 剪辑助手, an AI assistant made in APEX by ApexNodes HK.\n'

describe('hc-1079: the intake record in ui_meta', () => {
  it.each([
    [
      { answers: { platform: 'same', role: 'editing', style: 'brief' }, status: 'noted', v: 1 },
      { answers: { platform: 'same', role: 'editing', style: 'brief' }, status: 'noted', v: 1 }
    ],
    [
      { answers: { platform: ['douyin', 'tiktok', 'douyin'] }, status: 'asking' },
      { answers: { platform: ['douyin'] }, status: 'asking', v: 1 }
    ],
    [
      { answers: { role: 'other', roleOther: ' 直播\n切片 ' }, status: 'asking' },
      { answers: { role: 'other', roleOther: '直播 切片' }, status: 'asking', v: 1 }
    ],
    [
      { answers: { role: 'other', roleOther: '' }, status: 'asking' },
      { answers: {}, status: 'asking', v: 1 }
    ],
    [
      { answers: { role: 'singing', style: 'loud', platform: [] }, status: 'undone' },
      { answers: {}, status: 'undone', v: 1 }
    ],
    [
      { answers: 'nope', status: 'noted' },
      { answers: {}, status: 'noted', v: 1 }
    ]
  ])('%j reads as %j', (raw, record) => {
    expect(parseBotIntakeRecord(raw)).toEqual(record)
  })

  it.each([null, undefined, 'noted', [], { status: 'done' }, { answers: {} }])('%j reads as no record', raw => {
    expect(parseBotIntakeRecord(raw)).toBeNull()
  })
})

describe('hc-1079: reading, saving and undoing a new assistant’s answers', () => {
  beforeEach(() => resetBotIntakeForTest())

  it('reads no record for a brand-new assistant and the saved one after that', async () => {
    const engine = fakeProfileEngine({ bot: { soul: TEMPLATE }, default: { soul: 'APEX\n' } })

    await loadBotIntake(engine.request, 'bot')
    expect($botIntake.get()).toEqual({ profile: 'bot', record: null, status: 'ready' })
    expect(engine.calls[0]).toEqual({ method: 'profiles.list', params: { include_sessions: false } })

    engine.profiles.get('bot')!.uiMeta[BOT_INTAKE_META_KEY] = { answers: { role: 'editing' }, status: 'asking', v: 1 }
    await loadBotIntake(engine.request, 'bot')
    expect($botIntake.get().record).toEqual({ answers: { role: 'editing' }, status: 'asking', v: 1 })
  })

  it('fails closed when the roster does not list the profile or cannot be read', async () => {
    const engine = fakeProfileEngine({ default: { soul: 'APEX\n' } })

    await loadBotIntake(engine.request, 'bot')
    expect($botIntake.get()).toEqual({ profile: 'bot', record: null, status: 'error' })

    await loadBotIntake(() => Promise.reject(new Error('gateway closed')), 'bot')
    expect($botIntake.get()).toEqual({ profile: 'bot', record: null, status: 'error' })
  })

  it('publishes only the newest read when the assistant changes mid-read', async () => {
    const engine = fakeProfileEngine({ a: { soul: TEMPLATE }, b: { soul: TEMPLATE } })

    let release = () => {}

    const slow = <T>(method: string, params?: Record<string, unknown>) =>
      new Promise<T>(resolve => {
        release = () => void engine.request<T>(method, params).then(resolve)
      })

    const first = loadBotIntake(slow, 'a')
    await loadBotIntake(engine.request, 'b')
    release()
    await first

    expect($botIntake.get().profile).toBe('b')
  })

  it('saves each answer as it comes: SOUL first, then the record, asking until all three are in', async () => {
    const engine = fakeProfileEngine({ bot: { soul: TEMPLATE } })
    await loadBotIntake(engine.request, 'bot')

    expect(await saveBotIntakeAnswers(engine.request, 'bot', { role: 'editing' }, 'zh')).toBe(true)
    expect(engine.profiles.get('bot')!.soul).toBe(`${TEMPLATE}\n${divisionSection({ role: 'editing' }, 'zh')}`)
    expect(engine.profiles.get('bot')!.uiMeta).toEqual({
      [BOT_INTAKE_META_KEY]: { answers: { role: 'editing' }, status: 'asking', v: 1 }
    })
    expect($botIntake.get().record?.status).toBe('asking')

    const all = { platform: 'same' as const, role: 'editing' as const, style: 'brief' as const }
    expect(await saveBotIntakeAnswers(engine.request, 'bot', all, 'zh')).toBe(true)
    expect(engine.profiles.get('bot')!.soul).toBe(`${TEMPLATE}\n${divisionSection(all, 'zh')}`)
    expect($botIntake.get().record).toEqual({ answers: all, status: 'noted', v: 1 })
    expect(engine.writes()).toEqual(['soul', 'ui_meta', 'soul', 'ui_meta'])
  })

  it('writes no record when the SOUL write is not applied, so the card stays open', async () => {
    const engine = fakeProfileEngine({ bot: { soul: TEMPLATE } })
    await loadBotIntake(engine.request, 'bot')
    engine.failNext('soul')

    expect(await saveBotIntakeAnswers(engine.request, 'bot', { role: 'editing' }, 'zh')).toBe(false)
    expect(engine.writes()).toEqual(['soul'])
    expect(engine.profiles.get('bot')).toEqual({ soul: TEMPLATE, uiMeta: {} })
    expect($botIntake.get().record).toBeNull()
  })

  it('reports a record write that was not applied', async () => {
    const engine = fakeProfileEngine({ bot: { soul: TEMPLATE } })
    await loadBotIntake(engine.request, 'bot')
    engine.failNext('ui_meta')

    expect(await saveBotIntakeAnswers(engine.request, 'bot', { role: 'editing' }, 'zh')).toBe(false)
    expect($botIntake.get().record).toBeNull()
  })

  it('never turns a SOUL without identity text into only a 「分工」 section', async () => {
    const engine = fakeProfileEngine({ bot: { soul: '  \n' } })

    expect(await saveBotIntakeAnswers(engine.request, 'bot', { role: 'editing' }, 'zh')).toBe(false)
    expect(engine.writes()).toEqual([])
  })

  it('reports a gateway that throws', async () => {
    expect(
      await saveBotIntakeAnswers(() => Promise.reject(new Error('closed')), 'bot', { role: 'editing' }, 'zh')
    ).toBe(false)
    expect(await undoBotIntake(() => Promise.reject(new Error('closed')), 'bot')).toBe(false)
  })

  it('撤销 gives back the SOUL as it was before the intake and marks the record undone', async () => {
    const engine = fakeProfileEngine({ bot: { soul: TEMPLATE } })
    await loadBotIntake(engine.request, 'bot')
    const all = { platform: ['douyin' as const], role: 'copywriting' as const, style: 'friendly' as const }
    await saveBotIntakeAnswers(engine.request, 'bot', all, 'zh')

    expect(await undoBotIntake(engine.request, 'bot')).toBe(true)
    expect(engine.profiles.get('bot')).toEqual({
      soul: TEMPLATE,
      uiMeta: { [BOT_INTAKE_META_KEY]: { answers: {}, status: 'undone', v: 1 } }
    })
    expect($botIntake.get().record).toEqual({ answers: {}, status: 'undone', v: 1 })
  })

  it('撤销 keeps an edit made elsewhere in the SOUL meanwhile and takes out only the section', async () => {
    const engine = fakeProfileEngine({ bot: { soul: TEMPLATE } })
    await saveBotIntakeAnswers(engine.request, 'bot', { role: 'editing' }, 'zh')
    const bot = engine.profiles.get('bot')!
    bot.soul = `Renamed.\n${bot.soul}`

    expect(await undoBotIntake(engine.request, 'bot')).toBe(true)
    expect(bot.soul).toBe(`Renamed.\n${TEMPLATE}`)
  })

  it('updates the sidebar row’s record at once, without waiting for the next roster read', async () => {
    const engine = fakeProfileEngine({ bot: { soul: TEMPLATE }, other: { soul: TEMPLATE } })
    const meta = (name: string) => ({ name, ui_meta: { apex: { created: 1, name } }, ui_meta_revisions: { apex: 1 } })
    resetBotRosterForTest(botRosterFrom([meta('bot'), meta('other')], () => true))
    const intakeOf = (profile: string) => botFor($botRoster.get(), profile).uiMeta[BOT_INTAKE_META_KEY]

    engine.failNext('ui_meta')
    await saveBotIntakeAnswers(engine.request, 'bot', { role: 'editing' }, 'zh')
    expect(intakeOf('bot')).toBeUndefined()

    await saveBotIntakeAnswers(engine.request, 'bot', { role: 'editing' }, 'zh')
    expect(intakeOf('bot')).toEqual({ answers: { role: 'editing' }, status: 'asking', v: 1 })
    expect(botFor($botRoster.get(), 'bot').revision).toBe(1)

    await undoBotIntake(engine.request, 'bot')
    expect(intakeOf('bot')).toEqual({ answers: {}, status: 'undone', v: 1 })
    expect(intakeOf('other')).toBeUndefined()

    resetBotRosterForTest()
  })

  it('writes only its own ui_meta key: the name, look and origin under `apex` stay as the new-assistant sheet left them', async () => {
    const apex = { color: 'teal', created: 1, name: '剪辑助手', origin: 'product', shape: 'cloud' }
    const engine = fakeProfileEngine({ bot: { soul: TEMPLATE, uiMeta: { apex } } })
    resetBotRosterForTest(
      botRosterFrom([{ name: 'bot', ui_meta: { apex }, ui_meta_revisions: { apex: 2 } }], () => true)
    )

    await saveBotIntakeAnswers(engine.request, 'bot', { platform: 'same', role: 'editing', style: 'brief' }, 'zh')
    await undoBotIntake(engine.request, 'bot')

    const metaWrites = engine.calls.filter(call => call.method === 'profiles.configure' && 'ui_meta' in call.params)

    expect(metaWrites).toHaveLength(2)
    expect(metaWrites.map(call => Object.keys(call.params))).toEqual([
      ['name', 'ui_meta'],
      ['name', 'ui_meta']
    ])
    expect(metaWrites.map(call => Object.keys(call.params.ui_meta as object))).toEqual([
      [BOT_INTAKE_META_KEY],
      [BOT_INTAKE_META_KEY]
    ])
    expect(engine.profiles.get('bot')!.uiMeta.apex).toEqual(apex)
    expect(botFor($botRoster.get(), 'bot').uiMeta.apex).toEqual(apex)
    expect(botFor($botRoster.get(), 'bot').revision).toBe(2)

    resetBotRosterForTest()
  })
})
