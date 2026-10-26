import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CREATOR_INTAKE_COPY } from '@/app/business-workspace/creator-intake-copy'
import type { DesktopCreatorProfile, DesktopCreatorProfileRequest, DesktopCreatorProfileResult } from '@/global'
import { I18nProvider, setRuntimeI18nLocale } from '@/i18n'
import { $authState } from '@/store/auth'
import { $creatorProfile } from '@/store/creator-profile'
import { englishWords, readableText } from '@/test/zh-copy'

import { CreatorProfileSettings } from './creator-profile-settings'

type Bridge = (request: DesktopCreatorProfileRequest) => Promise<DesktopCreatorProfileResult>

const DONE: DesktopCreatorProfile = {
  answers: { contentType: 'other', contentTypeOther: '宠物日常', painPoint: 'no_traffic', platforms: ['douyin'] },
  intake: { completed: true, nextStep: null, skipped: [] }
}

const s = CREATOR_INTAKE_COPY.zh.settings

function install(bridge: Bridge | undefined) {
  ;(window as unknown as { hermesDesktop?: unknown }).hermesDesktop = bridge
    ? { managed: { creatorProfile: bridge } }
    : undefined
}

function renderSettings() {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CreatorProfileSettings />
    </I18nProvider>
  )
}

describe('创作档案 settings (hc-991)', () => {
  beforeEach(() => {
    setRuntimeI18nLocale('zh')
    $creatorProfile.set({ accountId: null, profile: null, status: 'idle' })
    $authState.set({
      account: { email: 'a@example.test', name: '小林', plan: 'free' },
      accountId: 'acc-1',
      enabled: true,
      gateReason: null,
      loginTruth: true,
      status: 'signed-in'
    })
  })

  afterEach(() => {
    cleanup()
    install(undefined)
  })

  it('shows the three answers in Chinese and says where a change lands', async () => {
    install(async () => ({ ok: true, profile: DONE }))
    const { container } = renderSettings()

    expect(await screen.findByText(s.title)).toBeTruthy()
    expect(screen.getByText(s.intro)).toBeTruthy()
    expect(screen.getByText(s.contentType)).toBeTruthy()
    expect((screen.getByLabelText('其他（自己写）') as HTMLInputElement).value).toBe('宠物日常')
    expect(screen.getByRole('button', { name: '抖音' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '视频号' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('combobox', { name: s.painPoint }).textContent).toContain('拍了没人看')
    expect(englishWords(readableText(container))).toEqual([])
  })

  // hc-1063: the same wording as the first-open cards in the conversation (prototype v2).
  it.each([
    ['no_topic', '不知道拍什么'],
    ['no_traffic', '拍了没人看'],
    ['no_editing', '剪辑太费时间'],
    ['no_script', '不会写文案'],
    ['no_shooting', '不会拍']
  ] as const)('names the hardest part %s in the prototype’s words: %s', async (painPoint, label) => {
    install(async () => ({ ok: true, profile: { ...DONE, answers: { ...DONE.answers, painPoint } } }))
    renderSettings()

    expect((await screen.findByRole('combobox', { name: s.painPoint })).textContent).toBe(label)
  })

  it('a platform toggle saves the whole list in the cards’ order', async () => {
    const bridge = vi.fn<Bridge>(async request =>
      request.action === 'save'
        ? { ok: true, profile: { ...DONE, answers: { ...DONE.answers, platforms: ['douyin', 'bilibili'] } } }
        : { ok: true, profile: DONE }
    )

    install(bridge)
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'B 站' }))

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(s.saved))
    expect(bridge).toHaveBeenLastCalledWith({ action: 'save', patch: { platforms: ['douyin', 'bilibili'] } })
    expect(screen.getByRole('button', { name: 'B 站' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('the typed answer saves on Enter, and a refused save says so', async () => {
    const bridge = vi.fn<Bridge>(async request =>
      request.action === 'save' ? { message: 'INVALID', ok: false, profile: null } : { ok: true, profile: DONE }
    )

    install(bridge)
    renderSettings()

    const field = await screen.findByLabelText('其他（自己写）')
    fireEvent.change(field, { target: { value: '萌宠' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect((await screen.findByRole('alert')).textContent).toBe(s.saveFailed)
    expect(bridge).toHaveBeenLastCalledWith({
      action: 'save',
      patch: { contentType: 'other', contentTypeOther: '萌宠' }
    })
  })

  it('without an answer from the cloud it says how to get one', async () => {
    install(async () => ({ ok: true, profile: null }))
    renderSettings()

    expect(await screen.findByText(s.unavailable)).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
