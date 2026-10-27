import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopCreatorPlatform, DesktopCreatorProfile, DesktopCreatorProfileResult } from '@/global'
import { I18nProvider, type Locale, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { BOT_INTAKE_META_KEY, resetBotIntakeForTest } from '@/store/bot-intake'
import { $creatorProfile } from '@/store/creator-profile'
import { $mainThread, resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { fakeProfileEngine, type FakeProfileEngine } from '@/test/fake-profile-engine'
import { englishWords, readableText } from '@/test/zh-copy'

import { BotIntake } from './bot-intake'
import { divisionSection } from './bot-intake-soul'
import { SingleThreadEmptyState } from './thread-empty'

const gateway = vi.hoisted(() => ({ engine: null as FakeProfileEngine | null, profiles: [] as string[] }))

vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestGatewayForProfile: (profile: string, method: string, params?: Record<string, unknown>) => {
    gateway.profiles.push(profile)

    return gateway.engine!.request(method, params)
  }
}))

const TEMPLATE = 'You are 剪辑助手, an AI assistant made in APEX by ApexNodes HK.\n'

function install(platforms: DesktopCreatorPlatform[] = ['douyin', 'xiaohongshu']) {
  const creatorProfile = async (): Promise<DesktopCreatorProfileResult> => {
    const profile: DesktopCreatorProfile = {
      answers: { contentType: 'product_review', contentTypeOther: null, painPoint: 'no_topic', platforms },
      intake: { completed: true, nextStep: null, skipped: [] }
    }

    return { ok: true, profile }
  }

  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = { managed: { creatorProfile } }
}

function engineWith(uiMeta: Record<string, unknown> = {}, soul = TEMPLATE) {
  gateway.engine = fakeProfileEngine({ 'apex-bot-2': { soul, uiMeta }, default: { soul: 'APEX\n' } })

  return gateway.engine
}

const bot = () => gateway.engine!.profiles.get('apex-bot-2')!

function renderIntake(locale: Locale = 'zh') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <div data-testid="thread">
        <BotIntake name="剪辑助手" profile="apex-bot-2" />
      </div>
    </I18nProvider>
  )
}

const thread = () => screen.getByTestId('thread')
const text = () => thread().textContent ?? ''

const openCard = () =>
  thread().querySelector<HTMLElement>('[data-first-open-card]:not([data-first-open-card="answered"])')

const answeredCards = () => [...thread().querySelectorAll<HTMLElement>('[data-first-open-card="answered"]')]

const optionLabels = (card: HTMLElement) =>
  within(card)
    .getAllByRole('button')
    .map(b => b.textContent)

async function waitForCard(step: string) {
  return waitFor(() => {
    const card = openCard()
    expect(card?.dataset.firstOpenCard).toBe(step)

    return card!
  })
}

async function pick(step: string, label: string) {
  const card = await waitForCard(step)
  fireEvent.click(within(card).getByRole('button', { name: new RegExp(`^.${label}$`) }))
}

