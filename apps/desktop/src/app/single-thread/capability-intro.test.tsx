/**
 * hc-1108 首启能力介绍 (C2): who hears it, what each button does, and that
 * none of it sends a message or calls the network.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Focus from '@/app/chat/composer/focus'
import { onComposerFocusRequest, onComposerInsertRequest } from '@/app/chat/composer/focus'
import type { DesktopCreatorProfile, DesktopCreatorProfileRequest, DesktopCreatorProfileResult } from '@/global'
import { I18nProvider, type Locale, setRuntimeI18nLocale } from '@/i18n'
import { CAPABILITY_INTRO_COPY } from '@/i18n/single-thread-capability-intro'
import { SINGLE_THREAD_FIRST_OPEN_COPY } from '@/i18n/single-thread-first-open'
import { $authState } from '@/store/auth'
import { capabilityIntroSwitchFrom, resetCapabilityIntroForTest } from '@/store/capability-intro'
import { $creatorProfile } from '@/store/creator-profile'
import { resetDailyIdeasForTest } from '@/store/daily-ideas'
import { $gatewayState } from '@/store/session'
import { englishWords, readableText } from '@/test/zh-copy'

import { FirstOpen } from './first-open'

const submits = vi.hoisted(() => ({ texts: [] as string[] }))

vi.mock('@/app/chat/composer/focus', async importOriginal => ({
  ...(await importOriginal<typeof Focus>()),
  requestComposerSubmit: (text: string) => {
    submits.texts.push(text)

    return true
  }
}))

const LEAD = '我能帮你做的，先说三件：'
const PASTE = '看到火的视频，把链接贴给我。我能转成逐字稿、拆它为什么火，再仿写成你的脚本。'
const VIDEO = '说一句想拍什么，我先出 5 秒样片给你看，满意了再出 15 秒成片。'
const WECHAT = '这台电脑开着的时候，微信里也能找我，扫一下码就连上。'
const SHORT_TIP = '懒得打字的话，点右下角那个圆按钮跟我说。我们就在这一个对话里聊，不用开新的。'
const FULL_TIP = `以后直接贴链接就行。${SHORT_TIP}`

interface Setup {
  /** What the platform's client config says; `undefined` leaves the key out. */
  platform?: boolean
  /** This install's APEXNODES_CAPABILITY_INTRO, when set. */
  install?: boolean
  /** The intake was finished before this window opened. */
  answeredBefore?: boolean
  wechatBound?: boolean
  clipboard?: () => Promise<string>
}

/** The bridge, recording every call by its path so a test can say exactly which ones happened. */
function installBridge(setup: Setup) {
  const { answeredBefore = false, clipboard, install, wechatBound = false } = setup
  // An explicit `platform: undefined` leaves the key out; no `platform` at all means on.
  const platform = Object.hasOwn(setup, 'platform') ? setup.platform : true
  const calls: string[] = []
  // The cloud keeps the intake finished once it was (its completed_at is never cleared).
  let completed = answeredBefore

  const answers: DesktopCreatorProfile['answers'] = answeredBefore
    ? { contentType: 'store_visit', contentTypeOther: null, painPoint: 'no_traffic', platforms: ['douyin'] }
    : { contentType: null, contentTypeOther: null, painPoint: null, platforms: [] }

  const profile = (): DesktopCreatorProfile => {
    const pending = (['content_type', 'platforms', 'pain_point'] as const).filter(step =>
      step === 'content_type'
        ? !answers.contentType
        : step === 'platforms'
          ? !answers.platforms.length
          : !answers.painPoint
    )

    completed ||= pending.length === 0

    return {
      answers: { ...answers, platforms: [...answers.platforms] },
      intake: { completed, nextStep: completed ? null : (pending[0] ?? null), skipped: [] }
    }
  }

  const features: Record<string, boolean> = { single_thread: true }

  if (platform !== undefined) {
    features.capability_intro = platform
  }

  const state = {
    config: {
      appliedVersion: 7,
      installSwitches: install === undefined ? {} : { capability_intro: install },
      payload: { desktop_features: features },
      version: 7
    }
  }

  const bridge = {
    clientConfig: { get: async () => state.config },
    imEntry: {
      list: async () => ({ channels: wechatBound ? [{ channelId: 'weixin' }] : [{ channelId: 'feishu' }] })
    },
    managed: {
      creatorProfile: async (request: DesktopCreatorProfileRequest): Promise<DesktopCreatorProfileResult> => {
        if (request.action === 'save') {
          const { patch } = request

          answers.contentType = 'contentType' in patch ? (patch.contentType ?? null) : answers.contentType
          answers.platforms = 'platforms' in patch ? (patch.platforms ?? []) : answers.platforms
          answers.painPoint = 'painPoint' in patch ? (patch.painPoint ?? null) : answers.painPoint
        }

        return { ok: true, profile: profile() }
      }
    },
    readClipboard: clipboard ?? (async () => '')
  }

  const record = (target: Record<string, unknown>, path: string): unknown =>
    new Proxy(target, {
      get(object, key) {
        const value = object[key as string]

        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            calls.push(`${path}${String(key)}`)

            return (value as (...a: unknown[]) => unknown)(...args)
          }
        }

        return value && typeof value === 'object'
          ? record(value as Record<string, unknown>, `${path}${String(key)}.`)
          : value
      }
    })

  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = record(bridge, '')

  return { calls, state }
}

