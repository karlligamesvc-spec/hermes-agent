import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { processKind, type TurnPart } from '@/components/assistant-ui/process/turn-process'
import { I18nProvider } from '@/i18n'
import {
  type JianyingDraftCard as Draft,
  isJianyingDraftCall,
  jianyingDraftFromResult,
  type JianyingOpenResult,
  jianyingVersionVerified
} from '@/lib/jianying-draft'

import { JianyingDraftCard } from './jianying-draft-card'

// hc-1219: the card of a 剪映 draft the engine wrote (apex_overlay/jianying_draft.py's result).

const FOLDER = '/Users/u/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/夏日 vlog'

const RESULT = {
  status: 'written',
  draft: { name: '夏日 vlog', folder: FOLDER, seconds: 14, shots: 4, subtitles: 4 },
  jianying: { version: '11.7.0', platform: 'darwin', registered: true },
  problem: null,
  changes: [],
  note: '…'
}

describe('reading the tool part', () => {
  it.each([
    ['live, by its own name', 'jianying_draft', {}, true],
    ['reloaded, as the one call through the bridge', 'tool_call', { name: 'jianying_draft', arguments: {} }, true],
    ['reloaded, in a one-item batch', 'tool_call', { calls: [{ name: 'jianying_draft' }] }, true],
    ['a batch of two', 'tool_call', { calls: [{ name: 'jianying_draft' }, { name: 'jianying_draft' }] }, false],
    ['another bridged tool', 'tool_call', { name: 'generate_video' }, false],
    ['another tool', 'image_generate', {}, false]
  ])('%s', (_label, toolName, args, expected) => {
    expect(isJianyingDraftCall(toolName, args)).toBe(expected)
  })

  it('takes a written draft from a JSON string or an object, and nothing else', () => {
    const card = {
      folder: FOLDER,
      name: '夏日 vlog',
      platform: 'darwin',
      problem: null,
      registered: true,
      seconds: 14,
      shots: 4,
      subtitles: 4,
      version: '11.7.0'
    }

    expect(jianyingDraftFromResult(JSON.stringify(RESULT))).toEqual(card)
    expect(jianyingDraftFromResult(RESULT)).toEqual(card)
    expect(jianyingDraftFromResult({ error: '这台电脑上没有找到剪映专业版' })).toBeNull()
    expect(jianyingDraftFromResult('not json')).toBeNull()
    expect(jianyingDraftFromResult(undefined)).toBeNull()
    expect(jianyingDraftFromResult({ ...RESULT, jianying: { registered: 'yes' } })?.registered).toBeNull()
  })

  it('renders as a card and counts as a step, live and reloaded', () => {
    const live = { toolName: 'jianying_draft', type: 'tool-call', args: {} } as TurnPart
    const reloaded = { toolName: 'tool_call', type: 'tool-call', args: { name: 'jianying_draft' } } as TurnPart
    const other = { toolName: 'tool_call', type: 'tool-call', args: { name: 'web_search' } } as TurnPart

    expect([processKind(live), processKind(reloaded), processKind(other)]).toEqual(['card', 'card', 'activity'])
  })

  it('knows the versions APEX tried, per platform', () => {
    expect(jianyingVersionVerified('darwin', '11.7.0')).toBe(true)
    expect(jianyingVersionVerified('darwin', '11.8.0')).toBe(false)
    expect(jianyingVersionVerified('win32', '11.7.0')).toBe(false)
    expect(jianyingVersionVerified('darwin', '')).toBe(false)
  })
})

function draft(overrides: Partial<Draft> = {}): Draft {
  return { ...(jianyingDraftFromResult(RESULT) as Draft), ...overrides }
}

function renderCard(card: Draft, locale = 'zh') {
  return render(
    <I18nProvider initialLocale={locale}>
      <JianyingDraftCard draft={card} />
    </I18nProvider>
  )
}

describe('the card', () => {
  let open: ReturnType<typeof vi.fn<(folder: string) => Promise<JianyingOpenResult>>>

  beforeEach(() => {
    open = vi.fn<(folder: string) => Promise<JianyingOpenResult>>(async () => ({ ok: true, listed: true }))
    Object.assign(window, { hermesDesktop: { openInJianying: open } })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'hermesDesktop')
  })

  it('names the draft, says what is in it and how to export, and never shows the folder', () => {
    const { container } = renderCard(draft())

    expect(screen.getByText('剪映草稿「夏日 vlog」')).toBeTruthy()
    expect(screen.getByText('14 秒 · 4 个镜头 · 4 条字幕')).toBeTruthy()
    expect(screen.getByText(/剪好后点菜单「文件 › 导出」，再点「导出」/)).toBeTruthy()
    expect(screen.getByText(/不会回到 APEX/)).toBeTruthy()
    expect(container.textContent).not.toContain('com.lveditor.draft')
    expect(container.querySelector('[data-slot="aui_jianying-draft-unverified"]')).toBeNull()
  })

  it('opens the draft’s 剪映 and says it is on the home page', async () => {
    renderCard(draft())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '在剪映中打开' })))

    expect(open).toHaveBeenCalledWith(FOLDER)
    expect(screen.getByRole('status').textContent).toBe('剪映已经打开，草稿在首页。')
  })

  it.each([
    [{ ok: true, listed: false } as JianyingOpenResult, '剪映打开了，但首页还没有这份草稿。等几秒再看；还没有的话，告诉 APEX。'],
    [{ ok: false, reason: 'not_installed' } as JianyingOpenResult, '这台电脑上没找到剪映专业版。'],
    [{ ok: false, reason: 'not_a_draft' } as JianyingOpenResult, '这份草稿已经不在剪映的草稿文件夹里了。']
  ])('says what happened when it did not go to plan: %j', async (answer, said) => {
    open.mockResolvedValueOnce(answer)
    renderCard(draft())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '在剪映中打开' })))

    expect(screen.getByRole('status').textContent).toBe(said)
  })

  it('a version APEX has not tried is said, and the button stays (prompt, not block)', () => {
    renderCard(draft({ version: '12.0.0' }))

    expect(screen.getByText('APEX 还没在剪映 12.0.0 上试过草稿，打不开的话告诉 APEX。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '在剪映中打开' })).toBeTruthy()
  })

  it('Windows gets its own export steps', () => {
    renderCard(draft({ platform: 'win32' }))

    expect(screen.getByText(/剪好后点右上角「导出」，再点「导出」/)).toBeTruthy()
  })

  it('a draft 剪映 did not take in says so and offers no button', () => {
    renderCard(draft({ problem: '首页没有出现这份草稿', registered: false }))

    expect(screen.getByText('剪映没有认出这份草稿，它可能打不开。成片照常能用。')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('剪映 closed when it was written: the draft waits for its next start', () => {
    renderCard(draft({ registered: null }))

    expect(screen.getByText('剪映现在没开，打开后这份草稿会出现在首页。')).toBeTruthy()
  })

  it('no button without the bridge (a remote engine’s draft is not on this computer)', () => {
    Reflect.deleteProperty(window, 'hermesDesktop')
    renderCard(draft())

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('reads in English', () => {
    renderCard(draft(), 'en')

    expect(screen.getByText('JianyingPro draft “夏日 vlog”')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open in JianyingPro' })).toBeTruthy()
  })
})
