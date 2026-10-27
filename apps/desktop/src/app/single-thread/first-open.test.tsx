import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Focus from '@/app/chat/composer/focus'
import type {
  DesktopCreatorIntakeStep,
  DesktopCreatorProfile,
  DesktopCreatorProfilePatch,
  DesktopCreatorProfileRequest,
  DesktopCreatorProfileResult,
  DesktopDailyIdeaCard,
  DesktopDailyIdeasRequest,
  DesktopDailyIdeasResult
} from '@/global'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $creatorProfile } from '@/store/creator-profile'
import { resetDailyIdeasForTest } from '@/store/daily-ideas'
import { resetMainThreadForTest } from '@/store/main-thread'
import { $activeGatewayProfile } from '@/store/profile'
import { $gatewayState } from '@/store/session'
import { setSingleThreadFlagForTest } from '@/store/single-thread'
import { botRosterFrom, resetBotRosterForTest, setMultiBotFlagForTest } from '@/store/single-thread-bots'
import { englishWords, readableText } from '@/test/zh-copy'

import { FirstOpen } from './first-open'
import { SingleThreadEmptyState } from './thread-empty'

const submits = vi.hoisted(() => ({ accept: true, texts: [] as string[] }))

vi.mock('@/app/chat/composer/focus', async importOriginal => ({
  ...(await importOriginal<typeof Focus>()),
  requestComposerSubmit: (text: string, options?: { target?: string }) => {
    submits.texts.push(`${options?.target}:${text}`)

    return submits.accept
  }
}))

const STEPS: DesktopCreatorIntakeStep[] = ['content_type', 'platforms', 'pain_point']

/**
 * The cloud's intake rules (apex-nodes creator_intake_service): an answer or a
 * skip resolves a step, and the first time all three are resolved the intake is
 * finished for good — clearing answers later never reopens the cards.
 */
function cloud(start: Partial<DesktopCreatorProfile['answers']> = {}, skippedAtStart: DesktopCreatorIntakeStep[] = []) {
  const answers: DesktopCreatorProfile['answers'] = {
    contentType: null,
    contentTypeOther: null,
    painPoint: null,
    platforms: [],
    ...start
  }

  const skipped = new Set(skippedAtStart)
  const patches: DesktopCreatorProfilePatch[] = []
  let completedAt = false
  let failNext = false

  const answered = (step: DesktopCreatorIntakeStep) =>
    step === 'content_type'
      ? Boolean(answers.contentType)
      : step === 'platforms'
        ? answers.platforms.length > 0
        : Boolean(answers.painPoint)

  const profile = (): DesktopCreatorProfile => {
    const pending = STEPS.filter(step => !answered(step) && !skipped.has(step))
    completedAt ||= pending.length === 0

    return {
      answers: { ...answers, platforms: [...answers.platforms] },
      intake: { completed: completedAt, nextStep: completedAt ? null : pending[0], skipped: [...skipped] }
    }
  }

  profile()

  const bridge = vi.fn(async (request: DesktopCreatorProfileRequest): Promise<DesktopCreatorProfileResult> => {
    if (request.action === 'save') {
      if (failNext) {
        failNext = false

        return { message: 'FETCH_FAILED', ok: false, profile: null }
      }

      const { patch } = request
      patches.push(patch)

      if ('contentType' in patch) {
        answers.contentType = patch.contentType ?? null
        answers.contentTypeOther = patch.contentType === 'other' ? (patch.contentTypeOther ?? null) : null
      }

      if ('platforms' in patch) {
        answers.platforms = patch.platforms ?? []
      }

      if ('painPoint' in patch) {
        answers.painPoint = patch.painPoint ?? null
      }
    }

    return { ok: true, profile: profile() }
  })

  return { answers, bridge, failOnce: () => void (failNext = true), patches }
}

function idea(n: number, kind: DesktopDailyIdeaCard['kind']): DesktopDailyIdeaCard {
  return {
    hook: '先看之前。',
    how: `前后对比，第 ${n} 种拍法`,
    id: `idea-${n}`,
    kind,
    lowEdit: false,
    noFace: true,
    source: { label: '抖音热点词榜', observedAt: null, url: null },
    started: false,
    startPrompt: `用今天的点子开工：第 ${n} 个。`,
    title: `换季收纳第 ${n} 招`,
    why: '今天的热点'
  }
}

