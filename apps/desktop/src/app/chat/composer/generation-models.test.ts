import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { saveHermesConfig } from '@/api/config'

import {
  generationStarter,
  IMAGE_GENERATION_MODELS,
  previouslySelectedImageModel,
  saveImageGenerationModel,
  saveVideoGenerationModel,
  selectedGenerationModel,
  selectGenerationModel,
  startupGenerationModel,
  VIDEO_GENERATION_MODELS
} from './generation-models'

vi.mock('@/api/config', () => ({ saveHermesConfig: vi.fn() }))

describe('APEX generation model picker', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
  })

  it('pins the exact image and video catalogs and defaults', () => {
    expect(IMAGE_GENERATION_MODELS.map(model => model.id)).toEqual([
      'qwen-image-3.0-pro',
      'gemini-2.5-flash-image',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst'
    ])
    expect(VIDEO_GENERATION_MODELS.map(model => model.id)).toEqual([
      'doubao-seedance-2-5-260628',
      'doubao-seedance-2-0-260128',
      'doubao-seedance-2-0-fast-260128',
      'doubao-seedance-2-0-mini-260615',
      'MiniMax-H3'
    ])
    expect(selectedGenerationModel('image').id).toBe('gpt-image-2.5-flare')
    expect(selectedGenerationModel('video').id).toBe('doubao-seedance-2-0-mini-260615')
  })

  it('gives every listed model a distinct visual identity', () => {
    const models = [...IMAGE_GENERATION_MODELS, ...VIDEO_GENERATION_MODELS]

    expect(models.map(model => model.icon)).toEqual([
      'qwen',
      'gemini',
      'gpt-flare',
      'gpt-sunburst',
      'seedance-2.5',
      'seedance-2',
      'seedance-2-fast',
      'seedance-2-mini',
      'minimax'
    ])
    expect(new Set(models.map(model => model.icon))).toHaveLength(models.length)
  })

  it('persists exactly one selection per media kind', () => {
    expect(previouslySelectedImageModel()).toBeNull()
    selectGenerationModel('image', 'gpt-image-2.5-flare')
    selectGenerationModel('video', 'MiniMax-H3')
    expect(selectedGenerationModel('image').id).toBe('gpt-image-2.5-flare')
    expect(previouslySelectedImageModel()?.id).toBe('gpt-image-2.5-flare')
    expect(selectedGenerationModel('video').id).toBe('MiniMax-H3')
  })

  it('saves the image model to the live runtime before the visible selection changes', async () => {
    const save = vi.mocked(saveHermesConfig)
    let finishSave!: (result: { ok: boolean }) => void
    save.mockReturnValueOnce(new Promise(resolve => (finishSave = resolve)))

    const pending = saveImageGenerationModel('qwen-image-3.0-pro')
    expect(save).toHaveBeenCalledWith({ apex: { generation_image_model: 'qwen-image-3.0-pro' } })
    expect(selectedGenerationModel('image').id).toBe('gpt-image-2.5-flare')
    finishSave({ ok: true })
    expect((await pending).id).toBe('qwen-image-3.0-pro')
    expect(selectedGenerationModel('image').id).toBe('qwen-image-3.0-pro')
  })

  it('keeps the prior model when the runtime rejects the update', async () => {
    vi.mocked(saveHermesConfig).mockResolvedValueOnce({ ok: false })
    await expect(saveImageGenerationModel('qwen-image-3.0-pro')).rejects.toThrow()
    expect(selectedGenerationModel('image').id).toBe('gpt-image-2.5-flare')
  })

  it('puts the friendly model name in the starter without exposing the vendor id', () => {
    const prompt = generationStarter('我想生成一张图片,想法是:', IMAGE_GENERATION_MODELS[1])
    expect(prompt).toContain('使用模型：Gemini Image 2.5')
    expect(prompt).not.toContain('gemini-2.5-flash-image')
  })
})

describe('retired image models (hc-957)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
  })

  // clearAllMocks keeps queued *Once results; never let one leak into later suites.
  afterEach(() => {
    vi.mocked(saveHermesConfig).mockReset()
  })

  it('no longer offers Agnes Image 2.5 and refuses it before writing configuration', async () => {
    expect(IMAGE_GENERATION_MODELS.map(model => model.label)).not.toContain('Agnes Image 2.5')
    await expect(saveImageGenerationModel('agnes-image-2.5-flash')).rejects.toThrow()
    expect(saveHermesConfig).not.toHaveBeenCalled()
  })

  it('moves a saved Agnes selection to GPT Image 2.5 Flare in the picker and the runtime', async () => {
    window.localStorage.setItem('apex-generation-image-model-v1', 'agnes-image-2.5-flash')
    vi.mocked(saveHermesConfig).mockResolvedValueOnce({ ok: true })

    expect(selectedGenerationModel('image').id).toBe('gpt-image-2.5-flare')
    // The composer's start-up migration saves previouslySelectedImageModel() to the runtime.
    const migrated = previouslySelectedImageModel()
    expect(migrated?.id).toBe('gpt-image-2.5-flare')
    await saveImageGenerationModel(migrated?.id ?? '')

    expect(saveHermesConfig).toHaveBeenCalledWith({ apex: { generation_image_model: 'gpt-image-2.5-flare' } })
    expect(window.localStorage.getItem('apex-generation-image-model-v1')).toBe('gpt-image-2.5-flare')
  })
})

describe('video model runtime binding', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
  })

  it.each(VIDEO_GENERATION_MODELS)('saves $label before accepting the selection', async model => {
    let finish!: (result: { ok: boolean }) => void
    vi.mocked(saveHermesConfig).mockReturnValueOnce(new Promise(resolve => {finish = resolve}))
    const pending = saveVideoGenerationModel(model.id)
    expect(saveHermesConfig).toHaveBeenCalledWith({ apex: { generation_video_model: model.id } })
    expect(selectedGenerationModel('video').id).toBe('doubao-seedance-2-0-mini-260615')
    finish({ ok: true })
    expect((await pending).id).toBe(model.id)
    expect(selectedGenerationModel('video').id).toBe(model.id)
  })

  it('retains the current video selection when saving fails', async () => {
    selectGenerationModel('video', 'MiniMax-H3')
    vi.mocked(saveHermesConfig).mockResolvedValueOnce({ ok: false })
    await expect(saveVideoGenerationModel('doubao-seedance-2-0-260128')).rejects.toThrow()
    expect(selectedGenerationModel('video').id).toBe('MiniMax-H3')
  })

  it('rejects unknown video models before writing configuration', async () => {
    await expect(saveVideoGenerationModel('unknown')).rejects.toThrow()
    expect(saveHermesConfig).not.toHaveBeenCalled()
  })
})

// hc-960 exit 31 (Kael, 2026-10-20): tier mode has no generation picker and
// always runs on the defaults.
describe('startupGenerationModel', () => {
  beforeEach(() => window.localStorage.clear())

  it('migrates nothing when nothing was ever picked, in or out of tier mode', () => {
    expect(startupGenerationModel('image', false)).toBeNull()
    expect(startupGenerationModel('video', true)).toBeNull()
  })

  it('carries an old pick forward, except in tier mode where the default replaces it', () => {
    selectGenerationModel('video', 'MiniMax-H3')

    expect(startupGenerationModel('video', false)?.id).toBe('MiniMax-H3')
    expect(startupGenerationModel('video', true)?.id).toBe('doubao-seedance-2-0-mini-260615')
  })
})
