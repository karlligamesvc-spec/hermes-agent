import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GenLadderCard as GenLadderCardModel } from '@/lib/gen-ladder'

import { GenLadderCard, type GenLadderEvent, genLadderEvent } from './gen-ladder-card'
import { genLadderCopy } from './gen-ladder-copy'

// ── card builders mirroring the gen-ladder/1 card protocol ───────────────────

const LADDER = [
  { key: 'prompt', label: '提示词', status: 'current' as const },
  { key: 'draft', label: '图草稿', status: 'todo' as const },
  { key: 'refine', label: '精修', status: 'todo' as const },
  { key: 'fork', label: '高清图/视频预览', status: 'todo' as const },
  { key: 'final', label: '成品视频', status: 'todo' as const }
]

const LANGUAGE_OVERRIDE = {
  id: 'set_language',
  supported: true,
  current: 'en',
  options: ['zh', 'zh-TW', 'en', 'ja', 'ko'],
  hint: '…'
}

// implemented:false — the render layer must NOT surface an edit action for it.
const EDIT_SLOT = {
  id: 'edit_region',
  supported: true,
  implemented: false,
  hint: '…',
  applies_to: ['prompt', 'draft', 'fork', 'hd_image']
}

function base(overrides: Partial<GenLadderCardModel>): GenLadderCardModel {
  return {
    protocol_version: 'gen-ladder/1',
    stage: 'prompt',
    modality: 'image',
    language: 'en',
    ladder: LADDER,
    language_override: LANGUAGE_OVERRIDE,
    edit_action_slot: EDIT_SLOT,
    ...overrides
  }
}

function renderCard(card: GenLadderCardModel) {
  const onEvent = vi.fn<(event: GenLadderEvent) => void>()
  const utils = render(<GenLadderCard card={card} onEvent={onEvent} />)

  return { ...utils, onEvent }
}

afterEach(cleanup)

describe('GenLadderCard — stepper + chrome', () => {
  it('renders the 5-step stepper localized by step key', () => {
    renderCard(base({ type: 'prompt', title: 'x' }))
    const stepper = screen.getByRole('list')

    expect(within(stepper).getByText('Prompt')).toBeTruthy()
    expect(within(stepper).getByText('Drafts')).toBeTruthy()
    expect(within(stepper).getByText('Final video')).toBeTruthy()
  })

  it('never renders an action for edit_action_slot while implemented:false', () => {
    renderCard(base({ type: 'prompt', title: 'x', actions: [{ id: 'edit_prompt', kind: 'free', label: '继续改提示词' }] }))

    // The only free control is "Keep editing the prompt"; the edit-region slot
    // stays a protocol placeholder with no button.
    expect(screen.queryByText(/edit region/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /局部修改/ })).toBeNull()
  })
})

describe('GenLadderCard — entry card', () => {
  it('renders three entry choices with descriptions and starts on click', () => {
    const { onEvent } = renderCard(
      base({
        type: 'entry',
        title: '要做图还是做视频?',
        actions: [
          { id: 'entry_text', kind: 'select', entry_mode: 'text', label: '💬 描述想法', desc: '说人话' },
          { id: 'entry_image', kind: 'select', entry_mode: 'image', label: '🖼 传图复刻', desc: '换成你的货' },
          { id: 'entry_video', kind: 'select', entry_mode: 'video', label: '🎬 传视频复刻', desc: '重拍' }
        ]
      })
    )

    expect(screen.getByText('Describe an idea', { exact: false })).toBeTruthy()
    expect(screen.getByText('A rival hit image → swap in your product')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Replicate from an image/ }))

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0][0].callback).toEqual({ action: 'start', payload: { entry_mode: 'image' } })
  })
})