function ideasCloud(kinds: DesktopDailyIdeaCard['kind'][] = ['hot', 'structure', 'own']) {
  const feedback: string[] = []

  const bridge = vi.fn(async (request: DesktopDailyIdeasRequest): Promise<DesktopDailyIdeasResult> => {
    if (!request.platformOn) {
      return { enabled: false, ok: true, page: null }
    }

    if (request.action === 'feedback') {
      feedback.push(`${request.kind}:${request.ideaId}`)

      return { enabled: true, ok: true, page: null }
    }

    return {
      enabled: true,
      ok: true,
      page: {
        cards: kinds.map((kind, n) => idea(n + 1, kind)),
        day: '2026-10-26',
        more: false,
        page: 0,
        pending: false,
        profile: { complete: true, summary: '好物测评 · 抖音' }
      }
    }
  })

  return { bridge, feedback }
}

function install({
  creator,
  ideas,
  ideasOn = false
}: {
  creator?: ReturnType<typeof cloud>['bridge']
  ideas?: ReturnType<typeof ideasCloud>['bridge']
  ideasOn?: boolean
}) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = {
    clientConfig: {
      get: async () => ({ payload: { desktop_features: { daily_ideas: ideasOn, single_thread: true } } })
    },
    managed: { creatorProfile: creator, dailyIdeas: ideas }
  }
}

function signIn(status: 'checking' | 'signed-in' | 'signed-out' = 'signed-in') {
  $authState.set({
    account: { email: 'a@example.test', name: '小满', plan: 'free' },
    accountId: status === 'signed-out' ? null : 'acc-1',
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status
  })
}

function renderFirstOpen() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <div data-testid="thread">
          <FirstOpen />
        </div>
      </I18nProvider>
    </MemoryRouter>
  )
}

const thread = () => screen.getByTestId('thread')
/** What the conversation says, option letters included (readableText leaves keycaps out). */
const text = () => thread().textContent ?? ''
const said = (element: Element) => element.textContent ?? ''

const openCard = () =>
  thread().querySelector<HTMLElement>('[data-first-open-card]:not([data-first-open-card="answered"])')

const answeredCards = () => [...thread().querySelectorAll<HTMLElement>('[data-first-open-card="answered"]')]
const optionLabels = (card: HTMLElement) => within(card).getAllByRole('button').map(said)

async function pick(label: string) {
  const card = await waitFor(() => {
    const open = openCard()
    expect(open).not.toBeNull()

    return open!
  })

  fireEvent.click(within(card).getByRole('button', { name: new RegExp(label) }))
}

