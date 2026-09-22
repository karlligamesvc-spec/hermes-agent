import { persistString, storedString } from '@/lib/storage'

export type GenerationKind = 'image' | 'video'

export type GenerationModelIconKey =
  | 'agnes'
  | 'gemini'
  | 'gpt-flare'
  | 'gpt-sunburst'
  | 'minimax'
  | 'qwen'
  | 'seedance-2'
  | 'seedance-2-fast'
  | 'seedance-2-mini'
  | 'seedance-2.5'

export interface GenerationModel {
  icon: GenerationModelIconKey
  id: string
  label: string
}

export const IMAGE_GENERATION_MODELS: readonly GenerationModel[] = [
  { icon: 'qwen', id: 'qwen-image-3.0-pro', label: 'Qwen Image 3.0 Pro' },
  { icon: 'gemini', id: 'gemini-2.5-flash-image', label: 'Gemini Image 2.5' },
  { icon: 'agnes', id: 'agnes-image-2.5-flash', label: 'Agnes Image 2.5' },
  { icon: 'gpt-flare', id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare' },
  { icon: 'gpt-sunburst', id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst' }
]

export const VIDEO_GENERATION_MODELS: readonly GenerationModel[] = [
  { icon: 'seedance-2.5', id: 'doubao-seedance-2-5-260628', label: 'Seedance 2.5' },
  { icon: 'seedance-2', id: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0' },
  { icon: 'seedance-2-fast', id: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast' },
  { icon: 'seedance-2-mini', id: 'doubao-seedance-2-0-mini-260615', label: 'Seedance 2.0 Mini' },
  { icon: 'minimax', id: 'MiniMax-H3', label: 'MiniMax H3' }
]

const MODEL_KEYS: Record<GenerationKind, string> = {
  image: 'apex-generation-image-model-v1',
  video: 'apex-generation-video-model-v1'
}

const DEFAULT_MODEL_IDS: Record<GenerationKind, string> = {
  image: 'gpt-image-2.5-flare',
  video: 'doubao-seedance-2-0-mini-260615'
}

export const generationModels = (kind: GenerationKind): readonly GenerationModel[] =>
  kind === 'image' ? IMAGE_GENERATION_MODELS : VIDEO_GENERATION_MODELS

export function selectedGenerationModel(kind: GenerationKind): GenerationModel {
  const models = generationModels(kind)
  const stored = storedString(MODEL_KEYS[kind])

  return (
    models.find(model => model.id === stored) ?? models.find(model => model.id === DEFAULT_MODEL_IDS[kind]) ?? models[0]
  )
}

export function selectGenerationModel(kind: GenerationKind, id: string): GenerationModel {
  const selected = generationModels(kind).find(model => model.id === id)

  if (!selected) {
    return selectedGenerationModel(kind)
  }

  persistString(MODEL_KEYS[kind], selected.id)

  return selected
}

export function generationStarter(starter: string, model: GenerationModel): string {
  const base = starter.trimEnd()

  return `${base}\n\n使用模型：${model.label}\n`
}