function renderFirstOpen(locale: Locale = 'zh') {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <I18nProvider configClient={null} initialLocale={locale}>
        <Routes>
          <Route
            element={
              <div data-testid="thread">
                <FirstOpen />
              </div>
            }
            path="/"
          />
          <Route element={<p data-testid="im-entry">消息渠道</p>} path="/im-entry" />
        </Routes>
      </I18nProvider>
    </MemoryRouter>
  )
}

const thread = () => screen.getByTestId('thread')
const intro = () => thread().querySelector('[data-capability-intro]')
const turn = (id: string) => thread().querySelector<HTMLElement>(`[data-capability="${id}"]`)
const tip = () => thread().querySelector('[data-first-open-tip]')?.textContent

const openCard = () =>
  thread().querySelector<HTMLElement>('[data-first-open-card]:not([data-first-open-card="answered"])')

async function pick(label: string) {
  const card = await waitFor(() => {
    const open = openCard()
    expect(open).not.toBeNull()

    return open!
  })

  fireEvent.click(within(card).getByRole('button', { name: new RegExp(label) }))
}

async function answerAllThree() {
  await pick('探店')
  await pick('^.抖音$')
  await pick('拍了没人看')
  await waitFor(() => expect(thread().querySelector('[data-first-open-noted]')).not.toBeNull())
}

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
  })

let inserts: string[] = []
let focuses: string[] = []
let offBus: Array<() => void> = []

beforeEach(() => {
  setRuntimeI18nLocale('zh')
  resetCapabilityIntroForTest()
  resetDailyIdeasForTest()
  $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
  $gatewayState.set('open')
  $authState.set({
    account: { email: 'a@example.test', name: '小满', plan: 'free' },
    accountId: 'acc-1',
    enabled: true,
    gateReason: null,
    loginTruth: true,
    status: 'signed-in'
  })
  submits.texts.length = 0
  inserts = []
  focuses = []
  offBus = [
    onComposerInsertRequest(({ mode, target, text }) => inserts.push(`${target}:${mode}:${text}`)),
    onComposerFocusRequest(({ target }) => focuses.push(target))
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no network in the first open')
    })
  )
})

afterEach(() => {
  cleanup()
  offBus.forEach(off => off())
  vi.unstubAllGlobals()
  resetCapabilityIntroForTest()
  setRuntimeI18nLocale('en')
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = undefined
})