describe('hc-1063 第一次打开: the intake asked inside the conversation', () => {
  beforeEach(() => {
    setRuntimeI18nLocale('zh')
    $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
    resetDailyIdeasForTest()
    $gatewayState.set('open')
    submits.texts.length = 0
    submits.accept = true
    signIn()
  })

  afterEach(() => {
    cleanup()
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
  })

  it('greets with the rename line, then asks card 1 of 3 with a tap per option and nothing to skip or confirm', async () => {
    install({ creator: cloud().bridge })
    renderFirstOpen()

    const card = await waitFor(() => {
      expect(openCard()).not.toBeNull()

      return openCard()!
    })

    expect(text()).toContain('你好，我是 APEX，帮你做短视频的。这个名字不喜欢的话，随时跟我说一声就能改。')
    expect(text()).toContain('先问 3 个小问题，答完我就知道怎么帮你。点一下就行，也可以直接打字。')
    expect(said(card.querySelector('h3')!)).toBe('你主要做什么内容？1 / 3')
    expect(optionLabels(card)).toEqual(['A好物测评', 'B知识口播', 'C探店', 'D剧情', 'EVlog'])
    expect(within(card).getByRole('textbox', { name: '其他（自己写）' })).toBeTruthy()
    expect(text()).not.toMatch(/先跳过|继续|第 1 题/)
    // The tip and the ideas wait until the intake is done.
    expect(thread().querySelector('[data-first-open-tip]')).toBeNull()
    expect(englishWords(readableText(thread()))).toEqual([])
  })

  it('folds each answered card to its question and pick, with APEX’s line before the next card', async () => {
    const { bridge, patches } = cloud()
    install({ creator: bridge })
    renderFirstOpen()

    await pick('好物测评')
    await waitFor(() => expect(said(openCard()!.querySelector('h3')!)).toBe('主要发在哪？2 / 3'))

    expect(patches).toEqual([{ contentType: 'product_review' }])
    expect(answeredCards().map(said)).toEqual(['你主要做什么内容？A好物测评'])
    expect(text()).toContain('好物测评，懂了。')
    expect(optionLabels(openCard()!)).toEqual(['A抖音', 'B小红书', 'C视频号', 'D抖音和小红书都发', 'E快手', 'FB 站'])

    await pick('抖音和小红书都发')
    await waitFor(() => expect(said(openCard()!.querySelector('h3')!)).toBe('现在最头疼的是？3 / 3'))

    expect(patches[1]).toEqual({ platforms: ['douyin', 'xiaohongshu'] })
    expect(text()).toContain('好，最后一个。')
    expect(optionLabels(openCard()!)).toEqual([
      'A不知道拍什么',
      'B拍了没人看',
      'C剪辑太费时间',
      'D不会写文案',
      'E不会拍'
    ])

    // The order on screen is the conversation's.
    const order = ['好物测评，懂了。', '主要发在哪？', '好，最后一个。', '现在最头疼的是？'].map(line =>
      text().indexOf(line)
    )

    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('says 「✓ APEX 记下了」 with the three answers once the last card is tapped, then the tip', async () => {
    const { bridge, patches } = cloud()
    install({ creator: bridge })
    renderFirstOpen()

    await pick('好物测评')
    await pick('抖音和小红书都发')
    await pick('不知道拍什么')

    const noted = await waitFor(() => {
      const line = thread().querySelector<HTMLElement>('[data-first-open-noted="noted"]')
      expect(line).not.toBeNull()

      return line!
    })

    expect(patches[2]).toEqual({ painPoint: 'no_topic' })
    expect(said(noted)).toBe('APEX 记下了：好物测评 · 抖音和小红书都发 · 最头疼不知道拍什么 · 撤销')
    expect(noted.querySelector('svg')).not.toBeNull()
    expect(openCard()).toBeNull()
    expect(answeredCards()).toHaveLength(3)
    expect(thread().querySelector('[data-first-open-tip]')!.textContent).toBe(
      '以后直接贴链接就行。懒得打字的话，点右下角那个圆按钮跟我说。我们就在这一个对话里聊，不用开新的。'
    )
  })

  it('undoes for real: the answers are cleared, the folded cards stay and no card comes back', async () => {
    const { answers, bridge, patches } = cloud()
    install({ creator: bridge })
    renderFirstOpen()

    await pick('好物测评')
    await pick('抖音和小红书都发')
    await pick('不知道拍什么')
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))

    const undone = await waitFor(() => {
      const line = thread().querySelector<HTMLElement>('[data-first-open-noted="undone"]')
      expect(line).not.toBeNull()

      return line!
    })

    expect(patches.at(-1)).toEqual({ contentType: null, contentTypeOther: null, painPoint: null, platforms: [] })
    expect(answers).toEqual({ contentType: null, contentTypeOther: null, painPoint: null, platforms: [] })
    expect(said(undone)).toBe('已撤销，这三条不记')
    expect(undone.querySelector('svg')).toBeNull()
    expect(answeredCards()).toHaveLength(3)
    expect(openCard()).toBeNull()
  })

  it('takes a typed content type from the 其他 row on Enter', async () => {
    const { bridge, patches } = cloud()
    install({ creator: bridge })
    renderFirstOpen()

    const box = await screen.findByRole('textbox', { name: '其他（自己写）' })
    fireEvent.change(box, { target: { value: '宠物日常' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    await waitFor(() => expect(patches).toEqual([{ contentType: 'other', contentTypeOther: '宠物日常' }]))
    await waitFor(() => expect(answeredCards().map(said)).toEqual(['你主要做什么内容？F宠物日常']))
    expect(text()).toContain('宠物日常，懂了。')
  })

  it('keeps the card and says so when the answer did not save', async () => {
    const { bridge, failOnce, patches } = cloud()
    install({ creator: bridge })
    renderFirstOpen()

    failOnce()
    await pick('探店')

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '没记上，请再点一次。')
    expect(said(openCard()!.querySelector('h3')!)).toBe('你主要做什么内容？1 / 3')

    await pick('探店')
    await waitFor(() => expect(patches).toEqual([{ contentType: 'store_visit' }]))
  })

  it('shows answers given earlier as folded cards, without a 记下了 line, then the tip', async () => {
    install({
      creator: cloud({ contentType: 'vlog', painPoint: 'no_editing', platforms: ['kuaishou', 'bilibili'] }).bridge
    })
    renderFirstOpen()

    await waitFor(() => expect(answeredCards()).toHaveLength(3))

    // A mix chosen in Settings has no single option, so it shows without a letter.
    expect(answeredCards().map(said)).toEqual([
      '你主要做什么内容？EVlog',
      '主要发在哪？快手、B 站',
      '现在最头疼的是？C剪辑太费时间'
    ])
    expect(thread().querySelector('[data-first-open-noted]')).toBeNull()
    expect(thread().querySelector('[data-first-open-tip]')).not.toBeNull()
  })

  it('asks only what is left after a skip on the Start page, and folds nothing for the skipped card', async () => {
    install({ creator: cloud({ contentType: 'knowledge' }, ['platforms']).bridge })
    renderFirstOpen()

    await waitFor(() => expect(said(openCard()!.querySelector('h3')!)).toBe('现在最头疼的是？3 / 3'))

    expect(answeredCards().map(said)).toEqual(['你主要做什么内容？B知识口播'])
    expect(text()).toContain('知识口播，懂了。')
    expect(text()).toContain('好，最后一个。')
    expect(text()).not.toContain('主要发在哪？')
  })

  it('greets and gives the tip without questions when every card was skipped or the account has no intake', async () => {
    install({ creator: cloud({}, STEPS).bridge })
    renderFirstOpen()

    await waitFor(() => expect(thread().querySelector('[data-first-open-tip]')).not.toBeNull())
    expect(text()).not.toContain('先问 3 个小问题')
    cleanup()

    $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
    install({ creator: undefined })
    renderFirstOpen()

    await waitFor(() => expect(thread().querySelector('[data-first-open-tip]')).not.toBeNull())
    expect(openCard()).toBeNull()
  })

  it('shows only the greeting while the profile or the sign-in is still being read', async () => {
    let answer: (value: DesktopCreatorProfileResult) => void = () => {}
    const creator = vi.fn(() => new Promise<DesktopCreatorProfileResult>(resolve => (answer = resolve)))
    install({ creator })
    renderFirstOpen()

    await waitFor(() => expect(creator).toHaveBeenCalled())
    expect(text()).toBe('你好，我是 APEX，帮你做短视频的。这个名字不喜欢的话，随时跟我说一声就能改。')

    await act(async () => answer({ ok: true, profile: null }))
    await waitFor(() => expect(thread().querySelector('[data-first-open-tip]')).not.toBeNull())
    cleanup()

    // App start: nothing read yet for anyone.
    $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
    signIn('checking')
    renderFirstOpen()
    expect(thread().querySelector('[data-first-open-tip]')).toBeNull()
  })

  it('mounts in the empty thread on `/`', async () => {
    resetMainThreadForTest()
    install({ creator: cloud().bridge })
    const { $mainThread } = await import('@/store/main-thread')
    $mainThread.set({ ids: [], profile: 'default', rootId: null, status: 'absent', tipId: null })

    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <SingleThreadEmptyState />
        </I18nProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText('你主要做什么内容？')).toBeTruthy()
    resetMainThreadForTest()
  })
})

describe('hc-1063 today’s ideas in the conversation (desktop_features.daily_ideas)', () => {
  beforeEach(() => {
    setRuntimeI18nLocale('zh')
    $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
    resetDailyIdeasForTest()
    $gatewayState.set('open')
    submits.texts.length = 0
    submits.accept = true
    signIn()
  })

  afterEach(() => {
    cleanup()
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
  })

  async function finishIntake() {
    await pick('好物测评')
    await pick('抖音和小红书都发')
    await pick('不知道拍什么')
  }

  it('after the 记下了 line: what they were picked from, then tag, title, 怎么拍 and 开做 on each card', async () => {
    install({ creator: cloud().bridge, ideas: ideasCloud().bridge, ideasOn: true })
    renderFirstOpen()
    await finishIntake()

    const group = await screen.findByRole('group', { name: '今天能拍的' })
    const cards = within(group).getAllByRole('article')

    expect(text()).toContain('那我先把今天能拍的备好。这 3 个是按你的赛道和今天的热点挑的：')
    expect(cards.map(said)).toEqual([
      '今天的热点换季收纳第 1 招怎么拍：前后对比，第 1 种拍法开做',
      '常用结构换季收纳第 2 招怎么拍：前后对比，第 2 种拍法开做',
      '你拆过的换季收纳第 3 招怎么拍：前后对比，第 3 种拍法开做'
    ])

    const order = ['APEX 记下了', '那我先把今天能拍的备好', '换季收纳第 1 招', '以后直接贴链接就行'].map(line =>
      text().indexOf(line)
    )

    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('开做 sends the card’s prepared request into this conversation and marks it started', async () => {
    const ideas = ideasCloud()
    install({ creator: cloud().bridge, ideas: ideas.bridge, ideasOn: true })
    renderFirstOpen()
    await finishIntake()

    const first = (await screen.findAllByRole('article'))[0]
    fireEvent.click(within(first).getByRole('button', { name: '开做' }))

    expect(submits.texts).toEqual(['main:用今天的点子开工：第 1 个。'])
    await waitFor(() => expect(ideas.feedback).toEqual(['start:idea-1']))
    await waitFor(() => expect(said(first)).toContain('已开做'))
  })

  it('does not mark a card started when the conversation did not take the request, nor while offline', async () => {
    const ideas = ideasCloud()
    install({ creator: cloud().bridge, ideas: ideas.bridge, ideasOn: true })
    submits.accept = false
    renderFirstOpen()
    await finishIntake()

    const first = (await screen.findAllByRole('article'))[0]
    fireEvent.click(within(first).getByRole('button', { name: '开做' }))
    // Let the store's background feedback call run, if anything started it.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    expect(submits.texts).toEqual(['main:用今天的点子开工：第 1 个。'])
    expect(said(first)).not.toContain('已开做')
    expect(ideas.feedback).toEqual([])
    act(() => $gatewayState.set('closed'))
    expect(within(first).getByRole('button', { name: '开做' })).toHaveProperty('disabled', true)
  })

  it('names only what the cards were really picked from', async () => {
    install({ creator: cloud().bridge, ideas: ideasCloud(['structure', 'own']).bridge, ideasOn: true })
    renderFirstOpen()
    await finishIntake()

    await screen.findByRole('group', { name: '今天能拍的' })
    expect(text()).toContain('那我先把今天能拍的备好。这 2 个是按你的赛道挑的：')
    expect(text()).not.toContain('热点挑的')
  })

  it('shows no ideas while the switch is off, and the tip still closes the first open', async () => {
    const ideas = ideasCloud()
    install({ creator: cloud().bridge, ideas: ideas.bridge, ideasOn: false })
    renderFirstOpen()
    await finishIntake()

    await waitFor(() => expect(thread().querySelector('[data-first-open-tip]')).not.toBeNull())
    await waitFor(() => expect(ideas.bridge).toHaveBeenCalled())
    expect(screen.queryByRole('group', { name: '今天能拍的' })).toBeNull()
    expect(text()).not.toContain('今天能拍的备好')
  })
})

describe('hc-1077 several assistants: only APEX brings today’s ideas (K7)', () => {
  beforeEach(() => {
    setRuntimeI18nLocale('zh')
    $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
    resetDailyIdeasForTest()
    $gatewayState.set('open')
    signIn()
    setSingleThreadFlagForTest(true)
    setMultiBotFlagForTest(true)
    resetBotRosterForTest(
      botRosterFrom([{ name: 'writer', ui_meta: { apex: { created: 1, name: '小红书文案' } } }], () => true)
    )
  })

  afterEach(() => {
    cleanup()
    setMultiBotFlagForTest(false)
    setSingleThreadFlagForTest(false)
    resetBotRosterForTest()
    $activeGatewayProfile.set('default')
    ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
  })

  it.each([
    ['APEX', 'default', true, 'APEX 记下了'],
    ['another assistant', 'writer', false, '小红书文案 记下了']
  ])('%s on screen: ideas %s, and it notes in its own name', async (_label, profile, ideasShown, noted) => {
    $activeGatewayProfile.set(profile)
    install({ creator: cloud().bridge, ideas: ideasCloud().bridge, ideasOn: true })
    renderFirstOpen()
    await pick('好物测评')
    await pick('抖音和小红书都发')
    await pick('不知道拍什么')

    await waitFor(() => expect(text()).toContain(noted))
    await waitFor(() => expect(text()).toContain('以后直接贴链接就行'))

    if (ideasShown) {
      expect(await screen.findByRole('group', { name: '今天能拍的' })).toBeTruthy()
    } else {
      await act(async () => new Promise(resolve => setTimeout(resolve, 50)))
      expect(screen.queryByRole('group', { name: '今天能拍的' })).toBeNull()
    }
  })
})