describe('hc-1079: a new assistant asks three cards before its first message', () => {
  beforeEach(() => {
    setRuntimeI18nLocale('zh')
    resetBotIntakeForTest()
    $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
    $authState.set({
      account: { email: 'a@example.test', name: '小满', plan: 'free' },
      accountId: 'acc-1',
      enabled: true,
      gateReason: null,
      loginTruth: true,
      status: 'signed-in'
    })
    gateway.profiles.length = 0
    install()
  })

  afterEach(() => {
    cleanup()
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
  })

  it('greets by its name, does not ask the account’s questions again, and asks card 1 of 3', async () => {
    engineWith()
    renderIntake()
    const card = await waitForCard('role')

    expect(text()).toContain('你好，我是剪辑助手。你的账号情况 APEX 已经告诉我了，不用再说一遍。')
    expect(text()).toContain('先问 3 个小问题，定一下我管什么。点一下就行，也可以直接打字。')
    expect(card.querySelector('h3')!.textContent).toBe('我主要帮你做什么？1 / 3')
    expect(optionLabels(card)).toEqual(['A写标题和文案', 'B拆爆款、找选题', 'C剪辑出片', 'D带货脚本'])
    expect(within(card).getByRole('textbox', { name: '别的，我直接说' })).toBeTruthy()
    expect(text()).not.toMatch(/你主要做什么内容|主要发在哪|最头疼/)
    expect(englishWords(readableText(thread()))).toEqual([])
    // Every read and write goes to the engine of the assistant being opened.
    expect(new Set(gateway.profiles)).toEqual(new Set(['apex-bot-2']))
  })

  it('writes each answer into its own SOUL as it is tapped, folding the card with a line before the next', async () => {
    engineWith()
    renderIntake()

    await pick('role', '剪辑出片')
    const style = await waitForCard('style')

    expect(bot().soul).toBe(`${TEMPLATE}\n${divisionSection({ role: 'editing' }, 'zh')}`)
    expect(answeredCards().map(card => card.textContent)).toEqual(['我主要帮你做什么？C剪辑出片'])
    expect(text()).toContain('剪辑出片，明白。')
    expect(style.querySelector('h3')!.textContent).toBe('我说话什么风格？2 / 3')
    expect(optionLabels(style)).toEqual(['A简短直接', 'B详细一点', 'C像朋友聊天'])

    await pick('style', '简短直接')
    const platform = await waitForCard('platform')

    expect(text()).toContain('好，最后一个。')
    expect(platform.querySelector('h3')!.textContent).toBe('主要给哪个平台做？3 / 3')
    // 「跟 APEX 一样」 first with the account's answer; the same pair is not offered twice.
    expect(optionLabels(platform)).toEqual([
      'A跟 APEX 一样：抖音和小红书都发',
      'B抖音',
      'C小红书',
      'D视频号',
      'E快手',
      'FB 站'
    ])
  })

  it('after the third card: the noted line with undo and a closing line, the SOUL holding all three', async () => {
    engineWith()
    renderIntake()

    await pick('role', '剪辑出片')
    await pick('style', '简短直接')
    await pick('platform', '跟 APEX 一样：抖音和小红书都发')

    const noted = await waitFor(() => {
      const line = thread().querySelector<HTMLElement>('[data-first-open-noted]')
      expect(line).not.toBeNull()

      return line!
    })

    expect(openCard()).toBeNull()
    expect(noted.textContent).toBe('剪辑助手 记下了：管剪辑出片 · 简短直接 · 抖音和小红书都发 · 撤销')
    expect(thread().querySelector('[data-bot-intake-closing]')!.textContent).toBe(
      '好了。以后剪辑出片的活直接找我，别的事还是找 APEX。我们记得的「关于你」是同一份，你不用再介绍一遍自己。'
    )

    const answers = { platform: 'same' as const, role: 'editing' as const, style: 'brief' as const }
    expect(bot().soul).toBe(`${TEMPLATE}\n${divisionSection(answers, 'zh')}`)
    expect(bot().uiMeta[BOT_INTAKE_META_KEY]).toEqual({ answers, status: 'noted', v: 1 })
    expect(englishWords(readableText(thread()))).toEqual([])
  })

  it('撤销 puts the SOUL back byte for byte and says so; the cards stay folded', async () => {
    engineWith()
    renderIntake()

    await pick('role', '带货脚本')
    await pick('style', '像朋友聊天')
    await pick('platform', '快手')
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))

    await waitFor(() => expect(thread().querySelector('[data-first-open-noted="undone"]')).not.toBeNull())
    expect(thread().querySelector('[data-first-open-noted]')!.textContent).toBe('已撤销，这三条不记')
    expect(thread().querySelector('[data-bot-intake-closing]')!.textContent).toBe(
      '好，先不定分工。想让我管什么，随时跟我说。'
    )
    expect(bot().soul).toBe(TEMPLATE)
    expect(bot().uiMeta[BOT_INTAKE_META_KEY]).toEqual({ answers: {}, status: 'undone', v: 1 })
    expect(answeredCards()).toHaveLength(3)
  })

  it('a failed undo says so and offers it again', async () => {
    const engine = engineWith()
    renderIntake()

    await pick('role', '剪辑出片')
    await pick('style', '简短直接')
    await pick('platform', '抖音')
    engine.failNext('soul')
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))

    expect(await screen.findByText('没撤销成功，请再点一次撤销。')).toBeTruthy()
    expect(bot().soul).toContain('## 分工')

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(bot().soul).toBe(TEMPLATE))
  })

  it('takes a typed role from 「别的，我直接说」', async () => {
    engineWith()
    renderIntake()
    const card = await waitForCard('role')
    const box = within(card).getByRole('textbox', { name: '别的，我直接说' })

    fireEvent.change(box, { target: { value: '直播切片' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    await waitForCard('style')
    expect(answeredCards()[0].textContent).toBe('我主要帮你做什么？E直播切片')
    expect(text()).toContain('直播切片，明白。')
    expect(bot().soul).toContain('- 主要帮用户：直播切片')
  })

  it('keeps the card open with a retry line when the answer did not save', async () => {
    engineWith().failNext('soul')
    renderIntake()

    await pick('role', '剪辑出片')

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '没记上，请再点一次。')
    expect(openCard()?.dataset.firstOpenCard).toBe('role')
    expect(bot().soul).toBe(TEMPLATE)

    await pick('role', '剪辑出片')
    await waitForCard('style')
  })

  it('offers no 「跟 APEX 一样」 when the account has no platform answer', async () => {
    install([])
    engineWith({ [BOT_INTAKE_META_KEY]: { answers: { role: 'editing', style: 'brief' }, status: 'asking', v: 1 } })
    renderIntake()

    const card = await waitForCard('platform')

    expect(optionLabels(card)).toEqual(['A抖音', 'B小红书', 'C视频号', 'D抖音和小红书都发', 'E快手', 'FB 站'])
  })

  it('holds the platform card until the account’s answer is read', async () => {
    let answer = (_: DesktopCreatorProfileResult) => {}

    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
      managed: { creatorProfile: () => new Promise<DesktopCreatorProfileResult>(resolve => (answer = resolve)) }
    }
    engineWith({ [BOT_INTAKE_META_KEY]: { answers: { role: 'editing', style: 'brief' }, status: 'asking', v: 1 } })
    renderIntake()

    await waitFor(() => expect(answeredCards()).toHaveLength(2))
    expect(openCard()).toBeNull()
    expect(text()).not.toContain('好，最后一个。')

    answer({
      ok: true,
      profile: {
        answers: { contentType: 'vlog', contentTypeOther: null, painPoint: null, platforms: ['kuaishou'] },
        intake: { completed: true, nextStep: null, skipped: [] }
      }
    })

    expect(optionLabels(await waitForCard('platform'))[0]).toBe('A跟 APEX 一样：快手')
  })

  it('resumes where it stopped after the app restarts', async () => {
    engineWith({ [BOT_INTAKE_META_KEY]: { answers: { role: 'breakdown' }, status: 'asking', v: 1 } })
    renderIntake()

    await waitForCard('style')
    expect(answeredCards().map(card => card.textContent)).toEqual(['我主要帮你做什么？B拆爆款、找选题'])
    expect(text()).toContain('拆爆款、找选题，明白。')
  })

  it('once noted before, shows the folded answers and the closing line, but no undo', async () => {
    engineWith({
      [BOT_INTAKE_META_KEY]: { answers: { platform: 'same', role: 'editing', style: 'brief' }, status: 'noted', v: 1 }
    })
    renderIntake()

    await waitFor(() => expect(answeredCards()).toHaveLength(3))
    expect(openCard()).toBeNull()
    expect(thread().querySelector('[data-first-open-noted]')).toBeNull()
    expect(thread().querySelector('[data-bot-intake-closing]')!.textContent).toContain('以后剪辑出片的活直接找我')
  })

  it('once undone before, asks nothing again', async () => {
    engineWith({ [BOT_INTAKE_META_KEY]: { answers: {}, status: 'undone', v: 1 } })
    renderIntake()

    await screen.findByText('好，先不定分工。想让我管什么，随时跟我说。')
    expect(openCard()).toBeNull()
    expect(answeredCards()).toHaveLength(0)
  })

  it('shows only the greeting while the record is read, or when it cannot be', async () => {
    gateway.engine = fakeProfileEngine({ default: { soul: 'APEX\n' } })
    renderIntake()

    await waitFor(() => expect(gateway.engine!.calls.length).toBeGreaterThan(0))
    expect(text()).toBe('你好，我是剪辑助手。你的账号情况 APEX 已经告诉我了，不用再说一遍。')
  })

  it.each([
    [
      'zh-hant' as const,
      '你好，我是剪辑助手。你的帳號情況 APEX 已經告訴我了，不用再說一遍。',
      '我主要幫你做什麼？1 / 3'
    ],
    [
      'en' as const,
      'Hi, I’m 剪辑助手. APEX already told me about your account, so no need to say it again.',
      'What should I mainly help you with?1 / 3'
    ]
  ])('speaks %s', async (locale, greeting, title) => {
    setRuntimeI18nLocale(locale)
    engineWith()
    renderIntake(locale)
    const card = await waitForCard('role')

    expect(text()).toContain(greeting)
    expect(card.querySelector('h3')!.textContent).toBe(title)
  })
})

