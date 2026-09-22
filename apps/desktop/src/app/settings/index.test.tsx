// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

vi.mock('./about-settings', () => ({ AboutSettings: () => <div>about-view</div> }))
vi.mock('./appearance-settings', () => ({ AppearanceSettings: () => <div>appearance-view</div> }))
vi.mock('./config-settings', () => ({
  ConfigSettings: ({ activeSectionId }: { activeSectionId: string }) => <div>config-{activeSectionId}</div>
}))
vi.mock('./gateway-settings', () => ({ GatewaySettings: () => <div>gateway-view</div> }))
vi.mock('./keybind-settings', () => ({ KeybindSettings: () => <div>keybind-view</div> }))
vi.mock('./keys-settings', () => ({
  KEYS_VIEWS: ['tools', 'settings'],
  KeysSettings: () => <div>keys-view</div>
}))
vi.mock('./notifications-settings', () => ({ NotificationsSettings: () => <div>notifications-view</div> }))
vi.mock('./personalization-settings', () => ({
  PersonalizationSettings: () => <div>personalization-view</div>
}))
vi.mock('./plugins-settings', () => ({ PluginsSettings: () => <div>plugins-view</div> }))
vi.mock('./providers-settings', () => ({
  PROVIDER_VIEWS: ['accounts', 'keys', 'custom-endpoints'],
  ProvidersSettings: () => <div>providers-view</div>
}))
vi.mock('./sessions-settings', () => ({ SessionsSettings: () => <div>sessions-view</div> }))

import { SettingsView } from './index'

function renderSettings(route = '/settings') {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter initialEntries={[route]}>
        <SettingsView onClose={vi.fn()} />
      </MemoryRouter>
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  globalThis.document.body.style.overflow = ''
})

describe('SettingsView account surface', () => {
  it('shows the current settings surface while keeping APEX-only exclusions out', () => {
    renderSettings()

    const dialog = screen.getByRole('dialog', { name: '设置' })
    expect(dialog.querySelector('.p5-settings')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '个性化' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '模型' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '对话' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '外观' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '工作区' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '安全' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '浏览器' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '记忆与上下文' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '语音' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '高级' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '提供方' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '网关' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '已归档对话' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: '关于' }).length).toBeGreaterThan(0)
    expect(screen.getByText('personalization-view')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '账单' })).toBeNull()
    expect(screen.queryByRole('button', { name: '搜索' })).toBeNull()

    const visibleText = dialog.textContent ?? ''
    expect(visibleText).not.toContain('Hermes')
    expect(visibleText).not.toContain('Nous')
    expect(visibleText).not.toContain('Browser')
  })

  it('keeps the legacy connections deep link on the real Gateway page', () => {
    renderSettings('/settings?tab=connections')

    expect(screen.getByText('gateway-view')).toBeTruthy()
    expect(screen.queryByText('sessions-view')).toBeNull()
  })

  it('does not render the upstream billing surface from a direct link', () => {
    renderSettings('/settings?tab=billing')

    expect(screen.getByText('personalization-view')).toBeTruthy()
    expect(screen.queryByText('billing-view')).toBeNull()
  })
})
