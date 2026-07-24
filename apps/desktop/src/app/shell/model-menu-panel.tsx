import { useStore } from '@nanostores/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  dropdownMenuRow,
  DropdownMenuSearch,
  dropdownMenuSectionLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { getMoaModels, type HermesGateway, saveMoaModels, setModelAssignment } from '@/hermes'
import { useI18n } from '@/i18n'
import { ChevronDown, ChevronRight } from '@/lib/icons'
import {
  AUTO_PRESET_NAME,
  buildAutoMoaConfig,
  composeAutoMoa,
  composedMemberCount,
  expandMoaPresetMembers,
  routedKey,
  SHOW_EXPLICIT_MOA_UI
} from '@/lib/moa-compose'
import { requestModelOptions } from '@/lib/model-options'
import {
  currentPickerSelection,
  displayModelName,
  modelDisplayParts,
  reasoningEffortLabel
} from '@/lib/model-status-label'
import { filterPickerProviders, isManagedProviderSlug } from '@/lib/provider-allowlist'
import { normalize } from '@/lib/text'
import { cn } from '@/lib/utils'
import { $modelPresets, applyModelPreset, modelPresetKey } from '@/store/model-presets'
import {
  $visibleModels,
  collapseModelFamilies,
  DEFAULT_VISIBLE_PER_PROVIDER,
  effectiveVisibleKeys,
  type ModelFamily,
  modelVisibilityKey,
  setModelVisibilityOpen
} from '@/store/model-visibility'
import { notifyError } from '@/store/notifications'
import { $collapsedProviders, toggleCollapsedProvider } from '@/store/provider-collapse'
import type { MoaConfigResponse, MoaModelSlot, ModelOptionProvider, ModelOptionsResponse } from '@/types/hermes'

import { ModelEditSubmenu, resolveFastControl } from './model-edit-submenu'

// Lets the host dropdown (model-pill) hand the panel a way to dismiss itself so
// clicking a model row commits + closes, while the hover-revealed edit submenu
// (reasoning/fast) stays open to play with (its items preventDefault on select).
export const ModelMenuCloseContext = createContext<() => void>(() => {})

export interface ModelSelection {
  model: string
  provider: string
  /** Runtime id of the surface that opened the menu. When set, the switch
   *  targets that session (a tile) instead of the primary `$activeSessionId`. */
  sessionId?: null | string
}

interface ModelMenuPanelProps {
  gateway?: HermesGateway
  onSelectModel: (selection: ModelSelection) => Promise<boolean> | void
  requestGateway: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}

interface ProviderGroup {
  families: ModelFamily[]
  provider: ModelOptionProvider
}

