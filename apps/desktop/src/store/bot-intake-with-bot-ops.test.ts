/**
 * hc-1079 × hc-1078 on one engine: the first-open answers and the new-assistant
 * sheet both write a new assistant's SOUL.md and profile.yaml. Run the sheet's
 * real rename (saveBotLook) between answering and 撤销 and check that neither
 * undoes the other.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { divisionSection } from '@/app/single-thread/bot-intake-soul'
import { fakeProfileEngine, type FakeProfileEngine } from '@/test/fake-profile-engine'

import { composeApexBotSoul } from '../../shared/apex-bot-soul'

import { BOT_INTAKE_META_KEY, resetBotIntakeForTest, saveBotIntakeAnswers, undoBotIntake } from './bot-intake'
import { readBotMeta, saveBotLook } from './single-thread-bot-ops'

const gateway = vi.hoisted(() => ({ engine: null as FakeProfileEngine | null }))

vi.mock('./gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestGatewayForProfile: (_profile: string, method: string, params?: Record<string, unknown>) =>
    gateway.engine!.request(method, params)
}))

const ANSWERS = { platform: 'same' as const, role: 'editing' as const, style: 'brief' as const }
const LOOK = { color: 'teal', created: 1, name: '剪辑助手', origin: 'product', shape: 'cloud' }

describe('hc-1079 × hc-1078: answers, a rename from the sheet, then 撤销', () => {
  beforeEach(() => {
    resetBotIntakeForTest()
    gateway.engine = fakeProfileEngine({
      'apex-bot-2': { soul: composeApexBotSoul({ name: '剪辑助手' }), uiMeta: { apex: LOOK } },
      default: { soul: 'APEX\n' }
    })
  })

  it('the rename keeps the 「分工」, and 撤销 leaves the renamed template byte for byte', async () => {
    const engine = gateway.engine!
    const bot = () => engine.profiles.get('apex-bot-2')!

    expect(await saveBotIntakeAnswers(engine.request, 'apex-bot-2', ANSWERS, 'zh')).toBe(true)

    const { meta, revision } = await readBotMeta('apex-bot-2')
    await saveBotLook('apex-bot-2', { color: 'teal', name: '短视频剪辑', shape: 'cloud' }, { revision, stored: meta })

    expect(bot().soul).toBe(`${composeApexBotSoul({ name: '短视频剪辑' })}\n${divisionSection(ANSWERS, 'zh')}`)
    expect(bot().uiMeta[BOT_INTAKE_META_KEY]).toEqual({ answers: ANSWERS, status: 'noted', v: 1 })

    expect(await undoBotIntake(engine.request, 'apex-bot-2')).toBe(true)

    expect(bot().soul).toBe(composeApexBotSoul({ name: '短视频剪辑' }))
    expect(bot().uiMeta).toEqual({
      apex: { ...LOOK, name: '短视频剪辑' },
      [BOT_INTAKE_META_KEY]: { answers: {}, status: 'undone', v: 1 }
    })
  })
})
