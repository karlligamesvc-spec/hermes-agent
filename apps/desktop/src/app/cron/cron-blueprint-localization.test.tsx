import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAutomationBlueprints, getCronDeliveryTargets, getCronJobs, instantiateAutomationBlueprint } from '@/hermes'
import { I18nProvider, useI18n } from '@/i18n'
import { en } from '@/i18n/en'
import { zh } from '@/i18n/zh'
import { setCronJobs } from '@/store/cron'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { CronView } from '.'

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAutomationBlueprints: vi.fn(),
  getCronDeliveryTargets: vi.fn(),
  getCronJobs: vi.fn(),
  instantiateAutomationBlueprint: vi.fn()
}))
vi.mock('@/lib/model-options', () => ({ requestModelOptions: vi.fn().mockResolvedValue({ providers: [] }) }))

function LanguageSwitch() {
  const { setLocale } = useI18n()
  return (
    <button onClick={() => void setLocale('en')} type="button">
      test-language-switch
    </button>
  )
}

function selectOption(label: string, option: string) {
  fireEvent.pointerDown(screen.getByRole('combobox', { name: label }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: option }))
}

beforeEach(() => {
  stubResizeObserver()
  stubMenuDomApis()
  vi.clearAllMocks()
  setCronJobs([])
  vi.mocked(getCronJobs).mockResolvedValue([])
  vi.mocked(getCronDeliveryTargets).mockResolvedValue([
    { id: 'local', name: 'Local (save only)', home_target_set: true, home_env_var: null },
    { id: 'bot-chat:default', name: 'Bot Chat (default)', home_target_set: true, home_env_var: null }
  ])
  vi.mocked(getAutomationBlueprints).mockResolvedValue({
    blueprints: [
      {
        key: 'weekly-review',
        title: 'Weekly review',
        description: "A weekly recap: what got done, what's still open, and what's coming up.",
        category: 'weekly',
        tags: [],
        command: '',
        appUrl: '',
        fields: [
          {
            name: 'time',
            type: 'time',
            label: 'What time?',
            default: '18:00',
            options: [],
            optional: false,
            help: '24h local time, e.g. 08:00'
          },
          {
            name: 'day',
            type: 'enum',
            label: 'Which day?',
            default: 'sunday',
            options: ['sunday', 'monday', 'friday', 'saturday'],
            optional: false,
            help: ''
          },
          {
            name: 'deliver',
            type: 'enum',
            label: 'Where to deliver?',
            default: 'origin',
            options: ['origin', 'local'],
            optional: false,
            help: ''
          }
        ]
      }
    ]
  })
  vi.mocked(instantiateAutomationBlueprint).mockResolvedValue({
    id: 'new-review',
    name: 'Weekly review',
    enabled: true
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('cron template dialog locale', () => {
  it('renders Chinese copy and keeps edited draft and canonical submission when the display language changes', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <I18nProvider configClient={null} initialLocale="zh">
          <LanguageSwitch />
          <CronView />
        </I18nProvider>
      </QueryClientProvider>
    )
    await screen.findByText(zh.cron.emptyTitleNew)
    fireEvent.click(screen.getAllByRole('button', { name: zh.cron.newCron })[0])
    const dialog = await screen.findByRole('dialog')
    const template = await within(dialog).findByRole('combobox', { name: '选择模板' })
    expect(template.textContent).toBe('自定义')
    expect(within(dialog).getByText(/^每天\s+9:00$/)).toBeTruthy()
    expect(within(dialog).queryByText(/AM|Start from|Bot Chat/)).toBeNull()
    expect(within(dialog).getByRole('checkbox', { name: '助理对话 (默认)' })).toBeTruthy()

    selectOption('选择模板', '每周回顾')
    await within(dialog).findByLabelText('执行时间')
    expect(within(dialog).getByText('回顾本周完成的事项、待办任务和接下来的安排。')).toBeTruthy()
    expect(within(dialog).getByText('当地时间，24 小时制，例如 08:00')).toBeTruthy()
    selectOption('星期几', '周一')
    fireEvent.change(within(dialog).getByLabelText('执行时间'), { target: { value: '13:15' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '助理对话 (默认)' }))

    await act(async () => {
      fireEvent.click(screen.getByText('test-language-switch'))
    })
    await within(dialog).findByRole('combobox', { name: en.cron.blueprints.startFrom })
    expect((within(dialog).getByLabelText('What time?') as HTMLInputElement).value).toBe('13:15')
    expect(within(dialog).getByRole('combobox', { name: 'Which day?' }).textContent).toBe('monday')
    expect(
      (within(dialog).getByRole('checkbox', { name: 'Bot Chat (default)' }) as HTMLButtonElement).getAttribute(
        'data-state'
      )
    ).toBe('checked')
    fireEvent.click(within(dialog).getByRole('button', { name: en.cron.blueprints.scheduleIt }))
    await waitFor(() =>
      expect(instantiateAutomationBlueprint).toHaveBeenCalledWith(
        {
          blueprint: 'weekly-review',
          values: { time: '13:15', day: 'monday', deliver: 'local,bot-chat:default' }
        },
        'default'
      )
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