describe('GenLadderCard — prompt card (priced button)', () => {
  const promptCard = base({
    type: 'prompt',
    title: '反推提示词',
    fields: [
      { id: 'prompt.subject', key: 'subject', label: '主体', value: '一瓶洗发水', editable: true, highlight: true },
      { id: 'prompt.scene', key: 'scene', label: '场景', value: '浴室台面', editable: true }
    ],
    reference: {
      more_like_original: { id: 'more_like_original', value: true, label: '更像原图', available: true }
    },
    actions: [
      {
        id: 'confirm_draft',
        kind: 'spend',
        label: '出 4 张草稿',
        target_stage: 'draft',
        price: { kind: 'draft', amount_cents: 40, currency: 'CNY', estimated: true, display: '≈¥0.40 示意', unit: 'per_batch' }
      },
      { id: 'edit_prompt', kind: 'free', label: '继续改提示词' }
    ]
  })

  it('renders fields and the reference flag', () => {
    renderCard(promptCard)

    expect(screen.getByText('一瓶洗发水')).toBeTruthy()
    expect(screen.getByText('浴室台面')).toBeTruthy()
    expect(screen.getByText('Closer to the original')).toBeTruthy()
  })

  it('shows the price display verbatim plus a localized estimated marker', () => {
    renderCard(promptCard)
    const spend = screen.getByRole('button', { name: /Generate 4 drafts/ })

    // Protocol: display shown verbatim (with its 示意), never repriced.
    expect(within(spend).getByText('≈¥0.40 示意')).toBeTruthy()
    // Deliverable #4: render-owned estimated badge, localized to the card language.
    const badge = within(spend).getByText('est.')

    expect(badge.getAttribute('data-estimated')).toBe('true')
  })

  it('a spend tap confirms to the target stage with a natural message', () => {
    const { onEvent } = renderCard(promptCard)

    fireEvent.click(screen.getByRole('button', { name: /Generate 4 drafts/ }))

    expect(onEvent).toHaveBeenCalledTimes(1)
    const event = onEvent.mock.calls[0][0]

    expect(event.callback).toEqual({ action: 'confirm', payload: { target_stage: 'draft' } })
    expect(event.message).toBe('Confirm: Generate 4 drafts')
  })

  it('self-locks after the first action so a priced button cannot double-fire', () => {
    const { onEvent } = renderCard(promptCard)
    const spend = screen.getByRole('button', { name: /Generate 4 drafts/ })

    fireEvent.click(spend)
    fireEvent.click(spend)
    fireEvent.click(screen.getByRole('button', { name: /Keep editing the prompt/ }))

    expect(onEvent).toHaveBeenCalledTimes(1)
  })
})

describe('GenLadderCard — draft select', () => {
  const draftCard = base({
    type: 'draft_select',
    status: 'ready',
    stage: 'draft',
    title: '图片草稿 · 选方向',
    body: '不满意?回上一档改提示词',
    media: [
      { kind: 'image', index: 0, ref: 'r0', url: 'https://x/0.png', label: '草稿 1' },
      { kind: 'image', index: 1, ref: 'r1', url: 'https://x/1.png', label: '草稿 2' },
      { kind: 'image', index: 2, ref: 'r2', url: 'https://x/2.png', label: '草稿 3' },
      { kind: 'image', index: 3, ref: 'r3', url: 'https://x/3.png', label: '草稿 4' }
    ],
    actions: [
      { id: 'select_draft', kind: 'select', index: 0, label: '选这张' },
      { id: 'select_draft', kind: 'select', index: 1, label: '选这张' },
      { id: 'select_draft', kind: 'select', index: 2, label: '选这张' },
      { id: 'select_draft', kind: 'select', index: 3, label: '选这张' },
      { id: 'back', kind: 'free', label: '回上一档改提示词(便宜)', target_stage: 'prompt' }
    ]
  })

  it('makes each thumbnail the select-by-index control and localizes the body', () => {
    const { onEvent } = renderCard(draftCard)

    expect(screen.getByText('Not quite?', { exact: false })).toBeTruthy()
    const thumbs = screen.getAllByRole('button', { name: /Pick this one/ })

    expect(thumbs).toHaveLength(4)
    fireEvent.click(thumbs[2])

    expect(onEvent.mock.calls[0][0].callback).toEqual({ action: 'select', payload: { index: 2 } })
    expect(onEvent.mock.calls[0][0].message).toBe('Pick draft #3')
  })

  it('renders the free back control as a button (not a thumbnail)', () => {
    const { onEvent } = renderCard(draftCard)

    fireEvent.click(screen.getByRole('button', { name: /Step back/ }))

    expect(onEvent.mock.calls[0][0].callback).toEqual({ action: 'back', payload: { target_stage: 'prompt' } })
  })
})

