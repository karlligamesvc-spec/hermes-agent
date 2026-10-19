/**
 * An assistant's tier in Bot Mode's dialogs (hc-960).
 *
 * Kael 2026-10-19 (decision B): the tier lives in each assistant's own
 * settings. On an APEX account in tier mode "添加助手" and "编辑…" show the
 * Flash / Pro / Max cards in the main form and no model picker; the pick is
 * written as the tier alias on the managed relay. A bot on another machine
 * runs on that machine's providers, so it keeps the plain picker.
 */

import {
  assistantModelChoice,
  DEFAULT_MODEL_TIER,
  MODEL_TIER_ALIAS,
  MODEL_TIER_PROVIDER,
  type ModelTier,
  ModelTierPicker,
  useModelTierMode,
  useQuery
} from '@hermes/plugin-sdk'
import { useState } from 'react'

import type { BotsMessages } from './i18n'
import { ModelPicker } from './model-picker'
import type { ProfileDescribeResponse } from './profile-config'
import { requestForBot } from './routing'
import { ID } from './shared'
import type { RosterRow } from './types'

export interface NewBotModel {
  model: string
  provider: string
  reset: () => void
  setModel: (model: string) => void
  setProvider: (provider: string) => void
  setTier: (tier: ModelTier) => void
  /** Tier cards instead of a model picker for this new assistant. */
  shown: boolean
  tier: ModelTier
}

/**
 * "添加助手": how the new assistant's model is chosen. On an APEX account in
 * tier mode it starts on the default tier; created on another machine (a
 * registry connection that is not the active one) it runs on THAT machine's
 * providers, so the plain picker's provider/model apply instead.
 */
export function useNewBotModel(
  targetConnection: string,
  activeConnectionId: string
): NewBotModel & { remoteTarget: boolean } {
  const tierMode = useModelTierMode()
  const [tier, setTier] = useState<ModelTier>(DEFAULT_MODEL_TIER)
  const [model, setModel] = useState('')
  const [provider, setProvider] = useState('')
  const remoteTarget = Boolean(targetConnection) && targetConnection !== (activeConnectionId || 'local')

  const reset = () => {
    setTier(DEFAULT_MODEL_TIER)
    setModel('')
    setProvider('')
  }

  return {
    model,
    provider,
    remoteTarget,
    reset,
    setModel,
    setProvider,
    setTier,
    shown: tierMode && !remoteTarget,
    tier
  }
}

/** The model fields `profiles.create` carries: the tier alias on the relay in
 *  tier mode, else the picker's pick when both halves are set, else nothing
 *  (the clone source's model stands). */
export function createModelFields({ model, provider, shown, tier }: NewBotModel) {
  if (shown) {
    return { model: MODEL_TIER_ALIAS[tier], provider: MODEL_TIER_PROVIDER }
  }

  return model.trim() && provider.trim() ? { model: model.trim(), provider: provider.trim() } : {}
}

export function NewBotTierField({ choice }: { choice: NewBotModel }) {
  return choice.shown ? <ModelTierPicker onChange={choice.setTier} showTitle value={choice.tier} /> : null
}

/** The plain model picker under "添加助手" › Advanced — only for a bot that
 *  does not run on a tier (no tier mode, or created on another machine). */
export function NewBotModelPicker({ choice }: { choice: NewBotModel }) {
  if (choice.shown) {
    return null
  }

  return (
    <ModelPicker
      onChange={patch => {
        if ('provider' in patch) {
          choice.setProvider(patch.provider)
        }

        if ('model' in patch) {
          choice.setModel(patch.model)
        }
      }}
      placeholderModel="inherited from launch profile"
      value={{ model: choice.model, provider: choice.provider }}
    />
  )
}

interface AdvancedModelState {
  dirtyModel: boolean
  loaded: boolean
  model: string
  provider: string
}

export interface EditBotTier {
  /** The advanced editor's state to save: a changed tier rides as its model
   *  section, through the same applier (and expensive-model confirm). */
  applyTo: <T extends AdvancedModelState>(state: T) => T
  loaded: boolean
  reset: () => void
  setPick: (tier: ModelTier) => void
  shown: boolean
  value: ModelTier | null
}

/** "编辑…": read the assistant's current tier, stage a new one. */
export function useEditBotTier(bot: null | RosterRow, open: boolean): EditBotTier {
  const tierMode = useModelTierMode()
  const shown = Boolean(bot && tierMode && !bot.remoteSource)
  const [pick, setPick] = useState<ModelTier | null>(null)

  const describe = useQuery({
    queryKey: [ID, 'edit-tier', bot?.connectionId ?? '', bot?.name ?? '', open],
    queryFn: () => requestForBot(bot, 'profiles.describe', { name: bot?.name }) as Promise<ProfileDescribeResponse>,
    enabled: open && shown,
    retry: false
  })

  const model = describe.data?.model
  const choice = describe.data ? assistantModelChoice(model?.default, model?.provider) : null
  const saved = choice?.kind === 'tier' ? choice.tier : null

  return {
    applyTo: state =>
      shown && pick !== null && pick !== saved
        ? { ...state, dirtyModel: true, loaded: true, model: MODEL_TIER_ALIAS[pick], provider: MODEL_TIER_PROVIDER }
        : state,
    loaded: Boolean(describe.data),
    reset: () => setPick(null),
    setPick,
    shown,
    value: pick ?? saved
  }
}

export function EditBotTierField({ tier }: { tier: EditBotTier }) {
  return tier.shown ? (
    <ModelTierPicker disabled={!tier.loaded} onChange={tier.setPick} showTitle value={tier.value} />
  ) : null
}

/** The advanced fold's caption: without "model" once the tier owns it. */
export function advancedHintFor(b: BotsMessages, onTier: boolean): string {
  return onTier ? b.bot.advancedHintTiers : b.bot.advancedHint
}
