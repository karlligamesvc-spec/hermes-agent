import { beforeEach, describe, expect, it } from 'vitest'

import {
  generationStarter,
  IMAGE_GENERATION_MODELS,
  selectedGenerationModel,
  selectGenerationModel,
  VIDEO_GENERATION_MODELS
} from './generation-models'

describe('APEX generation model picker', () => {
  beforeEach(() => window.localStorage.clear())

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
    expect(selectedGenerationModel('image').id).toBe('qwen-image-3.0-pro')
    expect(selectedGenerationModel('video').id).toBe('doubao-seedance-2-5-260628')
  })

  it('persists exactly one selection per media kind', () => {
    selectGenerationModel('image', 'gpt-image-2.5-flare')
    selectGenerationModel('video', 'MiniMax-H3')
    expect(selectedGenerationModel('image').id).toBe('gpt-image-2.5-flare')
    expect(selectedGenerationModel('video').id).toBe('MiniMax-H3')
  })

  it('puts the friendly model name in the starter without exposing the vendor id', () => {
    const prompt = generationStarter('我想生成一张图片,想法是:', IMAGE_GENERATION_MODELS[1])
    expect(prompt).toContain('使用模型：Gemini Image 2.5')
    expect(prompt).not.toContain('gemini-2.5-flash-image')
  })
})
