import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DesktopCreatorIntakeStep,
  DesktopCreatorProfile,
  DesktopCreatorProfilePatch,
  DesktopCreatorProfileRequest,
  DesktopCreatorProfileResult
} from '@/global'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $creatorProfile } from '@/store/creator-profile'
import { englishWords, readableText } from '@/test/zh-copy'

import { CREATOR_INTAKE_COPY } from '../creator-intake-copy'

import { CreatorIntakeCards } from './creator-intake-cards'

const STEPS: DesktopCreatorIntakeStep[] = ['content_type', 'platforms', 'pain_point']

/** The cloud's rules in miniature: an answer or a skip resolves a step; three resolved complete the intake. */
function cloud(start: Partial<DesktopCreatorProfile['answers']> = {}) {
  const answers: DesktopCreatorProfile['answers'] = {
    contentType: null,
    contentTypeOther: null,
    painPoint: null,
    platforms: [],
    ...start
  }

  const skipped = new Set<DesktopCreatorIntakeStep>()
  const patches: DesktopCreatorProfilePatch[] = []
  let failNext = false

  const answered = (step: DesktopCreatorIntakeStep) =>
    step === 'content_type'
      ? Boolean(answers.contentType)
      : step === 'platforms'
        ? answers.platforms.length > 0
        : Boolean(answers.painPoint)

  const profile = (): DesktopCreatorProfile => {
    const pending = STEPS.filter(step => !answered(step) && !skipped.has(step))

    return {
      answers: { ...answers, platforms: [...answers.platforms] },
      intake: { completed: pending.length === 0, nextStep: pending[0] ?? null, skipped: [...skipped] }
    }
  }

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

      patch.skip?.forEach(step => skipped.add(step))
    }

    return { ok: true, profile: profile() }
  })

  return { bridge, failOnce: () => void (failNext = true), patches }
}

function install(bridge: ReturnType<typeof cloud>['bridge'] | undefined) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = bridge
    ? { managed: { creatorProfile: bridge } }
    : undefined
}

function signIn(accountId: string | null = 'acc-1', status: 'signed-in' | 'signed-out' = 'signed-in') {
  $authState.set({
    account: { email: 'a@example.test', name: '小林', plan: 'free' },
    accountId,
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status
  })
}

function renderCards() {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CreatorIntakeCards />
    </I18nProvider>
  )
}

const zh = CREATOR_INTAKE_COPY.zh

