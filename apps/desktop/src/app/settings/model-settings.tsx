import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  getAuxiliaryModels,
  getGlobalModelInfo,
  getGlobalModelOptions,
  getHermesConfigRecord,
  getMoaModels,
  saveHermesConfig,
  saveMoaModels,
  setModelAssignment
} from '@/hermes'
import type {
  AuxiliaryModelsResponse,
  MoaConfigResponse,
  MoaModelSlot,
  ModelInfoResponse,
  ModelOptionProvider,
  StaleAuxAssignment
} from '@/hermes'
import { useI18n } from '@/i18n'
import { AlertTriangle, Cpu } from '@/lib/icons'
import { AUTO_PRESET_NAME, buildAutoMoaConfig, composeAutoMoa, expandMoaPresetMembers, routedKey } from '@/lib/moa-compose'
import { displayModelName } from '@/lib/model-status-label'
import { filterPickerProviders, isManagedProviderSlug, isPickerVisibleProvider } from '@/lib/provider-allowlist'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import type { HermesConfigRecord } from '@/types/hermes'

import { CONTROL_TEXT } from './constants'
import { getNested, setNested } from './helpers'
import { ListRow, LoadingState, Pill, SectionHeading } from './primitives'

// Hermes' reasoning levels (VALID_REASONING_EFFORTS); `none` = thinking off.
// Empty config = Hermes default (medium), shown as Medium.
const EFFORT_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

// agent.service_tier stores "fast"/"priority"/"on" for fast; anything else is
// normal (mirrors tui_gateway _load_service_tier).
const isFastTier = (tier: unknown): boolean =>
  ['fast', 'priority', 'on'].includes(String(tier ?? '').trim().toLowerCase())

// Reuse the composer's effort labels (`xhigh` shows as "Max", else 1:1).
const effortLabelKey = (v: string) => (v === 'xhigh' ? 'max' : v) as 'high' | 'low' | 'max' | 'medium' | 'minimal'

// A provider row is "ready" to pick a model from when it reports models. The
// backend now surfaces the full `hermes model` universe (every canonical
// provider), so unconfigured providers come back with `authenticated:false`
// and an empty `models` list — those need a setup step (Settings › Providers)
// before a model exists here.
function isProviderReady(p?: ModelOptionProvider): boolean {
  return !!p && (p.authenticated !== false || (p.models?.length ?? 0) > 0)
}

// Mirrors `_AUX_TASK_SLOTS` in hermes_cli/web_server.py. Friendly labels and
// hints make the assignments readable; raw task keys (vision, mcp, …) are
// opaque to most users.
interface AuxTaskMeta {
  key: string
}

const AUX_TASKS: readonly AuxTaskMeta[] = [
  { key: 'vision' },
  { key: 'web_extract' },
  { key: 'compression' },
  { key: 'skills_hub' },
  { key: 'approval' },
  { key: 'mcp' },
  { key: 'title_generation' },
  { key: 'curator' }
]

const NO_PROVIDERS: readonly ModelOptionProvider[] = [{ name: '—', slug: '', models: [] }]

/** A selectable model chip. `raw` is the id as it appears in the provider's
 *  model list (what the single-model apply path sends verbatim — regression
 *  red line); the MoA composer separately normalizes it to the routed id. */
interface ModelChip {
  provider: string
  raw: string
  label: string
}

/** Reconstruct the picker selection from the currently-applied main model so
 *  reopening the page shows what is active. `provider === 'moa'` means a
 *  composed multi-model preset is live — expand it back to its member set;
 *  otherwise it's a single model (platform or BYO). Pure so it can be reasoned
 *  about without the component. */
function initialSelection(
  info: Pick<ModelInfoResponse, 'model' | 'provider'>,
  moa: MoaConfigResponse | null,
  managedModels: readonly string[]
): { platform: string[]; byo: MoaModelSlot | null } {
  const rawByRouted = new Map<string, string>()
  managedModels.forEach(raw => {
    const key = routedKey(raw)

    if (!rawByRouted.has(key)) {
      rawByRouted.set(key, raw)
    }
  })

  const provider = String(info.provider || '').trim().toLowerCase()

  if (provider === 'moa') {
    // Emit in directory order so the composed aggregator stays deterministic.
    return { platform: expandMoaPresetMembers(moa, info.model, managedModels), byo: null }
  }

  if (!info.model || !provider) {
    return { platform: [], byo: null }
  }

  if (isManagedProviderSlug(info.provider)) {
    const raw = rawByRouted.get(routedKey(info.model)) ?? info.model

    return { platform: [raw], byo: null }
  }

  if (isPickerVisibleProvider(info.provider)) {
    return { platform: [], byo: { provider: info.provider, model: info.model } }
  }

  return { platform: [], byo: null }
}