export function ModelMenuPanel({ gateway, onSelectModel, requestGateway }: ModelMenuPanelProps) {
  const { t } = useI18n()
  const copy = t.shell.modelMenu
  const closeMenu = useContext(ModelMenuCloseContext)
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  // hc-578 (MOA-INVISIBLE-DESIGN): the platform (managed-relay) provider's rows
  // MULTI-select. Raw model ids in directory order; BYO providers stay
  // single-select and don't mix with this (§9).
  const [platformSel, setPlatformSel] = useState<string[]>([])
  const queryClient = useQueryClient()
  // Bind to THIS surface's SessionView (primary or tile) so each pane's menu
  // shows/switches its own model — not the primary-only globals.
  const view = useSessionView()
  const activeSessionId = useStore(view.$runtimeId)
  const currentFastMode = useStore(view.$fast)
  const currentModel = useStore(view.$model)
  const currentProvider = useStore(view.$provider)
  const currentReasoningEffort = useStore(view.$reasoningEffort)
  const modelPresets = useStore($modelPresets)
  const visibleModels = useStore($visibleModels)
  const collapsedProviders = useStore($collapsedProviders)

  const modelOptions = useQuery({
    queryKey: ['model-options', activeSessionId || 'global'],
    // Gateway-first even with no session yet: a connected (possibly remote)
    // gateway owns the model catalog, including virtual providers like `moa`
    // that the local REST fallback can't know about (#53817).
    queryFn: (): Promise<ModelOptionsResponse> => requestModelOptions({ gateway, sessionId: activeSessionId })
  })

  // Also the source of "what is currently multi-selected" (expandMoaPresetMembers
  // below). `.catch` keeps a never-configured profile (no moa.json yet) from
  // parking this query in an error state.
  const moaOptions = useQuery({
    queryKey: ['moa-presets'],
    queryFn: (): Promise<MoaConfigResponse | null> => getMoaModels().catch(() => null)
  })

  const { model: optionsModel, provider: optionsProvider } = currentPickerSelection(
    !!activeSessionId,
    { model: currentModel, provider: currentProvider },
    modelOptions.data
  )

  const loading = modelOptions.isPending && !modelOptions.data

  const error = modelOptions.error
    ? modelOptions.error instanceof Error
      ? modelOptions.error.message
      : String(modelOptions.error)
    : null

  // China-first: only the APEX-NODES.COM managed relay (+ custom BYOK endpoints)
  // and domestic providers are shown; foreign providers are hidden even when
  // configured (see filterPickerProviders).
  const providers = useMemo(
    () => (modelOptions.data?.providers ? filterPickerProviders(modelOptions.data.providers) : undefined),
    [modelOptions.data?.providers]
  )

  // The catalog carries MoA presets as a virtual `moa` provider row, which
  // upstream lists by name in its own section below. MOA-INVISIBLE-DESIGN
  // forbids that vocabulary, so the list is held empty (the allowlist already
  // drops the `moa` row) and upstream's section never renders — the composer's
  // multi-select composes the same thing silently instead. `__auto__` is
  // filtered out for the same reason: naming the reserved preset would leak the
  // mechanism the design exists to hide.
  const moaPresets = useMemo(() => {
    if (!SHOW_EXPLICIT_MOA_UI) {
      return []
    }

    return (providers?.find(provider => provider.slug.toLowerCase() === 'moa')?.models ?? []).filter(
      preset => preset !== AUTO_PRESET_NAME
    )
  }, [providers])

  // The ApexNodes managed relay — the only provider whose rows multi-select.
  const managedProvider = useMemo(
    () => (providers ?? []).find(provider => isManagedProviderSlug(provider.slug, provider.name)) ?? null,
    [providers]
  )

  const platformSelSet = useMemo(() => new Set(platformSel.map(routedKey)), [platformSel])

  // Reconstruct "what is currently multi-selected" from whatever is actually
  // active: an active provider === 'moa' preset expands back to its member set,
  // a single managed pick seeds a 1-element array, anything else (BYO / none)
  // clears it. Runs on every fresh mount (this panel remounts each time the
  // dropdown opens) and whenever the active selection or MoA config changes.
  useEffect(() => {
    if (optionsProvider === 'moa') {
      setPlatformSel(expandMoaPresetMembers(moaOptions.data, optionsModel, managedProvider?.models ?? []))

      return
    }

    // Compare against the resolved managed row's own slug, not a fuzzy name
    // check — optionsProvider is a bare slug here.
    if (optionsModel && managedProvider && optionsProvider === managedProvider.slug) {
      setPlatformSel([optionsModel])

      return
    }

    setPlatformSel([])
  }, [optionsProvider, optionsModel, moaOptions.data, managedProvider])

  const pickerProviders = useMemo(
    () => providers?.filter(provider => provider.slug.toLowerCase() !== 'moa') ?? [],
    [providers]
  )

  const effectiveVisibleModels = useMemo(
    () => effectiveVisibleKeys(visibleModels, pickerProviders),
    [visibleModels, pickerProviders]
  )

  // The composer picker never persists the profile default. With a session it
  // scopes the switch to that session; with none it's UI state shipped on the
  // next session.create (see selectModel). The default lives in Settings → Model.
  // Always stamp sessionId from this surface so a tile switch never hits the
  // primary (busy) session by accident.
  const switchTo = (model: string, provider: string) =>
    onSelectModel({ model, provider, sessionId: activeSessionId || null })

  // Explicit "Refresh Models": re-fetch the catalog with refresh:true so the
  // backend busts its 1h provider-model disk cache and re-pulls each provider's
  // live list. Fixes live-only models (e.g. OpenCode Zen free tier) vanishing
  // when the cache expires and falls back to the curated static list.
  const refreshModels = async () => {
    if (refreshing) {
      return
    }

    setRefreshing(true)

    try {
      const queryKey = ['model-options', activeSessionId || 'global']

      const next = await requestModelOptions({ gateway, refresh: true, sessionId: activeSessionId })

      queryClient.setQueryData<ModelOptionsResponse>(queryKey, next)
    } catch {
      // Network/backend hiccup — fall back to a plain invalidate so the next
      // open re-fetches (still cached, but no worse than before).
      void queryClient.invalidateQueries({ queryKey: ['model-options'] })
    } finally {
      setRefreshing(false)
    }
  }

  // Selecting a model row restores that model's remembered preset onto the
  // session (effort/fast), gated by capability. Unset → Hermes defaults.
  const selectFamily = async (family: ModelFamily, provider: ModelOptionProvider) => {
    const caps = provider.capabilities?.[family.id]
    const preset = modelPresets[modelPresetKey(provider.slug, family.id)] ?? {}

    // Variant-fast models (no speed param) express "fast" as a separate `-fast`
    // id, so honor the saved preset by selecting that sibling. Param-fast is
    // applied via applyModelPreset below instead.
    const variantFast = !(caps?.fast ?? false) && !!family.fastId
    const targetId = variantFast && preset.fast === true ? family.fastId! : family.id

    if ((await switchTo(targetId, provider.slug)) === false) {
      return
    }

    await applyModelPreset(
      {
        effort: (caps?.reasoning ?? true) ? (preset.effort ?? 'medium') : undefined,
        fast: (caps?.fast ?? false) ? (preset.fast ?? false) : undefined
      },
      {
        failMessage: t.shell.modelOptions.updateFailed,
        primary: view.kind === 'primary',
        request: requestGateway,
        sessionId: activeSessionId
      }
    )
  }

  // hc-578 (MOA-INVISIBLE-DESIGN): toggle a managed-relay row in/out of the
  // platform multi-selection. The picker never shows "MoA" — just checked model
  // rows. <= 1 selected keeps the plain single-select path verbatim
  // (selectFamily → onSelectModel, session-scoped — the regression red line,
  // never touches the profile default); >= 2 composes the hidden `__auto__`
  // preset and activates it. `fanout` is pinned to user_turn by composeAutoMoa,
  // which is the billing red line (§2.2/§7).
  const togglePlatformModel = async (family: ModelFamily, provider: ModelOptionProvider) => {
    const key = routedKey(family.id)
    const has = platformSel.some(id => routedKey(id) === key)
    const nextIds = has ? platformSel.filter(id => routedKey(id) !== key) : [...platformSel, family.id]

    // Keep directory order stable so the composed aggregator/reference split
    // never depends on click order.
    const directory = collapseModelFamilies(provider.models ?? [])
    const order = new Map(directory.map((f, index) => [routedKey(f.id), index]))
    nextIds.sort((a, b) => (order.get(routedKey(a)) ?? 0) - (order.get(routedKey(b)) ?? 0))

    const prevSel = platformSel
    setPlatformSel(nextIds)

    // Deselecting the last platform model is a no-op — a main model can't be
    // "none", so the previous selection stays active until another is picked.
    if (nextIds.length === 0) {
      return
    }

    if (nextIds.length === 1) {
      const sole = directory.find(f => routedKey(f.id) === routedKey(nextIds[0]))

      if (sole) {
        await selectFamily(sole, provider)
      }

      return
    }

    const composed = composeAutoMoa(nextIds.map((id): MoaModelSlot => ({ provider: provider.slug, model: id })))

    if (!composed) {
      return
    }

    try {
      const saved = await saveMoaModels(buildAutoMoaConfig(moaOptions.data ?? null, composed))
      queryClient.setQueryData(['moa-presets'], saved)
      await setModelAssignment({ model: AUTO_PRESET_NAME, provider: 'moa', scope: 'main' })
      void queryClient.invalidateQueries({ queryKey: ['model-options'] })
    } catch (err) {
      setPlatformSel(prevSel)
      notifyError(err, t.shell.modelOptions.updateFailed)
    }
  }

  // Selecting a MoA preset switches the session to it PERSISTENTLY, using the
  // same path real provider selections use (onSelectModel → config.set with
  // --session for live sessions → the gateway's persistent switch_model).
  // Previously this dispatched the one-shot `/moa` command, which ran a single
  // turn through MoA and then silently reverted to the prior model (#54670) —
  // the dropdown presented presets like persistent selections but they weren't.
  // No session gate: like regular model rows, a pre-session pick is UI state
  // shipped on the next session.create.
  const selectMoaPreset = async (preset: string) => {
    if ((await switchTo(preset, 'moa')) === false) {
      return
    }

    closeMenu()
  }

  const groups = useMemo(
    () =>
      groupModels(pickerProviders, search, { model: optionsModel, provider: optionsProvider }, effectiveVisibleModels),
    [pickerProviders, search, optionsModel, optionsProvider, effectiveVisibleModels]
  )

  return (
    <>
      <DropdownMenuSearch aria-label={copy.search} onValueChange={setSearch} placeholder={copy.search} value={search} />

      <DropdownMenuSeparator className="mx-0" />

      {loading ? (
        <DropdownMenuGroup className="py-1">
          {Array.from({ length: 4 }, (_, index) => (
            <DropdownMenuItem
              className={dropdownMenuRow}
              disabled
              key={index}
              onSelect={event => event.preventDefault()}
            >
              <Skeleton className="h-4 w-full" />
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      ) : error ? (
        <DropdownMenuItem className={dropdownMenuRow} disabled>
          {error}
        </DropdownMenuItem>
      ) : groups.length === 0 && moaPresets.length === 0 ? (
        <DropdownMenuItem className={dropdownMenuRow} disabled>
          {copy.noModels}
        </DropdownMenuItem>
      ) : (
        <div className="max-h-[max(150px,30dvh)] overflow-y-auto py-0.5">
          {groups.map(group => {
            const slug = group.provider.slug

            // Collapsed when stored + no active search + not the current provider.
            const collapsed = collapsedProviders.includes(slug) && !search && slug !== optionsProvider

            return (
              <DropdownMenuGroup className="py-0.5" key={slug}>
                <DropdownMenuItem
                  className={cn(dropdownMenuSectionLabel, 'cursor-pointer hover:bg-(--ui-control-active-background)')}
                  onSelect={event => {
                    event.preventDefault()
                    toggleCollapsedProvider(slug)
                  }}
                  textValue=""
                >
                  {collapsed ? (
                    <ChevronRight className="size-2.5 shrink-0" />
                  ) : (
                    <ChevronDown className="size-2.5 shrink-0" />
                  )}
                  {group.provider.name}
                </DropdownMenuItem>
                {!collapsed &&
                  group.families.map(family => {
                    // The active id may be the base or its -fast sibling; either
                    // way this one family row represents both.
                    const activeId =
                      group.provider.slug === optionsProvider &&
                      (optionsModel === family.id || optionsModel === family.fastId)
                        ? optionsModel
                        : null

                    // Is this row the LIVE model (drives effort/fast display and
                    // the edit submenu's active state)? A composed multi-model
                    // selection has no single live model, so this stays false.
                    const isCurrent = activeId !== null
                    // hc-578: on the managed relay the rows MULTI-select, so the
                    // check mark tracks set membership instead.
                    const multiSelect = managedProvider !== null && group.provider.slug === managedProvider.slug
                    const isChecked = multiSelect ? platformSelSet.has(routedKey(family.id)) : isCurrent
                    const name = modelDisplayParts(family.id).name
                    // Capabilities are looked up against the active/base id; the
                    // -fast variant carries the same param support as its base.
                    const caps = group.provider.capabilities?.[family.id]

                    // Effective settings for this row: live session state when it's
                    // the active model, otherwise its remembered preset (Hermes
                    // defaults when unset). Row label AND submenu read from these so
                    // they never disagree.
                    const preset = modelPresets[modelPresetKey(group.provider.slug, family.id)] ?? {}
                    const effEffort = isCurrent ? currentReasoningEffort : (preset.effort ?? '')
                    const effFast = isCurrent ? currentFastMode : (preset.fast ?? false)

                    const fastControl = resolveFastControl(
                      activeId ?? family.id,
                      group.provider.models ?? [],
                      caps?.fast ?? false,
                      effFast
                    )

                    const meta = [
                      fastControl.kind !== 'none' && fastControl.on ? copy.fast : null,
                      (caps?.reasoning ?? true) ? reasoningEffortLabel(effEffort) || copy.medium : null
                    ]
                      .filter(Boolean)
                      .join(' ')

                    // Every row is a hover-Edit submenu trigger. Activating it
                    // (pointer or keyboard) switches to the family's base model and
                    // restores its preset; the Fast toggle inside swaps to the -fast
                    // sibling (or flips the speed param). The sub-trigger has no
                    // `onSelect`, so wire both click and Enter/Space for keyboard parity.
                    // Clicking the row commits the model and closes the picker; the
                    // edit submenu (reasoning/fast) is reached by HOVER, so you can
                    // still tweak those without the click dismissing everything.
                    // On the managed relay a click TOGGLES membership and keeps
                    // the menu open (you are building a set), so the composed
                    // selection can be assembled without reopening the picker.
                    const activate = () => {
                      if (multiSelect) {
                        void togglePlatformModel(family, group.provider)

                        return
                      }

                      if (!isCurrent) {
                        void selectFamily(family, group.provider)
                      }

                      closeMenu()
                    }

                    return (
                      <DropdownMenuSub key={`${group.provider.slug}:${family.id}`}>
                        <DropdownMenuSubTrigger
                          className={dropdownMenuRow}
                          hideChevron
                          onClick={activate}
                          onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              activate()
                            }
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {name}
                            {meta ? <span className="text-(--ui-text-tertiary)"> {meta}</span> : null}
                          </span>
                          {isChecked ? (
                            <Codicon className="ml-auto text-foreground" name="check" size="0.75rem" />
                          ) : null}
                        </DropdownMenuSubTrigger>
                        <ModelEditSubmenu
                          effort={effEffort}
                          fastControl={fastControl}
                          isActive={isCurrent}
                          model={family.id}
                          onSelectModel={nextModel => switchTo(nextModel, group.provider.slug)}
                          provider={group.provider.slug}
                          reasoning={caps?.reasoning ?? true}
                          requestGateway={requestGateway}
                        />
                      </DropdownMenuSub>
                    )
                  })}
              </DropdownMenuGroup>
            )
          })}
        </div>
      )}

      <DropdownMenuSeparator className="mx-0" />

      {moaPresets.length > 0 ? (
        <>
          <DropdownMenuLabel className={dropdownMenuSectionLabel}>MoA presets</DropdownMenuLabel>
          {moaPresets.map(preset => {
            const isCurrentMoa = optionsProvider === 'moa' && optionsModel === preset

            return (
              <DropdownMenuItem
                className={dropdownMenuRow}
                key={`moa:${preset}`}
                onSelect={event => {
                  event.preventDefault()
                  void selectMoaPreset(preset)
                }}
              >
                <span className="min-w-0 flex-1 truncate">MoA: {preset}</span>
                {isCurrentMoa ? <Codicon className="ml-auto text-foreground" name="check" size="0.75rem" /> : null}
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator className="mx-0" />
        </>
      ) : null}

      <DropdownMenuItem
        className={cn(dropdownMenuRow, 'text-(--ui-text-tertiary)')}
        disabled={refreshing}
        onSelect={event => {
          event.preventDefault()
          void refreshModels()
        }}
      >
        <Codicon className={cn(refreshing && 'animate-spin')} name="sync" size="0.75rem" />
        {copy.refreshModels}
      </DropdownMenuItem>

      <DropdownMenuItem
        className={cn(dropdownMenuRow, 'text-(--ui-text-tertiary)')}
        onSelect={() => setModelVisibilityOpen(true)}
      >
        <Codicon name="settings-gear" size="0.75rem" />
        {copy.editModels}
      </DropdownMenuItem>
    </>
  )
}

// Collapsed we show the user's chosen models (or the curated default); typing
// spans every available model so anything is reachable past the cut. A search
// is itself a narrowing action, so we do NOT cap per-provider matches — a
// provider serving 19 models (e.g. opencode-go) must show all 19 when the user
// searches for it, not a truncated subset. (#47077 follow-up)

function groupModels(
  providers: ModelOptionProvider[],
  search: string,
  current: { model: string; provider: string },
  visible: Set<string> | null
): ProviderGroup[] {
  const q = normalize(search)
  const groups: ProviderGroup[] = []

  for (const provider of providers) {
    const allFamilies = collapseModelFamilies(provider.models ?? [])

    if (allFamilies.length === 0) {
      continue
    }

    const matches = (family: ModelFamily) =>
      `${family.id} ${family.fastId ?? ''} ${provider.name} ${provider.slug} ${displayModelName(family.id)}`
        .toLowerCase()
        .includes(q)

    // Which model ids to show (the active one is always added on top of this).
    let shown: Set<string>

    if (q) {
      // Search spans every family, regardless of visibility.
      shown = new Set(allFamilies.filter(matches).map(family => family.id))
    } else if (visible) {
      // User has customized which models show — honor their selection exactly.
      shown = new Set(
        allFamilies.filter(family => visible.has(modelVisibilityKey(provider.slug, family.id))).map(family => family.id)
      )
    } else {
      // Default: curated top-N families per provider.
      shown = new Set(allFamilies.slice(0, DEFAULT_VISIBLE_PER_PROVIDER).map(family => family.id))
    }

    // Always include the active model — but keep every row in the provider's
    // stable curated order (filter `allFamilies`, never reorder), so selecting
    // a model can't shuffle the list.
    const activeId =
      provider.slug === current.provider && current.model
        ? allFamilies.find(family => family.id === current.model || family.fastId === current.model)?.id
        : undefined

    const families = allFamilies.filter(family => shown.has(family.id) || family.id === activeId)

    if (families.length > 0) {
      groups.push({ families, provider })
    }
  }

  // Stable, logical group order: alphabetical by provider name. (The backend
  // floats the current provider first, which would reshuffle on every switch.)
  groups.sort((a, b) => a.provider.name.localeCompare(b.provider.name))

  return groups
}