describe('hc-1108: who hears what APEX can do', () => {
  it('right after the third card: the lead, three messages with a button each, then the tip without its first sentence', async () => {
    installBridge({})
    renderFirstOpen()

    await answerAllThree()
    await waitFor(() => expect(intro()).not.toBeNull())

    expect(intro()!.textContent).toBe(LEAD)
    expect(turn('paste')!.querySelector('p')!.textContent).toBe(PASTE)
    expect(turn('video')!.querySelector('p')!.textContent).toBe(VIDEO)
    expect(turn('wechat')!.querySelector('p')!.textContent).toBe(WECHAT)
    expect(
      within(turn('paste')!)
        .getAllByRole('button')
        .map(b => b.textContent)
    ).toEqual(['粘一条试试'])
    expect(
      within(turn('video')!)
        .getAllByRole('button')
        .map(b => b.textContent)
    ).toEqual(['出一条'])
    expect(
      within(turn('wechat')!)
        .getAllByRole('button')
        .map(b => b.textContent)
    ).toEqual(['扫码连上', '稍后再说'])
    expect(tip()).toBe(SHORT_TIP)
    expect(thread().textContent).not.toContain('以后直接贴链接就行')

    // In order: the noted line, the lead, the three messages, the tip.
    const order = [
      ...thread().querySelectorAll(
        '[data-first-open-noted], [data-capability-intro], [data-capability], [data-first-open-tip]'
      )
    ]

    expect(
      order.map(
        node => node.getAttribute('data-capability') ?? node.getAttributeNames().find(n => n.startsWith('data-'))
      )
    ).toEqual(['data-first-open-noted', 'data-capability-intro', 'paste', 'video', 'wechat', 'data-first-open-tip'])
    expect(englishWords(readableText(thread()))).toEqual([])
  })

  it('switch off: the same three cards end with the tip as before and nothing else', async () => {
    installBridge({ platform: false })
    renderFirstOpen()

    await answerAllThree()
    await settle()

    expect(intro()).toBeNull()
    expect(thread().querySelector('[data-capability]')).toBeNull()
    expect(tip()).toBe(FULL_TIP)
  })

  it.each([
    ['the platform says nothing', undefined, undefined, false],
    ['the platform turns it on', true, undefined, true],
    ['APEXNODES_CAPABILITY_INTRO=0 keeps it off over the platform', true, false, false],
    ['APEXNODES_CAPABILITY_INTRO=1 turns it on without the platform', undefined, true, true]
  ] as const)('%s', async (_label, platform, install, shown) => {
    installBridge({ install, platform })
    renderFirstOpen()

    await answerAllThree()
    await settle()

    expect(Boolean(intro())).toBe(shown)
    expect(tip()).toBe(shown ? SHORT_TIP : FULL_TIP)
  })

  it('only a literal true counts, as for every desktop_features switch', () => {
    expect(capabilityIntroSwitchFrom({ payload: { desktop_features: { capability_intro: 'true' } } })).toBe(false)
    expect(capabilityIntroSwitchFrom({ payload: { desktop_features: { capability_intro: true } } })).toBe(true)
    expect(capabilityIntroSwitchFrom(null)).toBe(false)
  })

  it('someone who answered the cards before never hears it, and nothing asks about WeChat', async () => {
    const { calls } = installBridge({ answeredBefore: true })
    renderFirstOpen()

    await waitFor(() => expect(tip()).toBe(FULL_TIP))
    await settle()

    expect(intro()).toBeNull()
    expect(calls).not.toContain('imEntry.list')
  })

  it('the switch is read when the third card is answered: on by then is enough', async () => {
    const { state } = installBridge({ platform: false })
    renderFirstOpen()

    await pick('探店')
    await pick('^.抖音$')
    // A new install's first launch: the platform config lands while the cards are being answered.
    state.config = { ...state.config, payload: { desktop_features: { capability_intro: true, single_thread: true } } }
    await pick('拍了没人看')

    await waitFor(() => expect(intro()).not.toBeNull())
    expect(tip()).toBe(SHORT_TIP)
  })

  it('WeChat already connected: two things, no WeChat message', async () => {
    installBridge({ wechatBound: true })
    renderFirstOpen()

    await answerAllThree()
    await waitFor(() => expect(intro()).not.toBeNull())

    expect(intro()!.textContent).toBe('我能帮你做的，先说两件：')
    expect(turn('paste')).not.toBeNull()
    expect(turn('video')).not.toBeNull()
    expect(turn('wechat')).toBeNull()
    expect(tip()).toBe(SHORT_TIP)
  })

  it('撤销 takes the answers back, not what APEX said it can do', async () => {
    installBridge({})
    renderFirstOpen()

    await answerAllThree()
    await waitFor(() => expect(intro()).not.toBeNull())
    fireEvent.click(
      within(thread().querySelector<HTMLElement>('[data-first-open-noted]')!).getByRole('button', { name: '撤销' })
    )
    await waitFor(() => expect(thread().querySelector('[data-first-open-noted="undone"]')).not.toBeNull())

    expect(intro()).not.toBeNull()
    expect(turn('wechat')).not.toBeNull()
  })
})

