/**
 * hc-1078 (multi-bot M2): the new / edit sheet, the 「+」, the selected row's 「···」 menu and the
 * delete confirmation, as prototype v2 artboard ⑦ draws them, on the real components in zh.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { BotOpError, createBot, deleteBot, readBotLook, saveBotLook } from '@/store/single-thread-bot-ops'

import { BotDeleteConfirm } from './bot-delete-confirm'
import { BOT_COLORS } from './bot-face'
import { BotRowMenu } from './bot-row-menu'
import { BotNewButton, BotSheet, type BotSheetTarget } from './bot-sheet'

vi.mock('@/store/single-thread-bot-ops', async importActual => ({
  ...(await importActual<Record<string, unknown>>()),
  createBot: vi.fn(),
  deleteBot: vi.fn(),
  readBotLook: vi.fn(),
  saveBotLook: vi.fn()
}))

const zh = (node: ReactNode) =>
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      {node}
    </I18nProvider>
  )

const handlers = () => ({ onClose: vi.fn(), onCreated: vi.fn(), onSaved: vi.fn() })

function sheet(target: BotSheetTarget, { count = 3, max = 5, taken = ['APEX', '小红书文案'] } = {}) {
  const props = handlers()
  zh(<BotSheet count={count} max={max} takenNames={taken} target={target} {...props} />)

  return props
}

const dialog = () => screen.getByRole('dialog')
const nameField = () => screen.getByLabelText('叫它什么')
const saveButton = (label: string) => within(dialog()).getByRole('button', { name: label })
const previewName = () => dialog().querySelector('[data-bot-sheet-preview-name]')?.textContent

const BOT_EDIT: BotSheetTarget = {
  kind: 'edit',
  profile: 'apex-bot-2',
  isApex: false,
  name: '小红书文案',
  shape: 'hexagon',
  color: 'rose'
}

beforeEach(() => {
  vi.mocked(readBotLook).mockResolvedValue({
    look: { name: '小红书文案', shape: 'hexagon', color: 'rose' },
    revision: 2
  })
})

afterEach(() => {
  cleanup()
  vi.mocked(createBot).mockReset()
  vi.mocked(deleteBot).mockReset()
  vi.mocked(readBotLook).mockReset()
  vi.mocked(saveBotLook).mockReset()
})

describe('the new-assistant sheet', () => {
  it('previews the row live and counts what is left, leaving APEX out', () => {
    sheet({ kind: 'new' })

    expect(within(dialog()).getByRole('heading', { name: '新建一个助手' })).toBeTruthy()
    expect(previewName()).toBe('还没起名')
    expect(saveButton('建好了').hasAttribute('disabled')).toBe(true)
    expect(dialog().querySelector('[data-bot-sheet-left]')?.textContent).toBe('你已经建了 2 个，还能再建 2 个')
    expect(screen.getByText('它和 APEX 用同一个账号和额度，记得的「关于你」也是同一份。')).toBeTruthy()

    fireEvent.change(nameField(), { target: { value: ' 剪辑助手 ' } })
    expect(previewName()).toBe('剪辑助手')
    expect(saveButton('建好了').hasAttribute('disabled')).toBe(false)
  })

  it('offers six shapes and six colors, none of them APEX purple, starting at a blue rounded square', () => {
    sheet({ kind: 'new' })

    const shapes = within(screen.getByRole('group', { name: '样子' })).getAllByRole('button')
    const colors = within(screen.getByRole('group', { name: '颜色' })).getAllByRole('button')

    expect(shapes.map(button => button.textContent)).toEqual(['圆', '圆角方', '胶囊', '六边形', '云朵', '水滴'])
    expect(colors.map(button => button.getAttribute('aria-label'))).toEqual(['蓝', '青', '绿', '橙', '玫红', '金'])
    expect(Object.values(BOT_COLORS).map(hex => hex.toUpperCase())).not.toContain('#6A4CEB')
    expect(shapes.filter(button => button.getAttribute('aria-pressed') === 'true').map(b => b.textContent)).toEqual([
      '圆角方'
    ])
    expect(
      colors.filter(button => button.getAttribute('aria-pressed') === 'true').map(b => b.getAttribute('aria-label'))
    ).toEqual(['蓝'])

    fireEvent.click(screen.getByRole('button', { name: '云朵' }))
    fireEvent.click(screen.getByRole('button', { name: '青' }))

    const face = dialog().querySelector('.size-16')
    expect(face?.getAttribute('data-bot-face')).toBe('cloud')
    expect(face?.querySelector('path')?.getAttribute('fill')).toBe(BOT_COLORS.teal)
  })

  it('creates with the chosen look and opens the new assistant', async () => {
    vi.mocked(createBot).mockResolvedValue('apex-bot-3')
    const props = sheet({ kind: 'new' })

    fireEvent.change(nameField(), { target: { value: '剪辑助手' } })
    fireEvent.click(screen.getByRole('button', { name: '云朵' }))
    fireEvent.click(screen.getByRole('button', { name: '青' }))
    fireEvent.click(saveButton('建好了'))

    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith('apex-bot-3'))
    expect(createBot).toHaveBeenCalledWith({ name: '剪辑助手', shape: 'cloud', color: 'teal' }, { count: 3, max: 5 })
    expect(props.onClose).toHaveBeenCalled()
  })

  it.each([
    ['十三个字的名字比上限多一个', '最多 12 个字'],
    ['小红书文案', '已经有助手叫这个名字了']
  ])('refuses %j with %j', (value, message) => {
    sheet({ kind: 'new' })

    fireEvent.change(nameField(), { target: { value } })

    expect(screen.getByText(message)).toBeTruthy()
    expect(nameField().getAttribute('aria-invalid')).toBe('true')
    expect(saveButton('建好了').hasAttribute('disabled')).toBe(true)
  })

  it('says to delete one first at the limit, and cannot create', () => {
    sheet({ kind: 'new' }, { count: 5 })

    fireEvent.change(nameField(), { target: { value: '剪辑助手' } })

    expect(dialog().querySelector('[data-bot-sheet-left]')?.textContent).toBe('已经有 4 个了，先删掉一个再建')
    expect(saveButton('建好了').hasAttribute('disabled')).toBe(true)
  })

  it('keeps the sheet open with a plain message when creating fails', async () => {
    vi.mocked(createBot).mockRejectedValue(new Error('disk full'))
    const props = sheet({ kind: 'new' })

    fireEvent.change(nameField(), { target: { value: '剪辑助手' } })
    fireEvent.click(saveButton('建好了'))

    expect((await screen.findByRole('alert')).textContent).toBe('没建成，再试一次。')
    expect(props.onCreated).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
  })
})

describe('the edit sheet', () => {
  it('reads the stored look, then saves against that revision', async () => {
    vi.mocked(readBotLook).mockResolvedValue({
      look: { name: '小红书', shape: 'drop', color: 'gold' },
      revision: 7
    })
    vi.mocked(saveBotLook).mockResolvedValue(undefined)
    const props = sheet(BOT_EDIT, { taken: ['APEX'] })

    await waitFor(() => expect((nameField() as HTMLInputElement).value).toBe('小红书'))
    expect(screen.getByRole('button', { name: '水滴' }).getAttribute('aria-pressed')).toBe('true')
    expect(dialog().querySelector('[data-bot-sheet-left]')).toBeNull()

    fireEvent.change(nameField(), { target: { value: '小红书标题' } })
    fireEvent.click(saveButton('改好了'))

    await waitFor(() => expect(props.onSaved).toHaveBeenCalledWith('apex-bot-2'))
    expect(readBotLook).toHaveBeenCalledWith('apex-bot-2')
    expect(saveBotLook).toHaveBeenCalledWith('apex-bot-2', { name: '小红书标题', shape: 'drop', color: 'gold' }, 7)
  })

  it('cannot save before the stored revision is known', () => {
    vi.mocked(readBotLook).mockReturnValue(new Promise(() => undefined))
    sheet(BOT_EDIT, { taken: ['APEX'] })

    // Nothing else holds the button back: a name that is fine, under the limit.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(nameField().getAttribute('aria-invalid')).toBe('false')
    expect(saveButton('改好了').hasAttribute('disabled')).toBe(true)
  })

  it('reloads the latest look on a conflict instead of overwriting it', async () => {
    vi.mocked(saveBotLook).mockRejectedValue(new BotOpError('conflict', 'stale'))
    const props = sheet(BOT_EDIT, { taken: ['APEX'] })

    await waitFor(() => expect(saveButton('改好了').hasAttribute('disabled')).toBe(false))
    vi.mocked(readBotLook).mockResolvedValue({
      look: { name: '标题助手', shape: 'pill', color: 'green' },
      revision: 3
    })
    fireEvent.change(nameField(), { target: { value: '我的新名字' } })
    fireEvent.click(saveButton('改好了'))

    expect((await screen.findByRole('alert')).textContent).toBe('它刚在别处改过，这里已经换成最新的，再改一次。')
    await waitFor(() => expect((nameField() as HTMLInputElement).value).toBe('标题助手'))
    expect(screen.getByRole('button', { name: '胶囊' }).getAttribute('aria-pressed')).toBe('true')
    expect(props.onSaved).not.toHaveBeenCalled()
  })

  it('gives APEX the name field only: its look stays a purple circle', async () => {
    vi.mocked(readBotLook).mockResolvedValue({ look: {}, revision: 0 })
    vi.mocked(saveBotLook).mockResolvedValue(undefined)
    sheet({ kind: 'edit', profile: 'default', isApex: true, name: 'APEX' }, { taken: ['小红书文案'] })

    expect(screen.queryByRole('group', { name: '样子' })).toBeNull()
    expect(screen.queryByRole('group', { name: '颜色' })).toBeNull()
    const face = dialog().querySelector('.size-16')
    expect(face?.getAttribute('data-bot-face')).toBe('circle')
    expect(face?.querySelector('path')?.getAttribute('fill')).toBe('#6A4CEB')

    await waitFor(() => expect(saveButton('改好了').hasAttribute('disabled')).toBe(false))
    fireEvent.change(nameField(), { target: { value: '小满' } })
    fireEvent.click(saveButton('改好了'))

    await waitFor(() => expect(saveBotLook).toHaveBeenCalled())
    expect(vi.mocked(saveBotLook).mock.calls[0][0]).toBe('default')
    expect(vi.mocked(saveBotLook).mock.calls[0][2]).toBe(0)
  })
})

describe('the 「+」 button', () => {
  it.each([
    [4, '新建一个助手', ''],
    [5, '已经有 5 个助手了，先删掉一个再建', 'full']
  ])('with %i assistants says %j', (count, label, state) => {
    const open = vi.fn()
    zh(<BotNewButton count={count} max={5} onOpen={open} />)

    const button = screen.getByRole('button', { name: label })
    expect(button.getAttribute('data-single-thread-new-bot')).toBe(state)
    fireEvent.click(button)
    expect(open).toHaveBeenCalled()
  })
})

describe('the 「···」 menu', () => {
  async function openMenu(isApex: boolean, name: string) {
    const actions = { onDelete: vi.fn(), onEdit: vi.fn() }
    zh(<BotRowMenu isApex={isApex} name={name} {...actions} />)
    const trigger = screen.getByRole('button', { name: `管理${name}` })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })

    return { actions, menu: await screen.findByRole('menu') }
  }

  it('offers rename-or-restyle and delete for an assistant', async () => {
    const { actions, menu } = await openMenu(false, '小红书文案')

    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map(item => item.textContent)
    ).toEqual(['改名或换样子', '删除这个助手'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: '删除这个助手' }))
    expect(actions.onDelete).toHaveBeenCalled()
  })

  it('offers APEX a rename only', async () => {
    const { actions, menu } = await openMenu(true, 'APEX')

    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map(item => item.textContent)
    ).toEqual(['改名'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: '改名' }))
    expect(actions.onEdit).toHaveBeenCalled()
  })
})

describe('the delete confirmation', () => {
  function confirmDialog(onDeleted = vi.fn()) {
    const onClose = vi.fn()
    zh(
      <BotDeleteConfirm onClose={onClose} onDeleted={onDeleted} target={{ name: '带货脚本', profile: 'apex-bot-3' }} />
    )

    return { onClose, onDeleted }
  }

  it('says what goes and what stays', () => {
    confirmDialog()

    expect(screen.getByRole('heading', { name: '删掉「带货脚本」？' })).toBeTruthy()
    expect(
      screen.getByText(
        '它的对话、它在这台电脑上存的图片和视频、它那份技能会一起删掉，删了找不回来。你的「关于你」、交付物和用量都不受影响。'
      )
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: '先不删' })).toBeTruthy()
  })

  it('deletes that profile, then hands it back', async () => {
    vi.mocked(deleteBot).mockResolvedValue(undefined)
    const { onDeleted } = confirmDialog()

    fireEvent.click(screen.getByRole('button', { name: '删掉' }))

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('apex-bot-3'))
    expect(deleteBot).toHaveBeenCalledWith('apex-bot-3')
  })

  it('stays open with a plain message when the delete fails', async () => {
    vi.mocked(deleteBot).mockRejectedValue(new Error('EBUSY'))
    const { onDeleted } = confirmDialog()

    fireEvent.click(screen.getByRole('button', { name: '删掉' }))

    expect(await screen.findByText('没删成，再试一次。')).toBeTruthy()
    expect(onDeleted).not.toHaveBeenCalled()
  })
})
