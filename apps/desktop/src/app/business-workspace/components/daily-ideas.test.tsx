import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DesktopDailyIdeaCard,
  DesktopDailyIdeaKind,
  DesktopDailyIdeasRequest,
  DesktopDailyIdeasResult
} from '@/global'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { resetDailyIdeasForTest } from '@/store/daily-ideas'
import { englishWords, readableText } from '@/test/zh-copy'

import { DAILY_IDEAS_COPY } from '../daily-ideas-copy'
import { BusinessStartHome } from '../pages/start-page'

import { DAILY_IDEAS_PENDING_REFRESH_LIMIT, DAILY_IDEAS_PENDING_REFRESH_MS, DailyIdeas } from './daily-ideas'

const KINDS: DesktopDailyIdeaKind[] = ['hot', 'structure', 'own']
const TITLES = ['换季收纳五件事', '九块九好物实测', '照着《厨房改造》拍一条你的版本', '双十一前避坑', '租房桌面改造', '收纳盒实测', '通勤包里有什么']

function idea(n: number): DesktopDailyIdeaCard {
  const kind = KINDS[n % 3]

  return {
    hook: '先看之前。',
    how: `一镜到底第 ${n} 种拍法`,
    id: `idea-${n}`,
    kind,
    lowEdit: false,
    noFace: n % 2 === 0,
    source:
      kind === 'hot'
        ? { label: '抖音热点词榜', observedAt: '2026-10-21T06:00:00', url: `https://www.douyin.com/hot/${n}` }
        : kind === 'structure'
          ? { label: 'APEX 常用选题库', observedAt: null, url: null }
          : { label: '你自己的拆解记录 · 只有你能看到', observedAt: '2026-10-15T20:00:00', url: null },
    started: false,
    startPrompt: `用今天的点子开工：「${TITLES[n]}」。`,
    title: TITLES[n],
    why: kind === 'hot' ? `今天抖音热点词榜上有「${TITLES[n]}」` : '好物测评常用的低价实测结构'
  }
}

/** The cloud in miniature: pages of three, 不喜欢 drops a card for the day, 开做 marks it. */
function cloud({ complete = true, pending = false, total = 6 } = {}) {
  const pool = Array.from({ length: total }, (_, n) => idea(n))
  const disliked = new Set<string>()
  const started = new Set<string>()
  const reads: number[] = []
  const feedback: object[] = []
  const state = { failFeedback: false, pending }

  const bridge = vi.fn(async (request: DesktopDailyIdeasRequest): Promise<DesktopDailyIdeasResult> => {
    if (!request.platformOn) {
      return { enabled: false, ok: true, page: null }
    }

    if (request.action === 'feedback') {
      if (state.failFeedback) {
        return { enabled: true, message: 'FETCH_FAILED', ok: false, page: null }
      }

      feedback.push({ ideaId: request.ideaId, kind: request.kind, reason: request.reason })
      ;(request.kind === 'dislike' ? disliked : started).add(request.ideaId)

      return { enabled: true, ok: true, page: null }
    }

    const page = request.page ?? 0
    reads.push(page)
    const left = pool.filter(card => !disliked.has(card.id))

    return {
      enabled: true,
      ok: true,
      page: {
        cards: left.slice(page * 3, page * 3 + 3).map(card => ({ ...card, started: started.has(card.id) })),
        day: '2026-10-21',
        more: left.length > page * 3 + 3,
        page,
        pending: state.pending,
        profile: { complete, summary: complete ? '好物测评 · 抖音 · 没选题' : '' }
      }
    }
  })

  return { bridge, feedback, reads, state }
}

const openExternal = vi.fn(async () => undefined)

function install(bridge: ReturnType<typeof cloud>['bridge'] | undefined, flag = true) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = bridge
    ? {
        clientConfig: { get: async () => ({ payload: { desktop_features: { daily_ideas: flag } } }) },
        managed: { dailyIdeas: bridge },
        openExternal
      }
    : undefined
}

function signIn(accountId: null | string = 'acc-1') {
  $authState.set({
    account: { email: 'a@example.test', name: '小林', plan: 'free' },
    accountId,
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-in'
  })
}

function Where() {
  const location = useLocation()

  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>
}

function renderIdeas(onStart: (prompt: string) => boolean | Promise<boolean> = async () => true) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <I18nProvider configClient={null} initialLocale="zh">
        <DailyIdeas onStart={onStart} />
        <Where />
      </I18nProvider>
    </MemoryRouter>
  )
}

const zh = DAILY_IDEAS_COPY.zh

function cardTitles(): string[] {
  return [...window.document.querySelectorAll('[data-daily-idea] h3')].map(node => node.textContent ?? '')
}