describe('first-use creator intake cards (hc-991)', () => {
  beforeEach(() => {
    setRuntimeI18nLocale('zh')
    $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
    signIn()
  })

  afterEach(() => {
    cleanup()
    install(undefined)
  })

  it('asks the first question in Chinese with every option, a typed answer and a skip', async () => {
    install(cloud().bridge)
    const { container } = renderCards()

    expect(await screen.findByRole('heading', { name: '你主要做什么内容？' })).toBeTruthy()
    expect(screen.getByText('第 1 题，共 3 题')).toBeTruthy()

    for (const label of ['好物测评', '知识口播', '探店', '剧情', 'Vlog']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy()
    }

    expect(screen.getByPlaceholderText('其他（自己写）')).toBeTruthy()
    expect(screen.getByRole('button', { name: '先跳过' })).toBeTruthy()
    expect(englishWords(readableText(container))).toEqual([])
  })

  it('a tap answers, the platforms card takes several, and the last tap completes it', async () => {
    const { bridge, patches } = cloud()
    install(bridge)
    renderCards()

    fireEvent.click(await screen.findByRole('button', { name: /好物测评/ }))

    expect(await screen.findByRole('heading', { name: '主要发在哪个平台？' })).toBeTruthy()
    const proceed = screen.getByRole('button', { name: '继续' })
    expect((proceed as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /小红书/ }))
    fireEvent.click(screen.getByRole('button', { name: /抖音/ }))
    expect(screen.getByRole('button', { name: /抖音/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(proceed)

    expect(await screen.findByRole('heading', { name: '现在最头疼的是哪件事？' })).toBeTruthy()
    expect(screen.getByText('第 3 题，共 3 题')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /不会写文案/ }))

    const done = await screen.findByText(/^记住了：/)
    expect(done.textContent).toContain('记住了：好物测评 · 抖音、小红书 · 不会写文案。')
    expect(done.textContent).toContain('「设置 › 个性化」')
    expect(done.closest('[role="status"]')).toBeTruthy()
    expect(patches).toEqual([
      { contentType: 'product_review' },
      { platforms: ['douyin', 'xiaohongshu'] },
      { painPoint: 'no_script' }
    ])

    fireEvent.click(screen.getByRole('button', { name: zh.dismiss }))
    expect(screen.queryByText(/^记住了：/)).toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('a typed answer goes out as "other" with the words', async () => {
    const { bridge, patches } = cloud()
    install(bridge)
    renderCards()

    const field = await screen.findByPlaceholderText('其他（自己写）')
    expect(field.getAttribute('maxlength')).toBe('40')
    fireEvent.change(field, { target: { value: '  宠物日常 ' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    await screen.findByRole('heading', { name: '主要发在哪个平台？' })
    expect(patches).toEqual([{ contentType: 'other', contentTypeOther: '宠物日常' }])
  })

  it('every card can be skipped, and three skips end it without asking again', async () => {
    const { bridge, patches } = cloud()
    install(bridge)
    renderCards()

    for (const title of ['你主要做什么内容？', '主要发在哪个平台？', '现在最头疼的是哪件事？']) {
      await screen.findByRole('heading', { name: title })
      fireEvent.click(screen.getByRole('button', { name: '先跳过' }))
    }

    expect(await screen.findByText(zh.doneNothing)).toBeTruthy()
    expect(patches).toEqual([{ skip: ['content_type'] }, { skip: ['platforms'] }, { skip: ['pain_point'] }])
  })

  // hc-965: the three cards ask about the user's own situation, where no option
  // is better than another. Their rows are the clarify card's, which label only a
  // choice the backend marked, so none of them may read 「推荐」.
  it('labels no option as recommended on any of the three cards', async () => {
    install(cloud().bridge)
    const { container } = renderCards()

    for (const title of ['你主要做什么内容？', '主要发在哪个平台？', '现在最头疼的是哪件事？']) {
      await screen.findByRole('heading', { name: title })
      expect(screen.getAllByRole('button', { name: /^[A-E]/ })).toHaveLength(5)
      expect(container.textContent).not.toMatch(/推荐|Recommended/)
      fireEvent.click(screen.getByRole('button', { name: '先跳过' }))
    }
  })

  it('a failed save keeps the card and says so', async () => {
    const fake = cloud()
    install(fake.bridge)
    renderCards()

    fake.failOnce()
    fireEvent.click(await screen.findByRole('button', { name: /探店/ }))

    expect((await screen.findByRole('alert')).textContent).toBe(zh.saveFailed)
    expect(screen.getByRole('heading', { name: '你主要做什么内容？' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /探店/ }))
    expect(await screen.findByRole('heading', { name: '主要发在哪个平台？' })).toBeTruthy()
  })

  it('resumes at the first card that was neither answered nor skipped', async () => {
    install(cloud({ contentType: 'drama' }).bridge)
    renderCards()

    expect(await screen.findByRole('heading', { name: '主要发在哪个平台？' })).toBeTruthy()
    expect(screen.getByText('第 2 题，共 3 题')).toBeTruthy()
  })

  it('shows nothing once the intake is done, signed out, or without the bridge', async () => {
    const done = cloud({ contentType: 'vlog', painPoint: 'no_topic', platforms: ['douyin'] })
    install(done.bridge)
    const first = renderCards()
    await waitFor(() => expect(done.bridge).toHaveBeenCalled())
    await act(async () => {})
    expect(first.container.innerHTML).toBe('')
    cleanup()

    const signedOut = cloud()
    install(signedOut.bridge)
    signIn(null, 'signed-out')
    expect(renderCards().container.innerHTML).toBe('')
    expect(signedOut.bridge).not.toHaveBeenCalled()
    cleanup()

    install(undefined)
    signIn()
    $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
    const noBridge = renderCards()
    await act(async () => {})
    expect(noBridge.container.innerHTML).toBe('')
  })
})

describe('creator intake copy', () => {
  it.each(['zh', 'zh-hant'] as const)('%s carries no English beyond the names creators use', locale => {
    const copy = CREATOR_INTAKE_COPY[locale]

    const strings = [
      copy.region,
      copy.progress(1, 3),
      ...Object.values(copy.questions).flatMap(q => [q.lead, q.title, q.hint]),
      ...Object.values(copy.contentTypes),
      ...Object.values(copy.platforms),
      ...Object.values(copy.painPoints),
      copy.otherPlaceholder,
      copy.skip,
      copy.continueLabel,
      copy.saving,
      copy.saveFailed,
      copy.done('好物测评'),
      copy.doneNothing,
      copy.dismiss,
      ...Object.values(copy.settings)
    ]

    expect(englishWords(strings.join('\n'))).toEqual([])
  })
})