interface StaleAuxWarningProps {
  applying: boolean
  onReset: () => void
  slots: readonly StaleAuxAssignment[]
  taskLabel: (key: string) => string
}

// Shared notice: auxiliary tasks still pinned to a provider that isn't the
// current main. Surfaces the silent credit-burn path (e.g. aux pinned to a
// $0-balance provider after switching main away from it) and offers the
// existing one-click reset rather than auto-clearing legitimate pins.
function StaleAuxWarning({ applying, onReset, slots, taskLabel }: StaleAuxWarningProps) {
  const { t } = useI18n()

  if (!slots.length) {
    return null
  }

  const m = t.settings.model
  const provider = slots[0].provider
  const allSameProvider = slots.every(slot => slot.provider === provider)
  const names = slots.map(slot => taskLabel(slot.task)).join(', ')

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="grow">{m.staleAux(slots.length, names, allSameProvider ? provider : m.staleAuxOtherProviders)}</span>
      <Button disabled={applying} onClick={onReset} size="sm" variant="textStrong">
        {m.resetAllToMain}
      </Button>
    </div>
  )
}

interface ChipButtonProps {
  active: boolean
  disabled?: boolean
  label: string
  onClick: () => void
}

// One model chip. Selected = primary tint + check; disabled = grayed (BYO while
// 2+ platform models are picked). Styling stays on semantic tokens so light/dark
// both read correctly.
function ChipButton({ active, disabled, label, onClick }: ChipButtonProps) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        active
          ? 'border-primary bg-primary/10 font-medium text-foreground'
          : 'border-muted-foreground/25 text-foreground hover:border-primary/60',
        disabled && 'cursor-not-allowed opacity-40 hover:border-muted-foreground/25'
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {active && <span aria-hidden className="text-primary">✓</span>}
      {label}
    </button>
  )
}

interface ModelSettingsProps {
  /** Notified after the main model is applied, so live UI stores can sync. */
  onMainModelChanged?: (provider: string, model: string) => void
}

