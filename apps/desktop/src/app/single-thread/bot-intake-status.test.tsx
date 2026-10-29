import { cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { BOT_INTAKE_META_KEY } from '@/store/bot-intake'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { $mainThreadsByProfile, resetMainThreadForTest } from '@/store/main-thread'
import { $sessionStates } from '@/store/session-states'
import { $botLastSessions, type ApexBot, type BotProfileRow, botRosterFrom } from '@/store/single-thread-bots'
import { resetThreadPresenceForTest } from '@/store/single-thread-presence'

import { BOT_INTAKE_COPY } from './bot-intake-copy'
import { botIntakeStatusLine } from './bot-intake-status'
import { useBotRowStatus } from './bot-status'

const zh = BOT_INTAKE_COPY.zh

describe('hc-1079: the row line for a new assistant’s questions', () => {
  it.each([
    [undefined, '先问 3 个小问题'],
    [{ answers: { role: 'editing' }, status: 'asking', v: 1 }, '先问 3 个小问题'],
    [{ answers: { platform: 'same', role: 'editing', style: 'brief' }, status: 'noted', v: 1 }, '分工定了：剪辑出片'],
    [
      { answers: { role: 'other', roleOther: '直播切片', style: 'brief' }, status: 'noted', v: 1 },
      '分工定了：直播切片'
    ],
    [{ answers: {}, status: 'undone', v: 1 }, '分工没记，随时再说'],
    [{ status: 'finished' }, '先问 3 个小问题']
  ])('%j → %s', (record, line) => {
    expect(botIntakeStatusLine(record, zh)).toBe(line)
  })

  it('in each locale', () => {
    const noted = { answers: { role: 'copywriting' }, status: 'noted', v: 1 }

    expect(botIntakeStatusLine(noted, BOT_INTAKE_COPY.en)).toBe('Handles titles and captions')
    expect(botIntakeStatusLine(noted, BOT_INTAKE_COPY['zh-hant'])).toBe('分工定了：標題和文案')
    expect(botIntakeStatusLine(undefined, BOT_INTAKE_COPY.en)).toBe('3 quick questions first')
  })
})

describe('hc-1079: where a row shows it', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider configClient={null} initialLocale="zh">
      {children}
    </I18nProvider>
  )

  /** A row as `profiles.list` reads it: `revision` is the apex key's ui_meta revision (0 = painted from cache). */
  function bot(profile: string, intake: unknown, revision = 1): ApexBot {
    const row: BotProfileRow = {
      name: profile,
      ui_meta: { apex: { created: 1, name: '剪辑助手' }, ...(intake ? { [BOT_INTAKE_META_KEY]: intake } : {}) },
      ui_meta_revisions: revision ? { apex: revision } : {}
    }

    return botRosterFrom([row], () => true).find(candidate => candidate.profile === profile)!
  }

  const lineOf = (row: ApexBot) =>
    renderHook(() => useBotRowStatus(row, { current: false, onScreen: false }), { wrapper }).result.current.line

  beforeEach(() => {
    setRuntimeI18nLocale('zh')
    resetMainThreadForTest()
    resetThreadPresenceForTest()
    $sessionStates.set({})
    $botLastSessions.set({})
  })

  afterEach(() => {
    cleanup()
    clearClarifyRequest()
    $sessionStates.set({})
    $botLastSessions.set({})
    resetMainThreadForTest()
  })

  it('an assistant that has said nothing yet, read from the engine', () => {
    expect(lineOf(bot('apex-bot-2', undefined))).toBe('先问 3 个小问题')
    expect(lineOf(bot('apex-bot-2', { answers: { role: 'editing' }, status: 'noted', v: 1 }))).toBe(
      '分工定了：剪辑出片'
    )
    expect(lineOf(bot('apex-bot-2', { answers: {}, status: 'undone', v: 1 }))).toBe('分工没记，随时再说')
  })

  it('not while the row is painted from this install’s cache: its conversations are not listed yet', () => {
    expect(lineOf(bot('apex-bot-2', { answers: { role: 'editing' }, status: 'noted', v: 1 }, 0))).toBeNull()
  })

  it('not once it has any conversation, even one that is not its thread', () => {
    $botLastSessions.set({ 'apex-bot-2': { id: 'some-chat', preview: '别的对话' } })

    expect(lineOf(bot('apex-bot-2', undefined))).toBeNull()
  })

  it('not for APEX', () => {
    const apex = botRosterFrom([{ is_default: true, name: 'default', ui_meta_revisions: { apex: 3 } }], () => true)[0]

    expect(lineOf(apex)).toBeNull()
  })

  it('a busy assistant says what it is doing instead', () => {
    $mainThreadsByProfile.set({
      'apex-bot-2': { ids: ['bot-root'], profile: 'apex-bot-2', rootId: 'bot-root', status: 'found', tipId: 'bot-root' }
    })
    $sessionStates.set({
      bot: { busy: true, messages: [], needsInput: true, storedSessionId: 'bot-root' } as unknown as ClientSessionState
    })
    // hc-1107: waiting comes from the question parked for its session.
    setClarifyRequest({ choices: null, multiSelect: false, question: '要哪个？', requestId: 'q-1', sessionId: 'bot' })

    expect(lineOf(bot('apex-bot-2', undefined))).toBe('等你决定')
  })
})
