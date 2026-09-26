import { beforeEach, describe, expect, it, vi } from 'vitest'

import { saveHermesConfig } from '@/api/config'

import {
  generationStarter,
  IMAGE_GENERATION_MODELS,
  previouslySelectedImageModel,
  saveImageGenerationModel,
  selectedGenerationModel,
  selectGenerationModel,
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
      'agnes-image-2.5-flash',
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
      'agnes',
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
    await expect(saveImageGenerationModel('agnes-image-2.5-flash')).rejects.toThrow()
    expect(selectedGenerationModel('image').id).toBe('gpt-image-2.5-flare')
  })

  it('puts the friendly model name in the starter without exposing the vendor id', () => {
    const prompt = generationStarter('我想生成一张图片,想法是:', IMAGE_GENERATION_MODELS[1])
    expect(prompt).toContain('使用模型：Gemini Image 2.5')
    expect(prompt).not.toContain('gemini-2.5-flash-image')
  })
})