export function ModelSettings({ onMainModelChanged }: ModelSettingsProps) {
  const { t } = useI18n()
  const m = t.settings.model
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mainModel, setMainModel] = useState<{ model: string; provider: string } | null>(null)
  const [providers, setProviders] = useState<ModelOptionProvider[]>([])
  // Picker selection. Platform models (managed relay) multi-select; BYO stays
  // single (they don't mix in v1 — MOA-INVISIBLE-DESIGN §9). `platformSel` holds
  // the raw ids in directory order.
  const [platformSel, setPlatformSel] = useState<string[]>([])
  const [byoSel, setByoSel] = useState<MoaModelSlot | null>(null)
  const [auxiliary, setAuxiliary] = useState<AuxiliaryModelsResponse | null>(null)
  const [moa, setMoa] = useState<MoaConfigResponse | null>(null)
  // Full profile config, kept so the reasoning/speed defaults round-trip
  // (read agent.* → write back the whole record) like the generic config page.
  const [config, setConfig] = useState<HermesConfigRecord | null>(null)
  const [applying, setApplying] = useState(false)
  const [editingAuxTask, setEditingAuxTask] = useState<null | string>(null)
  const [auxDraft, setAuxDraft] = useState<{ model: string; provider: string }>({ model: '', provider: '' })
  // Aux slots reported stale by the backend immediately after a main-model
  // switch (provider differs from the new main). Cleared on next switch/reset.
  const [switchStaleAux, setSwitchStaleAux] = useState<StaleAuxAssignment[]>([])

  // Latest MoA config, read inside the serialized applier without re-binding it
  // (so a burst of chip toggles composes against the freshest presets).
  const moaRef = useRef<MoaConfigResponse | null>(null)
  useEffect(() => {
    moaRef.current = moa
  }, [moa])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      const [modelInfo, modelOptions, auxiliaryModels, moaModels, cfg] = await Promise.all([
        getGlobalModelInfo(),
        getGlobalModelOptions(),
        getAuxiliaryModels(),
        getMoaModels().catch(() => null),
        getHermesConfigRecord()
      ])

      const providerList = modelOptions.providers || []
      setMainModel({ model: modelInfo.model, provider: modelInfo.provider })
      setProviders(providerList)
      setAuxiliary(auxiliaryModels)
      setMoa(moaModels)
      setConfig(cfg)

      const visible = filterPickerProviders(providerList)
      const managed = visible.find(p => isManagedProviderSlug(p.slug, p.name))
      const { platform, byo } = initialSelection(modelInfo, moaModels, managed?.models ?? [])
      setPlatformSel(platform)
      setByoSel(byo)
    } catch (err) {
      console.error('[model-settings] request failed', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const providerOptions = providers.length ? providers : NO_PROVIDERS

  // China-first visible providers, split into the managed platform relay (its
  // models multi-select) and everything else (BYO, single-select). The virtual
  // `moa` provider row the backend injects is dropped here — filterPickerProviders
  // never keeps it — so "MoA" never surfaces as a selectable model.
  const visibleProviders = useMemo(() => filterPickerProviders(providers), [providers])

  const managedProvider = useMemo(
    () => visibleProviders.find(p => isManagedProviderSlug(p.slug, p.name)) ?? null,
    [visibleProviders]
  )

  const platformChips = useMemo<ModelChip[]>(() => {
    if (!managedProvider || !isProviderReady(managedProvider)) {
      return []
    }

    const seen = new Set<string>()
    const chips: ModelChip[] = []

    for (const raw of managedProvider.models ?? []) {
      const key = routedKey(raw)

      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      chips.push({ provider: managedProvider.slug, raw, label: displayModelName(raw) })
    }

    return chips
  }, [managedProvider])

  const byoChips = useMemo<ModelChip[]>(() => {
    const chips: ModelChip[] = []

    for (const provider of visibleProviders) {
      if (isManagedProviderSlug(provider.slug, provider.name) || !isProviderReady(provider)) {
        continue
      }

      for (const raw of provider.models ?? []) {
        chips.push({ provider: provider.slug, raw, label: displayModelName(raw) })
      }
    }

    return chips
  }, [visibleProviders])

  const platformSelSet = useMemo(() => new Set(platformSel.map(routedKey)), [platformSel])
  const selectedCount = byoSel ? 1 : platformSel.length
  const byoDisabled = platformSel.length >= 2

  const auxDraftProviderModels = useMemo(
    () => providers.find(provider => provider.slug === auxDraft.provider)?.models ?? [],
    [auxDraft.provider, providers]
  )

  const auxiliaryTaskLabel = useCallback((key: string) => m.tasks[key]?.label ?? key, [m.tasks])

  // Persistent mismatch: any aux slot pinned to a provider different from the
  // current main, regardless of whether the user just switched. Catches the
  // "I pinned aux months ago and forgot, now it bills a dead provider" case.
  const persistentStaleAux = useMemo<StaleAuxAssignment[]>(() => {
    const mainProvider = (mainModel?.provider ?? '').toLowerCase()

    if (!mainProvider || !auxiliary) {
      return []
    }

    return auxiliary.tasks
      .filter(entry => {
        const p = (entry.provider ?? '').toLowerCase()

        return p && p !== 'auto' && p !== mainProvider
      })
      .map(entry => ({ task: entry.task, provider: entry.provider, model: entry.model }))
  }, [auxiliary, mainModel])

  // Capabilities of the APPLIED main model — gates the profile-default
  // reasoning/speed controls the same way the composer picker gates per-model
  // edits (reasoning defaults on, fast defaults off when unreported).
  const mainCaps = useMemo(() => {
    const row = providers.find(provider => provider.slug === mainModel?.provider)

    return mainModel ? row?.capabilities?.[mainModel.model] : undefined
  }, [providers, mainModel])

  const reasoningSupported = mainCaps?.reasoning ?? true
  const fastSupported = mainCaps?.fast ?? false
  const effortValue = String(getNested(config ?? {}, 'agent.reasoning_effort') ?? '').trim().toLowerCase() || 'medium'
  const fastOn = isFastTier(getNested(config ?? {}, 'agent.service_tier'))

  // Persist a single agent.* default by round-tripping the whole config record
  // (PUT /api/config replaces it) — optimistic, with rollback on failure.
  const writeAgentDefault = useCallback(
    async (key: string, value: string) => {
      if (!config) {
        return
      }

      const prev = config
      const next = setNested(config, key, value)
      setConfig(next)

      try {
        await saveHermesConfig(next)
      } catch (err) {
        setConfig(prev)
        notifyError(err, m.defaultsFailed)
      }
    },
    [config, m.defaultsFailed]
  )

  const applyMain = useCallback(
    async (provider: string, model: string) => {
      const result = await setModelAssignment({ model, provider, scope: 'main' })
      const nextProvider = result.provider || provider
      const nextModel = result.model || model
      setMainModel({ provider: nextProvider, model: nextModel })
      setSwitchStaleAux(result.stale_aux ?? [])
      onMainModelChanged?.(nextProvider, nextModel)
    },
    [onMainModelChanged]
  )

  // Apply a selection snapshot to config. <=1 model keeps the plain single-model
  // path (setModelAssignment scope:main) UNCHANGED (regression red line); 2+
  // platform models compose the hidden `__auto__` MoA preset (references = S\{A},
  // ranked aggregator, fanout:user_turn) and activate provider=moa/model=__auto__.
  const doApply = useCallback(
    async (snapshot: { byo: MoaModelSlot | null; platform: MoaModelSlot[] }) => {
      if (snapshot.byo) {
        await applyMain(snapshot.byo.provider, snapshot.byo.model)

        return
      }

      if (snapshot.platform.length === 0) {
        return
      }

      if (snapshot.platform.length === 1) {
        await applyMain(snapshot.platform[0].provider, snapshot.platform[0].model)

        return
      }

      const composed = composeAutoMoa(snapshot.platform)

      if (!composed) {
        return
      }

      const saved = await saveMoaModels(buildAutoMoaConfig(moaRef.current, composed))
      setMoa(saved)
      await applyMain('moa', AUTO_PRESET_NAME)
    },
    [applyMain]
  )

  // Auto-apply on every toggle (mockup: "选 2+ 自动生效", no confirm dialog).
  // Serialized through a promise chain so a rapid burst of toggles lands the
  // final selection without overlapping writes.
  const applyQueueRef = useRef<Promise<void>>(Promise.resolve())

  const runApply = useCallback(
    (snapshot: { byo: MoaModelSlot | null; platform: MoaModelSlot[] }) => {
      applyQueueRef.current = applyQueueRef.current.then(async () => {
        setApplying(true)
        setError('')

        try {
          await doApply(snapshot)
        } catch (err) {
          console.error('[model-settings] request failed', err)
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setApplying(false)
        }
      })
    },
    [doApply]
  )

  const togglePlatform = useCallback(
    (chip: ModelChip) => {
      const key = routedKey(chip.raw)
      const has = platformSel.some(raw => routedKey(raw) === key)
      const nextRaw = has ? platformSel.filter(raw => routedKey(raw) !== key) : [...platformSel, chip.raw]
      // Keep directory order so the composed aggregator/reference split is stable.
      const order = new Map(platformChips.map((c, i) => [routedKey(c.raw), i]))
      nextRaw.sort((a, b) => (order.get(routedKey(a)) ?? 0) - (order.get(routedKey(b)) ?? 0))

      setByoSel(null)
      setPlatformSel(nextRaw)

      const slots = platformChips
        .filter(c => nextRaw.some(raw => routedKey(raw) === routedKey(c.raw)))
        .map(c => ({ provider: c.provider, model: c.raw }))

      runApply({ byo: null, platform: slots })
    },
    [platformChips, platformSel, runApply]
  )

  const selectByo = useCallback(
    (chip: ModelChip) => {
      if (byoDisabled) {
        return
      }

      const already = byoSel?.provider === chip.provider && byoSel?.model === chip.raw
      const next = already ? byoSel : { provider: chip.provider, model: chip.raw }
      setPlatformSel([])
      setByoSel(next)

      if (!already) {
        runApply({ byo: next, platform: [] })
      }
    },
    [byoDisabled, byoSel, runApply]
  )

  const setAuxiliaryToMain = useCallback(
    async (task: string) => {
      if (!mainModel) {
        return
      }

      setApplying(true)
      setError('')

      try {
        await setModelAssignment({ model: mainModel.model, provider: mainModel.provider, scope: 'auxiliary', task })
        await refresh()
      } catch (err) {
        console.error('[model-settings] request failed', err)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setApplying(false)
      }
    },
    [mainModel, refresh]
  )

  const applyAuxiliaryDraft = useCallback(
    async (task: string) => {
      if (!auxDraft.provider || !auxDraft.model) {
        return
      }

      setApplying(true)
      setError('')

      try {
        await setModelAssignment({ model: auxDraft.model, provider: auxDraft.provider, scope: 'auxiliary', task })
        setEditingAuxTask(null)
        await refresh()
      } catch (err) {
        console.error('[model-settings] request failed', err)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setApplying(false)
      }
    },
    [auxDraft, refresh]
  )

  const beginAuxiliaryEdit = useCallback(
    (task: string) => {
      const current = auxiliary?.tasks.find(entry => entry.task === task)

      const initialProvider =
        current?.provider && current.provider !== 'auto' ? current.provider : (mainModel?.provider ?? '')

      const initialModel = current?.model || mainModel?.model || ''
      setAuxDraft({ provider: initialProvider, model: initialModel })
      setEditingAuxTask(task)
    },
    [auxiliary, mainModel]
  )

  const resetAuxiliaryModels = useCallback(async () => {
    if (!mainModel) {
      return
    }

    setApplying(true)
    setError('')

    try {
      await setModelAssignment({
        model: mainModel.model,
        provider: mainModel.provider,
        scope: 'auxiliary',
        task: '__reset__'
      })
      setSwitchStaleAux([])
      await refresh()
    } catch (err) {
      console.error('[model-settings] request failed', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }, [mainModel, refresh])

  if (loading && !mainModel) {
    return <LoadingState label={m.loading} />
  }

  const hasAnyModel = platformChips.length > 0 || byoChips.length > 0

  return (
    <div className="grid gap-6">
      <section>
        <p className="p5-section-intro mb-3.5">{m.appliesDesc}</p>

        {!hasAnyModel ? (
          <p className="text-xs text-muted-foreground">{m.noModels}</p>
        ) : (
          <>
            {platformChips.length > 0 && (
              <div className="mb-4">
                <div className="mb-1 text-xs font-medium text-foreground">{m.selectTitle}</div>
                <p className="mb-2.5 text-xs text-muted-foreground">{m.selectHint}</p>
                <div className="flex flex-wrap gap-2">
                  {platformChips.map(chip => (
                    <ChipButton
                      active={platformSelSet.has(routedKey(chip.raw))}
                      key={chip.raw}
                      label={chip.label}
                      onClick={() => togglePlatform(chip)}
                    />
                  ))}
                </div>
                {selectedCount >= 2 && (
                  <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground">
                    {m.selectedSummary(selectedCount)}
                  </div>
                )}
              </div>
            )}

            {byoChips.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium text-foreground">{m.byoTitle}</div>
                <p className="mb-2.5 text-xs text-muted-foreground">{byoDisabled ? m.byoMixNote : m.byoHint}</p>
                <div className="flex flex-wrap gap-2">
                  {byoChips.map(chip => (
                    <ChipButton
                      active={!byoDisabled && byoSel?.provider === chip.provider && byoSel?.model === chip.raw}
                      disabled={byoDisabled}
                      key={`${chip.provider}:${chip.raw}`}
                      label={chip.label}
                      onClick={() => selectByo(chip)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {config && mainModel && (reasoningSupported || fastSupported) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className="text-xs text-muted-foreground">{m.defaultsLabel}</span>
            {reasoningSupported && (
              <div className="flex items-center gap-2 text-xs">
                {m.reasoning}
                <Select onValueChange={value => void writeAgentDefault('agent.reasoning_effort', value)} value={effortValue}>
                  <SelectTrigger className={cn('min-w-28', CONTROL_TEXT)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EFFORT_VALUES.map(value => (
                      <SelectItem key={value} value={value}>
                        {value === 'none' ? m.reasoningOff : t.shell.modelOptions[effortLabelKey(value)]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {fastSupported && (
              <label className="flex items-center gap-2 text-xs">
                {t.shell.modelOptions.fast}
                <Switch
                  checked={fastOn}
                  onCheckedChange={checked => void writeAgentDefault('agent.service_tier', checked ? 'fast' : 'normal')}
                  size="xs"
                />
              </label>
            )}
          </div>
        )}
        {error && <div className="mt-2 text-xs text-destructive">{m.requestFailed}</div>}
        {switchStaleAux.length > 0 && (
          <div className="mt-2">
            <StaleAuxWarning
              applying={applying}
              onReset={() => void resetAuxiliaryModels()}
              slots={switchStaleAux}
              taskLabel={auxiliaryTaskLabel}
            />
          </div>
        )}
      </section>

      <section>
        <div className="mb-2.5 flex items-center justify-between">
          <SectionHeading icon={Cpu} title={m.auxiliaryTitle} />
          <Button
            disabled={!mainModel || applying}
            onClick={() => void resetAuxiliaryModels()}
            size="sm"
            variant="textStrong"
          >
            {m.resetAllToMain}
          </Button>
        </div>
        <p className="p5-section-intro mb-3">{m.auxiliaryDesc}</p>
        {switchStaleAux.length === 0 && persistentStaleAux.length > 0 && (
          <div className="mb-2.5">
            <StaleAuxWarning
              applying={applying}
              onReset={() => void resetAuxiliaryModels()}
              slots={persistentStaleAux}
              taskLabel={auxiliaryTaskLabel}
            />
          </div>
        )}
        <div className="p5-card p5-rows">
          {AUX_TASKS.map(meta => {
            const copy = m.tasks[meta.key] ?? { label: meta.key, hint: meta.key }
            const current = auxiliary?.tasks.find(entry => entry.task === meta.key)
            const isAuto = !current || !current.provider || current.provider === 'auto'
            const isEditing = editingAuxTask === meta.key

            return (
              <ListRow
                action={
                  !isEditing && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        disabled={!mainModel || applying}
                        onClick={() => void setAuxiliaryToMain(meta.key)}
                        size="sm"
                        variant="text"
                      >
                        {m.setToMain}
                      </Button>
                      <Button
                        disabled={!providers.length || applying}
                        onClick={() => beginAuxiliaryEdit(meta.key)}
                        size="sm"
                        variant="textStrong"
                      >
                        {m.change}
                      </Button>
                    </div>
                  )
                }
                below={
                  isEditing && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 pt-1">
                      <Select
                        onValueChange={value => setAuxDraft(prev => ({ ...prev, provider: value, model: '' }))}
                        value={auxDraft.provider}
                      >
                        <SelectTrigger className={cn('min-w-32', CONTROL_TEXT)}>
                          <SelectValue placeholder={m.provider} />
                        </SelectTrigger>
                        <SelectContent>
                          {providerOptions.map(provider => (
                            <SelectItem key={provider.slug || 'none'} value={provider.slug || 'none'}>
                              {provider.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        onValueChange={value => setAuxDraft(prev => ({ ...prev, model: value }))}
                        value={auxDraft.model}
                      >
                        <SelectTrigger className={cn('min-w-48', CONTROL_TEXT)}>
                          <SelectValue placeholder={m.model} />
                        </SelectTrigger>
                        <SelectContent>
                          {(auxDraftProviderModels.length ? auxDraftProviderModels : []).map(model => (
                            <SelectItem key={model} value={model}>
                              {model}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        disabled={!auxDraft.provider || !auxDraft.model || applying}
                        onClick={() => void applyAuxiliaryDraft(meta.key)}
                        size="sm"
                      >
                        {applying ? m.applying : t.common.apply}
                      </Button>
                      <Button onClick={() => setEditingAuxTask(null)} size="sm" variant="ghost">
                        {t.common.cancel}
                      </Button>
                    </div>
                  )
                }
                description={
                  <span className="font-mono text-[0.68rem]">
                    {isAuto
                      ? m.autoUseMain
                      : `${current.provider} · ${current.model || m.providerDefault}`}
                  </span>
                }
                key={meta.key}
                title={
                  <span className="flex items-baseline gap-2">
                    {copy.label}
                    <Pill>{copy.hint}</Pill>
                  </span>
                }
              />
            )
          })}
        </div>
      </section>
    </div>
  )
}