describe('GenLadderCard — fork card', () => {
  it('offers the three fork spends and confirms to hd_image', () => {
    const { onEvent } = renderCard(
      base({
        type: 'fork',
        stage: 'fork',
        title: '构图已锁定',
        selected: { ref: 'r1', url: 'https://x/1.png', label: '草稿 2' },
        actions: [
          { id: 'confirm_hd_image', kind: 'spend', label: '出高清成品图', target_stage: 'hd_image', price: { display: '≈¥0.50 示意', estimated: true } },
          { id: 'confirm_video_preview', kind: 'spend', label: '🎬 让它动起来', target_stage: 'video_preview', price: { display: '≈¥1.50 示意', estimated: true } },
          { id: 'confirm_refine', kind: 'spend', label: '先精修细节', target_stage: 'refine', price: { display: '≈¥0.10 示意', estimated: true } },
          { id: 'back', kind: 'free', label: '回上一档改提示词(便宜)', target_stage: 'prompt' }
        ]
      })
    )

    fireEvent.click(screen.getByRole('button', { name: /Render HD image/ }))

    expect(onEvent.mock.calls[0][0].callback).toEqual({ action: 'confirm', payload: { target_stage: 'hd_image' } })
  })
})

describe('GenLadderCard — video preview with model picker', () => {
  const previewCard = base({
    type: 'video_preview',
    status: 'ready',
    stage: 'video_preview',
    modality: 'video',
    title: '视频预览 · 5s / 480P',
    media: [{ kind: 'video', ref: 'p1', url: 'https://x/p.mp4', label: '0:05 · 480P 预览' }],
    actions: [
      {
        id: 'confirm_final_video',
        kind: 'spend',
        label: '✓ 方向对,出成品',
        target_stage: 'final_video',
        price: { display: '≈¥6 示意', estimated: true },
        model_options: ['Seedance 2.0', 'Kling V3', 'Hailuo 2.3']
      },
      { id: 'confirm_video_preview', kind: 'spend', label: '改分镜再预览', target_stage: 'video_preview', price: { display: '≈¥1.5 示意', estimated: true } },
      { id: 'back', kind: 'free', label: '回分叉重选(便宜)', target_stage: 'fork' }
    ]
  })

  it('defaults to the first model and folds the pick into the confirm payload', () => {
    const { onEvent } = renderCard(previewCard)

    // Change the model, then confirm.
    fireEvent.click(screen.getByRole('button', { name: 'Kling V3' }))
    fireEvent.click(screen.getByRole('button', { name: /render final/i }))

    expect(onEvent.mock.calls[0][0].callback).toEqual({
      action: 'confirm',
      payload: { target_stage: 'final_video', model: 'Kling V3' }
    })
  })
})

describe('GenLadderCard — final card + bill', () => {
  it('renders the ladder-vs-direct bill displays verbatim', () => {
    renderCard(
      base({
        type: 'final',
        status: 'done',
        stage: 'done',
        title: '成品已出。',
        media: [{ kind: 'image', ref: 'f', url: 'https://x/final.png', label: '成品' }],
        bill: {
          ladder_total_cents: 240,
          ladder_total_display: '≈¥2.40',
          naive_total_cents: 1000,
          naive_total_display: '≈¥10.00',
          attempts: 2,
          note: '账单为示意估算'
        }
      })
    )

    expect(screen.getByText('≈¥2.40')).toBeTruthy()
    expect(screen.getByText('≈¥10.00')).toBeTruthy()
    expect(screen.getByText(/This ladder, all in/)).toBeTruthy()
  })
})

describe('GenLadderCard — reference gate (real-person guardrail)', () => {
  it('shows the guidance note and routes acknowledge_rights on consent', () => {
    const { onEvent } = renderCard(
      base({
        type: 'reference_gate',
        title: '参考图涉及真人 · 需确认',
        guidance: 'Please switch to a fictional subject or confirm you hold the rights.',
        gate: { status: 'blocked', severity: 'high' },
        actions: [
          { id: 'edit_prompt', kind: 'free', label: '改成虚构人物 / 泛化描述' },
          { id: 'acknowledge_rights', kind: 'confirm_sensitive', label: '我拥有授权,继续', hint: '仅在你确认拥有授权时' }
        ]
      })
    )

    expect(screen.getByRole('note')).toBeTruthy()
    expect(screen.getByText(/switch to a fictional subject/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /I hold the rights/ }))

    expect(onEvent.mock.calls[0][0].callback).toEqual({ action: 'acknowledge_rights', payload: {} })
    expect(onEvent.mock.calls[0][0].message).toBe('I confirm I hold the rights to this reference. Continue.')
  })
})