describe('hc-1108: what each button does', () => {
  async function shown(setup: Setup = {}) {
    const bridge = installBridge(setup)
    renderFirstOpen()
    await answerAllThree()
    await waitFor(() => expect(intro()).not.toBeNull())

    return bridge
  }

  it('粘一条试试 with a Douyin share in the clipboard: only the link goes into the composer, nothing is sent', async () => {
    await shown({
      clipboard: async () => '7.99 复制打开抖音，看看【小满的作品】三招收纳 https://v.douyin.com/AbCd12/ 08/11 a@B.ok'
    })

    fireEvent.click(screen.getByRole('button', { name: '粘一条试试' }))

    await waitFor(() => expect(inserts).toEqual(['main:block:https://v.douyin.com/AbCd12/']))
    expect(within(turn('paste')!).queryByRole('status')).toBeNull()
    expect(submits.texts).toEqual([])
  })

  it.each([
    ['an empty clipboard', async () => ''],
    ['plain text', async () => '明天拍什么好'],
    ['a 视频号 link (no stream to download)', async () => 'https://weixin.qq.com/sph/AbCdEf'],
    ['a clipboard that cannot be read', async () => Promise.reject(new Error('denied'))]
  ])(
    '粘一条试试 with %s: the cursor goes to the composer and APEX says how to copy a link',
    async (_label, clipboard) => {
      await shown({ clipboard })

      fireEvent.click(screen.getByRole('button', { name: '粘一条试试' }))

      await waitFor(() =>
        expect(within(turn('paste')!).getByRole('status').textContent).toBe(
          '在抖音点「分享 › 复制链接」，回来再点一次就行。'
        )
      )
      await waitFor(() => expect(focuses).toEqual(['main']))
      expect(inserts).toEqual([])
      expect(submits.texts).toEqual([])
    }
  )

  it('a link copied after the hint: the second tap pastes it and the hint goes', async () => {
    let clip = ''
    await shown({ clipboard: async () => clip })

    fireEvent.click(screen.getByRole('button', { name: '粘一条试试' }))
    await waitFor(() => expect(within(turn('paste')!).queryByRole('status')).not.toBeNull())

    clip = 'https://www.xiaohongshu.com/explore/66aa11'
    fireEvent.click(screen.getByRole('button', { name: '粘一条试试' }))

    await waitFor(() => expect(inserts).toEqual(['main:block:https://www.xiaohongshu.com/explore/66aa11']))
    expect(within(turn('paste')!).queryByRole('status')).toBeNull()
  })

  it('出一条 puts half a sentence in the composer and sends nothing', async () => {
    await shown()

    fireEvent.click(screen.getByRole('button', { name: '出一条' }))

    await waitFor(() => expect(inserts).toEqual(['main:block:帮我做一条 15 秒的短视频，拍：']))
    expect(submits.texts).toEqual([])
  })

  it('扫码连上 opens the WeChat page the sidebar row opens', async () => {
    await shown()

    fireEvent.click(screen.getByRole('button', { name: '扫码连上' }))

    expect(await screen.findByTestId('im-entry')).toBeTruthy()
  })

  it('稍后再说 folds the buttons and says where the sidebar row is', async () => {
    await shown()

    fireEvent.click(screen.getByRole('button', { name: '稍后再说' }))

    expect(within(turn('wechat')!).queryAllByRole('button')).toEqual([])
    expect(within(turn('wechat')!).getByRole('status').textContent).toBe(
      '好，想连的时候点侧栏最下面的「在微信里找 APEX」。'
    )
  })

  it('no button sends a message or calls the network: the bridge sees only the clipboard read', async () => {
    const { calls } = await shown({ clipboard: async () => '' })
    await settle()
    const before = [...calls]

    fireEvent.click(screen.getByRole('button', { name: '粘一条试试' }))
    await waitFor(() => expect(within(turn('paste')!).queryByRole('status')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '出一条' }))
    fireEvent.click(screen.getByRole('button', { name: '稍后再说' }))
    await settle()

    expect(calls.slice(before.length)).toEqual(['readClipboard'])
    expect(new Set(before)).toEqual(new Set(['clientConfig.get', 'imEntry.list', 'managed.creatorProfile']))
    expect(fetch).not.toHaveBeenCalled()
    expect(submits.texts).toEqual([])
  })
})

describe('hc-1108: the words', () => {
  it.each(['zh', 'zh-hant', 'en'] as const)('%s: the tip is the first-open tip minus its first sentence', locale => {
    const full = SINGLE_THREAD_FIRST_OPEN_COPY[locale].tip
    const short = CAPABILITY_INTRO_COPY[locale].tip

    expect(full.endsWith(short)).toBe(true)
    expect(full.slice(0, -short.length).trim()).toMatch(/^[^。.]+[。.]$/)
  })

  it.each(['zh-hant', 'en'] as const)('%s: the whole intro is in that language', async locale => {
    setRuntimeI18nLocale(locale)
    installBridge({})
    renderFirstOpen(locale)

    const labels =
      locale === 'en' ? ['Shop and venue visits', 'Douyin', 'Nobody watches'] : ['探店', '抖音', '拍了沒人看']

    await pick(labels[0])
    await pick(`^.${labels[1]}$`)
    await pick(labels[2])
    await waitFor(() => expect(intro()).not.toBeNull())

    const copy = CAPABILITY_INTRO_COPY[locale]
    expect(intro()!.textContent).toBe(copy.lead(3))
    expect(turn('video')!.querySelector('p')!.textContent).toBe(copy.video.text)
    expect(tip()).toBe(copy.tip)

    if (locale === 'zh-hant') {
      expect(englishWords(readableText(thread()))).toEqual([])
    }
  })
})