describe('hc-1079: the empty thread of each assistant', () => {
  const ROWS = [
    { name: 'apex-bot-2', ui_meta: { apex: { created: 1, name: '剪辑助手' } } },
    { name: 'apex-bot-3', ui_meta: { apex: { created: 2, name: '带货脚本' } } }
  ]

  const show = (profile: string) =>
    act(() => {
      $activeGatewayProfile.set(profile)
      $mainThread.set({ ids: [], profile, rootId: null, status: 'absent', tipId: null })
    })

  function renderEmptyThread() {
    return render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <div data-testid="thread">
            <SingleThreadEmptyState />
          </div>
        </I18nProvider>
      </MemoryRouter>
    )
  }

  beforeEach(() => {
    setRuntimeI18nLocale('zh')
    resetBotIntakeForTest()
    resetMainThreadForTest()
    $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
    $authState.set({
      account: { email: 'a@example.test', name: '小满', plan: 'free' },
      accountId: 'acc-1',
      enabled: true,
      gateReason: null,
      loginTruth: true,
      status: 'signed-in'
    })
    install()
    setSingleThreadFlagForTest(true)
    setMultiBotFlagForTest(true)
    resetBotRosterForTest(botRosterFrom(ROWS, () => true))
    gateway.engine = fakeProfileEngine({
      'apex-bot-2': { soul: TEMPLATE },
      'apex-bot-3': { soul: TEMPLATE.replace('剪辑助手', '带货脚本') },
      default: { soul: 'APEX\n' }
    })
  })

  afterEach(() => {
    cleanup()
    setMultiBotFlagForTest(false)
    setSingleThreadFlagForTest(false)
    resetBotRosterForTest()
    resetMainThreadForTest()
    $activeGatewayProfile.set('default')
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
  })

  it('an assistant the user made asks its own three questions in its own name', async () => {
    await show('apex-bot-2')
    renderEmptyThread()

    const card = await waitForCard('role')

    expect(thread().querySelector('p')!.textContent).toBe(
      '你好，我是剪辑助手。你的账号情况 APEX 已经告诉我了，不用再说一遍。'
    )
    expect(card.querySelector('h3')!.textContent).toBe('我主要帮你做什么？1 / 3')
    expect(text()).not.toMatch(/你主要做什么内容|这个名字不喜欢/)
  })

  it('switching to another assistant starts its own cards; the first one’s answer stays with it', async () => {
    await show('apex-bot-2')
    renderEmptyThread()
    await pick('role', '剪辑出片')
    await waitForCard('style')

    await show('apex-bot-3')
    await screen.findByText('你好，我是带货脚本。你的账号情况 APEX 已经告诉我了，不用再说一遍。')
    await waitForCard('role')

    expect(answeredCards()).toHaveLength(0)
    expect(gateway.engine!.profiles.get('apex-bot-3')!.soul).not.toContain('## 分工')
    expect(gateway.engine!.profiles.get('apex-bot-2')!.soul).toContain('- 主要帮用户：剪辑出片')
  })

  it('APEX on screen keeps its own first open', async () => {
    await show('default')
    renderEmptyThread()

    await screen.findByText('你好，我是 APEX，帮你做短视频的。这个名字不喜欢的话，随时跟我说一声就能改。')
    expect(gateway.engine!.calls).toEqual([])
  })
})