describe('GenLadderCard — generating skeleton', () => {
  it('shows a generating status and no action buttons', () => {
    renderCard(
      base({
        type: 'draft',
        status: 'generating',
        stage: 'draft',
        title: '图片草稿生成中…',
        media: [],
        price: { display: '≈¥0.40 示意', estimated: true }
      })
    )

    expect(screen.getByText('Generating…')).toBeTruthy()
    // No action controls while generating (the language switcher still renders,
    // so scope the assertion to the actions slot).
    expect(document.querySelector('[data-slot="gen-ladder-actions"]')).toBeNull()
  })
})

describe('GenLadderCard — language override', () => {
  it('renders the switcher and sends set_language on pick', () => {
    const { onEvent } = renderCard(base({ type: 'prompt', title: 'x', actions: [] }))

    fireEvent.click(screen.getByRole('button', { name: '日本語' }))

    expect(onEvent.mock.calls[0][0].callback).toEqual({ action: 'set_language', payload: { language: 'ja' } })
  })

  it('disables the current language button', () => {
    renderCard(base({ type: 'prompt', title: 'x', language: 'en', actions: [] }))

    expect(screen.getByRole('button', { name: 'English' })).toHaveProperty('disabled', true)
  })
})

describe('GenLadderCard — forward-compat graceful degradation', () => {
  it('renders an unknown gen-ladder/2 card type generically (stepper + title + actions)', () => {
    const { onEvent } = renderCard(
      base({
        protocol_version: 'gen-ladder/2',
        type: 'super_new_card',
        title: 'A brand new card',
        body: 'Something the desktop has never seen.',
        actions: [
          { id: 'confirm_future', kind: 'spend', label: 'Do the new thing', target_stage: 'future_stage', price: { display: '≈¥9', estimated: false } }
        ]
      })
    )

    // Unknown title falls back to the server text; the generic spend button works.
    expect(screen.getByText('A brand new card')).toBeTruthy()
    expect(screen.getByText('Something the desktop has never seen.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Do the new thing/ }))

    expect(onEvent.mock.calls[0][0].callback).toEqual({ action: 'confirm', payload: { target_stage: 'future_stage' } })
  })

  it('shows an unsupported note for a content-less card instead of a blank frame', () => {
    renderCard(base({ type: 'unknown', language: 'en' }))

    expect(screen.getByText(genLadderCopy('en').unsupported)).toBeTruthy()
  })

  it('does not render a firm charge for an estimated price (no data-estimated=false shown as final)', () => {
    renderCard(
      base({
        type: 'super_new_card',
        title: 'x',
        actions: [{ id: 'c', kind: 'spend', label: 'Buy', target_stage: 's', price: { display: '¥9.00', estimated: false } }]
      })
    )

    // Firm price: display shown, but no estimated badge.
    expect(screen.getByText('¥9.00')).toBeTruthy()
    expect(screen.queryByText('est.')).toBeNull()
  })
})

describe('GenLadderCard — disabled (gateway offline)', () => {
  it('does not emit when disabled', () => {
    const onEvent = vi.fn<(event: GenLadderEvent) => void>()
    render(
      <GenLadderCard
        card={base({ type: 'prompt', title: 'x', actions: [{ id: 'go_now', kind: 'spend', label: 'Go', target_stage: 'draft', price: { display: '¥1', estimated: false } }] })}
        disabled
        onEvent={onEvent}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Go/ }))

    expect(onEvent).not.toHaveBeenCalled()
  })
})

describe('genLadderEvent — localized messages follow the card language', () => {
  it('builds a Japanese confirm message from the ja copy bundle', () => {
    const event = genLadderEvent({ id: 'confirm_draft', kind: 'spend', label: '出 4 张草稿', target_stage: 'draft' }, genLadderCopy('ja'))

    expect(event.callback.action).toBe('confirm')
    expect(event.message.startsWith('確認:')).toBe(true)
  })
})
