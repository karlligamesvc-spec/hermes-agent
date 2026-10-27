import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

import { ModelTierPicker } from '@/components/model-tier/tier-picker'
import { Button } from '@/components/ui/button'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { getGlobalModelInfo, setModelAssignment } from '@/hermes'
import { useI18n } from '@/i18n'
import { useModelTierCopy } from '@/i18n/model-tier'
import { triggerHaptic } from '@/lib/haptics'
import { Sparkles } from '@/lib/icons'
import {
  assistantModelChoice,
  type AssistantModelChoice,
  MODEL_TIER_ALIAS,
  MODEL_TIER_LABEL,
  type ModelTier
} from '@/lib/model-tiers'
import { MANAGED_PROVIDER_SLUG } from '@/lib/provider-allowlist'
import { useModelTierMode } from '@/store/model-tiers'
import { notify, notifyError } from '@/store/notifications'
import { useAccountModelScope } from '@/store/single-thread-bots'

import { useOnProfileSwitch } from '../hooks/use-on-profile-switch'

import { ModelSettings } from './model-settings'
import { SectionHeading } from './primitives'

/**
 * Settings › 模型 — or › 档位 on an APEX account in tier mode (hc-960).
 * hc-1077 (K3: the tier follows the account): with several assistants on, it
 * edits APEX's, whichever assistant is on screen; the others follow it
 * (hc-1080). Never one assistant's own.
 */
export function ModelSection(section: {
  onMainModelChanged?: (provider: string, model: string) => void
  scopeProfile?: string
}) {
  const props = { ...section, scopeProfile: useAccountModelScope(section.scopeProfile) }

  return useModelTierMode() ? <ModelTierSettings {...props} /> : <ModelSettings {...props} />
}

/**
 * Settings › 档位 for an APEX account (hc-960): "这个助手用哪一档" for the
 * assistant this page is scoped to, plus the user's own model service folded
 * under 高级 (kept, not deleted — BYOK still works). Replaces the model page,
 * which named models and let an account multi-select the platform shelf.
 */
export function ModelTierSettings({
  onMainModelChanged,
  scopeProfile
}: {
  onMainModelChanged?: (provider: string, model: string) => void
  scopeProfile?: string
}) {
  const { t } = useI18n()
  const copy = useModelTierCopy()
  const [, setSearchParams] = useSearchParams()
  const [choice, setChoice] = useState<AssistantModelChoice | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState<ModelTier | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // A read still in flight when the page re-scopes must not paint the previous
  // assistant's tier onto this one.
  const epoch = useRef(0)

  const load = useCallback(async () => {
    const current = ++epoch.current
    setLoadFailed(false)

    try {
      const info = await getGlobalModelInfo(scopeProfile)

      if (current === epoch.current) {
        setChoice(assistantModelChoice(info.model, info.provider))
      }
    } catch {
      if (current === epoch.current) {
        setLoadFailed(true)
      }
    }
  }, [scopeProfile])

  useEffect(() => {
    void load()
  }, [load])

  useOnProfileSwitch(() => {
    setChoice(null)
    void load()
  })

  const pick = async (tier: ModelTier) => {
    const current = epoch.current
    const model = MODEL_TIER_ALIAS[tier]
    setSaving(tier)

    try {
      const result = await setModelAssignment({ model, provider: MANAGED_PROVIDER_SLUG, scope: 'main' }, scopeProfile)

      if (current !== epoch.current) {
        return
      }

      setChoice({ kind: 'tier', legacy: false, tier })
      triggerHaptic('success')
      notify({ kind: 'success', message: copy.saved(MODEL_TIER_LABEL[tier]) })

      // Only the window's own assistant feeds the composer's next session.
      if (scopeProfile == null) {
        onMainModelChanged?.(result.provider || MANAGED_PROVIDER_SLUG, result.model || model)
      }
    } catch (err) {
      notifyError(err, copy.saveFailed)
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="grid gap-6" data-testid="model-tier-settings">
      <section className="grid gap-2.5">
        <SectionHeading icon={Sparkles} title={copy.sectionTitle} />
        <p className="text-xs leading-5 text-muted-foreground">{copy.intro}</p>
        {choice?.kind === 'own' ? (
          <p className="rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary)/40 px-3 py-2 text-xs leading-5 text-foreground">
            {copy.ownModelNotice}
          </p>
        ) : null}
        {loadFailed ? (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <span>{copy.loadFailed}</span>
            <Button onClick={() => void load()} size="sm" variant="textStrong">
              {t.common.retry}
            </Button>
          </div>
        ) : null}
        <ModelTierPicker
          disabled={!choice}
          label={copy.sectionTitle}
          onChange={tier => void pick(tier)}
          saving={saving}
          value={choice?.kind === 'tier' ? choice.tier : null}
        />
        <p className="text-xs leading-5 text-muted-foreground">{copy.retryHint}</p>
      </section>

      <section className="grid gap-2.5">
        <Button
          aria-expanded={advancedOpen}
          className="flex w-fit items-center gap-1 text-xs font-medium text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)"
          onClick={() => setAdvancedOpen(open => !open)}
          size="inline"
          variant="text"
        >
          <DisclosureCaret open={advancedOpen} />
          {copy.advancedTitle}
        </Button>
        {advancedOpen ? (
          <div className="grid gap-3 rounded-md border border-(--ui-stroke-secondary) p-3">
            <p className="text-xs leading-5 text-muted-foreground">{copy.advancedHint}</p>
            <Button
              className="w-fit"
              onClick={() =>
                setSearchParams(previous => {
                  const next = new URLSearchParams(previous)
                  next.set('tab', 'providers')

                  return next
                })
              }
              size="sm"
              variant="outline"
            >
              {copy.manageProviders}
            </Button>
            <ModelSettings
              onMainModelChanged={(provider, model) => {
                onMainModelChanged?.(provider, model)
                void load()
              }}
              ownProvidersOnly
              scopeProfile={scopeProfile}
            />
          </div>
        ) : null}
      </section>
    </div>
  )
}
