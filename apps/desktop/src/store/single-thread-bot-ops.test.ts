/**
 * hc-1078 (multi-bot M2): what the create / edit / delete operations send to the engine. Every
 * request goes to the default profile's engine; only `ui_meta.apex` is ever written (never
 * `hermes-bots`, which would make the engine treat the profile as a Bot Mode one); APEX keeps its
 * look and cannot be deleted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  APEX_BOT_SOUL_BODY,
  apexBotSoulNameLine,
  composeApexBotSoul,
  renameInApexBotSoul
} from '../../shared/apex-bot-soul'
import { APEX_DESKTOP_DEFAULT_SOUL } from '../../shared/apex-default-soul'

import { requestGatewayForProfile } from './gateway'
import {
  apexLookFrom,
  botNameProblem,
  BotOpError,
  botsLeft,
  cleanBotName,
  createBot,
  deleteBot,
  nextBotProfileName,
  readBotLook,
  saveBotLook
} from './single-thread-bot-ops'

const deleteProfile = vi.fn(async (_profile: string) => undefined)

vi.mock('./gateway', () => ({ requestGatewayForProfile: vi.fn() }))
vi.mock('@/sdk', () => ({ host: { deleteProfile: (profile: string) => deleteProfile(profile) } }))

type Call = { method: string; params: Record<string, unknown>; profile: string }

const request = vi.mocked(requestGatewayForProfile)
let calls: Call[] = []
let answer: (method: string, params: Record<string, unknown>) => unknown

const LOOK = { name: '小红书文案', shape: 'hexagon', color: 'orange' }

beforeEach(() => {
  calls = []
  answer = () => ({})
  request.mockImplementation(async (profile, method, params = {}) => {
    calls.push({ method, params, profile })
    const result = answer(method, params)

    if (result instanceof Error) {
      throw result
    }

    return result as never
  })
})

afterEach(() => {
  request.mockReset()
  deleteProfile.mockClear()
  delete (window.hermesDesktop as unknown as Record<string, unknown> | undefined)?.healApexProfileConfig
  delete (window.hermesDesktop as unknown as Record<string, unknown> | undefined)?.syncApexProfileSkills
})

const methods = () => calls.map(call => call.method)
const configureCalls = () => calls.filter(call => call.method === 'profiles.configure')

function gatewayError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('the new assistant SOUL', () => {
  it('is the APEX identity with the assistant named on its first line', () => {
    const soul = composeApexBotSoul({ name: '剪辑助手' })
    const [first, ...rest] = soul.split('\n')

    expect(first).toBe(
      'You are 剪辑助手, an AI assistant from ApexNodes HK, working alongside APEX for the same person.'
    )
    expect(rest.join('\n')).toContain(APEX_BOT_SOUL_BODY)
    expect(soul.endsWith('\n')).toBe(true)
    expect(soul).not.toContain('You are APEX')
  })

  it('keeps every APEX identity sentence but the one that names APEX', () => {
    expect(APEX_DESKTOP_DEFAULT_SOUL.startsWith('You are APEX, an intelligent AI assistant from ApexNodes HK. ')).toBe(
      true
    )
    expect(APEX_DESKTOP_DEFAULT_SOUL.endsWith(APEX_BOT_SOUL_BODY)).toBe(true)
    expect(APEX_BOT_SOUL_BODY.startsWith('You are helpful')).toBe(true)
  })

  it('appends extra sections after the identity (the hc-1079 seam)', () => {
    const soul = composeApexBotSoul({ name: 'X', sections: [{ heading: ' 分工 ', body: '写标题和文案\n' }] })

    expect(soul.endsWith('## 分工\n写标题和文案\n')).toBe(true)
  })

  it('renames by rewriting the first line only', () => {
    const soul = composeApexBotSoul({ name: '旧名', sections: [{ heading: '分工', body: '剪辑出片' }] })
    const renamed = renameInApexBotSoul(soul, '旧名', '新名')

    expect(renamed).toBe(`${apexBotSoulNameLine('新名')}${soul.slice(apexBotSoulNameLine('旧名').length)}`)
    expect(renamed).toContain('## 分工\n剪辑出片')
  })

  it.each([
    ['a hand-edited first line', 'You are my editor.\nMore.'],
    ['another name', composeApexBotSoul({ name: '别人' })],
    ['a name that only starts the same', composeApexBotSoul({ name: '旧名字' })],
    ['a first line someone extended', `${apexBotSoulNameLine('旧名')} I also speak Cantonese.\nMore.`]
  ])('leaves %s alone', (_label, soul) => {
    expect(renameInApexBotSoul(soul, '旧名', '新名')).toBeNull()
  })
})

describe('names', () => {
  it.each([
    [[], 'apex-bot-2'],
    [['default', 'apex-bot-2'], 'apex-bot-3'],
    [['apex-bot-2', 'apex-bot-4'], 'apex-bot-3'],
    [['APEX-BOT-2'], 'apex-bot-3']
  ])('the directory after %j is %s', (taken, expected) => {
    expect(nextBotProfileName(taken)).toBe(expected)
  })

  it.each([
    ['', [], 'empty'],
    ['   ', [], 'empty'],
    ['十二个字的名字刚好十二个', [], null],
    ['十三个字的名字比上限多一个', [], 'tooLong'],
    ['apex', ['APEX'], 'taken'],
    [' 小红书  文案 ', ['小红书 文案'], 'taken'],
    ['剪辑', ['APEX', '小红书文案'], null]
  ])('%j against %j is %s', (raw, taken, expected) => {
    expect(botNameProblem(raw, taken)).toBe(expected)
  })

  it('stores one line: control characters and runs of spaces collapse', () => {
    expect(cleanBotName('  小红书\n文案\t2 ')).toBe('小红书 文案 2')
  })

  it.each([
    [1, 5, 4],
    [5, 5, 0],
    [7, 5, 0]
  ])('%i assistants of %i leave %i', (count, max, left) => {
    expect(botsLeft(count, max)).toBe(left)
  })

  it('reads only well-formed ui_meta.apex fields', () => {
    expect(apexLookFrom({ apex: { name: 'A', shape: 3, color: '' }, 'hermes-bots': { title: 'B' } })).toEqual({
      name: 'A'
    })
    expect(apexLookFrom({ apex: ['x'] })).toEqual({})
    expect(apexLookFrom(null)).toEqual({})
  })
})

describe('createBot', () => {
  it('clones default into the next apex-bot-N with the APEX SOUL, then writes ui_meta.apex at revision 0', async () => {
    answer = method =>
      method === 'profiles.list'
        ? { profiles: [{ name: 'default' }, { name: 'apex-bot-2', previous_names: ['apex-bot-3'] }] }
        : method === 'profiles.configure'
          ? { applied: { ui_meta: true } }
          : { ok: true }

    await expect(createBot({ ...LOOK, name: ' 小红书文案 ' }, { count: 2, max: 5 })).resolves.toBe('apex-bot-4')

    expect(methods()).toEqual(['profiles.list', 'profiles.create', 'profiles.configure'])
    expect(calls.every(call => call.profile === 'default')).toBe(true)
    expect(calls[0].params).toEqual({ include_sessions: false })
    expect(calls[1].params).toEqual({
      name: 'apex-bot-4',
      clone_from: 'default',
      no_alias: true,
      share_auth: true,
      soul: composeApexBotSoul({ name: '小红书文案' })
    })
    expect(calls[2].params).toEqual({
      name: 'apex-bot-4',
      ui_meta: { apex: LOOK },
      ui_meta_expected_revisions: { apex: 0 }
    })
  })

  it('takes the next name when another window created the same one first', async () => {
    answer = (method, params) =>
      method === 'profiles.list'
        ? { profiles: [{ name: 'default' }] }
        : method === 'profiles.create' && params.name === 'apex-bot-2'
          ? gatewayError(4062, "Profile 'apex-bot-2' already exists")
          : { applied: { ui_meta: true } }

    await expect(createBot(LOOK, { count: 1, max: 5 })).resolves.toBe('apex-bot-3')
    expect(calls.filter(call => call.method === 'profiles.create').map(call => call.params.name)).toEqual([
      'apex-bot-2',
      'apex-bot-3'
    ])
  })

  it('stops at the limit before asking the engine anything', async () => {
    await expect(createBot(LOOK, { count: 5, max: 5 })).rejects.toMatchObject({ kind: 'full' })
    expect(calls).toEqual([])
  })

  it('surfaces any other create failure without writing a look', async () => {
    answer = method => (method === 'profiles.list' ? { profiles: [] } : gatewayError(5062, 'disk full'))

    await expect(createBot(LOOK, { count: 1, max: 5 })).rejects.toThrow('disk full')
    expect(configureCalls()).toEqual([])
    expect(deleteProfile).not.toHaveBeenCalled()
  })

  it('takes the half-made assistant back when its name could not be written', async () => {
    answer = method =>
      method === 'profiles.list'
        ? { profiles: [] }
        : method === 'profiles.configure'
          ? { applied: { ui_meta: false } }
          : {}

    await expect(createBot(LOOK, { count: 1, max: 5 })).rejects.toMatchObject({ kind: 'failed' })
    expect(deleteProfile).toHaveBeenCalledWith('apex-bot-2')
  })

  it('runs the main-process setup steps on the new profile, and survives one failing', async () => {
    answer = method => (method === 'profiles.configure' ? { applied: { ui_meta: true } } : { profiles: [] })

    const heal = vi.fn(async () => {
      throw new Error('no config yet')
    })

    const skills = vi.fn(async () => ({ installed: 3 }))
    Object.assign(window.hermesDesktop ?? (window.hermesDesktop = {} as never), {
      healApexProfileConfig: heal,
      syncApexProfileSkills: skills
    })

    await expect(createBot(LOOK, { count: 1, max: 5 })).resolves.toBe('apex-bot-2')
    expect(heal).toHaveBeenCalledWith('apex-bot-2')
    expect(skills).toHaveBeenCalledWith('apex-bot-2')
  })
})

describe('saveBotLook', () => {
  it('renames APEX through ui_meta.apex.name alone and never reads or writes its SOUL', async () => {
    answer = () => ({ applied: { ui_meta: true } })

    await saveBotLook('default', { ...LOOK, name: '小满' }, { previousName: 'APEX', revision: 2 })

    expect(calls).toEqual([
      {
        method: 'profiles.configure',
        params: { name: 'default', ui_meta: { apex: { name: '小满' } }, ui_meta_expected_revisions: { apex: 2 } },
        profile: 'default'
      }
    ])
  })

  it('writes a named assistant’s look against the revision the sheet read, then moves its SOUL name line', async () => {
    const soul = composeApexBotSoul({ name: '旧名', sections: [{ heading: '分工', body: '剪辑出片' }] })
    answer = method => (method === 'profiles.describe' ? { soul } : { applied: { ui_meta: true, soul: true } })

    await saveBotLook('apex-bot-2', { ...LOOK, name: '新名' }, { previousName: '旧名', revision: 4 })

    expect(methods()).toEqual(['profiles.configure', 'profiles.describe', 'profiles.configure'])
    expect(calls[0].params).toEqual({
      name: 'apex-bot-2',
      ui_meta: { apex: { ...LOOK, name: '新名' } },
      ui_meta_expected_revisions: { apex: 4 }
    })
    expect(calls[2].params).toEqual({ name: 'apex-bot-2', soul: renameInApexBotSoul(soul, '旧名', '新名') })
  })

  it('leaves a hand-written SOUL and an unchanged name alone', async () => {
    answer = method =>
      method === 'profiles.describe' ? { soul: 'You are my editor.' } : { applied: { ui_meta: true } }

    await saveBotLook('apex-bot-2', { ...LOOK, name: '新名' }, { previousName: '旧名', revision: 1 })
    expect(methods()).toEqual(['profiles.configure', 'profiles.describe'])

    calls = []
    await saveBotLook('apex-bot-2', LOOK, { previousName: LOOK.name, revision: 2 })
    expect(methods()).toEqual(['profiles.configure'])
  })

  it('refuses a stale edit instead of overwriting, and then touches nothing else', async () => {
    answer = () => ({ applied: { ui_meta: false, ui_meta_conflicts: { apex: { expected: 1, actual: 2 } } } })

    const failure = saveBotLook('apex-bot-2', { ...LOOK, name: '新名' }, { previousName: '旧名', revision: 1 })

    await expect(failure).rejects.toBeInstanceOf(BotOpError)
    await expect(failure).rejects.toMatchObject({ kind: 'conflict' })
    expect(methods()).toEqual(['profiles.configure'])
  })

  it('never writes the Bot Mode ui_meta key', async () => {
    answer = method =>
      method === 'profiles.list'
        ? { profiles: [] }
        : method === 'profiles.describe'
          ? { soul: composeApexBotSoul({ name: '旧名' }) }
          : { applied: { ui_meta: true } }

    await createBot(LOOK, { count: 1, max: 5 })
    await saveBotLook('apex-bot-2', { ...LOOK, name: '新名' }, { previousName: '旧名', revision: 1 })
    await saveBotLook('default', { name: '小满' }, { previousName: 'APEX', revision: 0 })

    for (const call of configureCalls()) {
      expect(Object.keys((call.params.ui_meta as object | undefined) ?? {})).not.toContain('hermes-bots')
    }

    expect(configureCalls().filter(call => call.params.ui_meta)).toHaveLength(3)
  })
})

describe('readBotLook', () => {
  it('returns the stored look and the revision an edit must name', async () => {
    answer = () => ({
      profiles: [
        { name: 'default', ui_meta: { apex: { name: '小满' } }, ui_meta_revisions: { apex: 3 } },
        { name: 'apex-bot-2', ui_meta: { apex: LOOK }, ui_meta_revisions: { 'hermes-bots': 9 } }
      ]
    })

    await expect(readBotLook('default')).resolves.toEqual({ look: { name: '小满' }, revision: 3 })
    await expect(readBotLook('apex-bot-2')).resolves.toEqual({ look: LOOK, revision: 0 })
    await expect(readBotLook('apex-bot-9')).rejects.toMatchObject({ kind: 'failed' })
  })
})

describe('deleteBot', () => {
  it.each(['default', ' Default '])('refuses APEX (%j) before reaching the engine', async profile => {
    await expect(deleteBot(profile)).rejects.toMatchObject({ kind: 'apex' })
    expect(deleteProfile).not.toHaveBeenCalled()
  })

  it('deletes through host.deleteProfile, which stops the profile engine first', async () => {
    await deleteBot('apex-bot-2')
    expect(deleteProfile).toHaveBeenCalledWith('apex-bot-2')
    expect(calls).toEqual([])
  })
})