describe('今日点子 on the Start page (hc-995)', () => {
  beforeEach(() => {
    setRuntimeI18nLocale('zh')
    resetDailyIdeasForTest()
    openExternal.mockClear()
    signIn()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    install(undefined)
  })

  it('stays hidden until the platform turns it on, and asks the cloud nothing it would answer with cards', async () => {
    const { bridge } = cloud()
    install(bridge, false)
    const { container } = renderIdeas()

    await waitFor(() => expect(bridge).toHaveBeenCalledTimes(1))
    expect(bridge.mock.calls[0][0]).toEqual({ action: 'get', page: 0, platformOn: false })
    expect(container.querySelector('[data-daily-ideas]')).toBeNull()
  })

  it('shows three cards in Chinese with what to shoot, how, and why today', async () => {
    install(cloud().bridge)
    const { container } = renderIdeas()

    expect(await screen.findByRole('heading', { name: zh.title })).toBeTruthy()
    expect(screen.getByText('按你的档案（好物测评 · 抖音 · 没选题）和今天的热点挑的 · 每天早上 6 点换一批')).toBeTruthy()
    expect(cardTitles()).toEqual(TITLES.slice(0, 3))

    const first = container.querySelector('[data-daily-idea="idea-0"]') as HTMLElement
    expect(within(first).getByText('今天的热点')).toBeTruthy()
    expect(within(first).getByText('怎么拍：一镜到底第 0 种拍法')).toBeTruthy()
    expect(within(first).getByText('依据：今天抖音热点词榜上有「换季收纳五件事」')).toBeTruthy()
    expect(within(container.querySelector('[data-daily-idea="idea-1"]') as HTMLElement).getByText('常用结构')).toBeTruthy()
    expect(within(container.querySelector('[data-daily-idea="idea-2"]') as HTMLElement).getByText('你拆过的')).toBeTruthy()
    expect(screen.getByText(zh.startNote)).toBeTruthy()
    expect(englishWords(readableText(container))).toEqual([])
  })

  it('开做 sends the prepared request as the user and marks the card once chat took it', async () => {
    const { bridge, feedback } = cloud()
    install(bridge)
    const onStart = vi.fn(async () => true)
    const { container } = renderIdeas(onStart)
    const card = (await screen.findByText(TITLES[1])).closest('[data-daily-idea]') as HTMLElement

    fireEvent.click(within(card).getByRole('button', { name: '开做' }))

    await waitFor(() => expect(within(card).getByText('已开做')).toBeTruthy())
    expect(onStart).toHaveBeenCalledExactlyOnceWith('用今天的点子开工：「九块九好物实测」。')
    await waitFor(() => expect(feedback).toEqual([{ ideaId: 'idea-1', kind: 'start', reason: undefined }]))
    expect(container.querySelectorAll('[data-daily-idea-started]')).toHaveLength(1)
  })

  it('开做 that chat refused leaves the card as it was', async () => {
    const { bridge, feedback } = cloud()
    install(bridge)
    renderIdeas(async () => false)
    const card = (await screen.findByText(TITLES[0])).closest('[data-daily-idea]') as HTMLElement

    fireEvent.click(within(card).getByRole('button', { name: '开做' }))
    await act(async () => {})

    expect(within(card).queryByText('已开做')).toBeNull()
    expect(feedback).toEqual([])
  })

  it('不喜欢 asks why, swaps only that card, and 算了 changes nothing', async () => {
    const { bridge, feedback } = cloud()
    install(bridge)
    renderIdeas()
    const middle = (await screen.findByText(TITLES[1])).closest('[data-daily-idea]') as HTMLElement

    fireEvent.click(within(middle).getByRole('button', { name: '不喜欢' }))
    const question = within(middle).getByRole('group', { name: zh.dislikeQuestion })

    for (const reason of ['不是我的方向', '太难拍', '不想追这个热点']) {
      expect(within(question).getByRole('button', { name: reason })).toBeTruthy()
    }

    fireEvent.click(within(question).getByRole('button', { name: '算了' }))
    expect(within(middle).getByRole('button', { name: '开做' })).toBeTruthy()
    expect(feedback).toEqual([])

    fireEvent.click(within(middle).getByRole('button', { name: '不喜欢' }))
    fireEvent.click(within(middle).getByRole('button', { name: '太难拍' }))

    await waitFor(() => expect(cardTitles()).toEqual([TITLES[0], TITLES[2], TITLES[3]]))
    expect(feedback).toEqual([{ ideaId: 'idea-1', kind: 'dislike', reason: 'too_hard' }])
  })

  it('a 不喜欢 the cloud did not take says so and keeps the card', async () => {
    const { bridge, state } = cloud()
    install(bridge)
    renderIdeas()
    const card = (await screen.findByText(TITLES[0])).closest('[data-daily-idea]') as HTMLElement

    state.failFeedback = true
    fireEvent.click(within(card).getByRole('button', { name: '不喜欢' }))
    fireEvent.click(within(card).getByRole('button', { name: '不是我的方向' }))

    expect((await within(card).findByRole('alert')).textContent).toBe(zh.dislikeFailed)
    expect(cardTitles()).toEqual(TITLES.slice(0, 3))
  })

  it('看来源 says where the 依据 came from and when, and opens only a real link', async () => {
    install(cloud().bridge)
    renderIdeas()
    const hot = (await screen.findByText(TITLES[0])).closest('[data-daily-idea]') as HTMLElement

    fireEvent.click(within(hot).getByRole('button', { name: '看来源' }))
    expect(within(hot).getByText(/抖音热点词榜 · 今天 06:00 读取/)).toBeTruthy()
    fireEvent.click(within(hot).getByRole('button', { name: '打开原链接' }))
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://www.douyin.com/hot/0')
    fireEvent.click(within(hot).getByRole('button', { name: '收起来源' }))
    expect(hot.querySelector('[data-daily-idea-source]')).toBeNull()

    const structure = screen.getByText(TITLES[1]).closest('[data-daily-idea]') as HTMLElement
    fireEvent.click(within(structure).getByRole('button', { name: '看来源' }))
    expect(within(structure).getByText('APEX 常用选题库')).toBeTruthy()
    expect(within(structure).queryByRole('button', { name: '打开原链接' })).toBeNull()

    const own = screen.getByText(TITLES[2]).closest('[data-daily-idea]') as HTMLElement
    fireEvent.click(within(own).getByRole('button', { name: '看来源' }))
    expect(own.querySelector('[data-daily-idea-source]')?.textContent).toBe('你自己的拆解记录 · 只有你能看到')
  })

  it('换一批 shows the next three, and once all are gone it offers the first set again', async () => {
    const { bridge, reads } = cloud({ total: 4 })
    install(bridge)
    renderIdeas()

    fireEvent.click(await screen.findByRole('button', { name: '换一批' }))
    await waitFor(() => expect(cardTitles()).toEqual([TITLES[3]]))
    expect(screen.queryByRole('button', { name: '换一批' })).toBeNull()

    const last = screen.getByText(TITLES[3]).closest('[data-daily-idea]') as HTMLElement
    fireEvent.click(within(last).getByRole('button', { name: '不喜欢' }))
    fireEvent.click(within(last).getByRole('button', { name: '不想追这个热点' }))

    expect(await screen.findByText(zh.allSeen)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '回到第一组' }))
    await waitFor(() => expect(cardTitles()).toEqual(TITLES.slice(0, 3)))
    expect(reads).toEqual([0, 1, 1, 0])
  })

  it('without a profile it says so and links to the profile settings', async () => {
    install(cloud({ complete: false }).bridge)
    renderIdeas()

    expect(await screen.findByText(zh.subtitleNoProfile)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '填一下档案' }))
    expect(screen.getByTestId('where').textContent).toBe('/settings?tab=config:personalization')
  })

  it('while today’s hot ideas are picked it looks again a few times, then stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { bridge, reads, state } = cloud({ pending: true })
    install(bridge)
    renderIdeas()

    expect(await screen.findByText(zh.subtitlePending)).toBeTruthy()

    for (let n = 1; n <= DAILY_IDEAS_PENDING_REFRESH_LIMIT + 1; n += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DAILY_IDEAS_PENDING_REFRESH_MS)
      })
    }

    expect(reads).toHaveLength(1 + DAILY_IDEAS_PENDING_REFRESH_LIMIT)

    state.pending = false
    resetDailyIdeasForTest()
    cleanup()
    renderIdeas()
    expect(await screen.findByText(/和今天的热点挑的/)).toBeTruthy()
  })

  it('every locale has its own copy for every line', () => {
    for (const copy of Object.values(DAILY_IDEAS_COPY)) {
      expect(Object.values(copy.kinds).every(Boolean)).toBe(true)
      expect(Object.values(copy.reasons).every(Boolean)).toBe(true)
      expect(copy.subtitleHot('x')).toContain('x')
      expect(copy.sourceRead('label', '06:00')).toContain('06:00')
    }

    expect(englishWords(Object.values(DAILY_IDEAS_COPY.zh).filter(value => typeof value === 'string').join(' '))).toEqual([])
  })
})

describe('the Start page wires 开做 to chat (hc-995)', () => {
  beforeEach(() => {
    setRuntimeI18nLocale('zh')
    resetDailyIdeasForTest()
    signIn()
  })

  afterEach(() => {
    cleanup()
    install(undefined)
  })

  it('a card’s 开做 submits its prepared request through the Start page’s chat submit', async () => {
    install(cloud().bridge)
    const onSubmitGoal = vi.fn(async () => true)

    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="zh">
          <BusinessStartHome onSubmitGoal={onSubmitGoal} />
        </I18nProvider>
      </MemoryRouter>
    )

    const card = (await screen.findByText(TITLES[2])).closest('[data-daily-idea]') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: '开做' }))

    await waitFor(() => expect(onSubmitGoal).toHaveBeenCalledExactlyOnceWith('用今天的点子开工：「照着《厨房改造》拍一条你的版本」。'))
    await waitFor(() => expect(within(card).getByText('已开做')).toBeTruthy())
  })
})
