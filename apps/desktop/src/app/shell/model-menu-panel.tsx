import { useStore } from '@nanostores/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'

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
import { ProviderIcon } from '@/components/ui/provider-icon'
import { Skeleton } from '@/components/ui/skeleton'
import { getMoaModels, type HermesGateway, saveMoaModels, setModelAssignment } from '@/hermes'
import { useI18n } from '@/i18n'
import { ChevronDown, ChevronRight } from '@/lib/icons'
import {
  AUTO_PRESET_NAME,
  buildAutoMoaConfig,
  composeAutoMoa,
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
import { modelVendor } from '@/lib/model-vendor'
import { filterPickerProviders, isManagedProviderSlug, providerDisplayName } from '@/lib/provider-allowlist'
import { nearestSupportedEffort, supportedReasoningEfforts } from '@/lib/reasoning-efforts'
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

  // hc-599: the multi-selection is USER INTENT, and this ref is the copy the
  // async write path reads. React state alone is not enough — a burst of clicks
  // shares one stale render closure, so the third click would compute its set
  // from the first click's array and silently drop the second model.
  const selectionRef = useRef<string[]>(platformSel)
  // Seeded once from the server, then owned by the user until the menu is
  // reopened (this panel remounts on every open). See the effect below.
  const selectionSeededRef = useRef(false)

  const setSelection = (next: string[]) => {
    selectionRef.current = next
    setPlatformSel(next)
  }

  // SEED "what is currently multi-selected" from whatever is actually active:
  // an active provider === 'moa' preset expands back to its member set, a
  // single managed pick seeds a 1-element array, anything else (BYO / none)
  // leaves it empty.
  //
  // hc-599: this used to re-run as a mirror — on every change to the catalog,
  // the saved MoA config or the active selection. Every click changes all
  // three (saveMoaModels → setQueryData(['moa-presets']) → setModelAssignment →
  // invalidate ['model-options']), so a click landed the effect back on the
  // user with a SERVER snapshot taken mid-write and overwrote the checkmarks
  // they had just set — the "selecting a third model unchecks the second"
  // report. It cannot be repaired by ordering alone either: with a live agent
  // the gateway answers `model.options` from the AGENT's provider/model
  // (tui_gateway/server.py `model.options` → `with_overrides`), which is a
  // single id, while the composed selection lives in the profile's `__auto__`
  // preset — so the mirror is structurally incapable of expressing a
  // multi-selection and collapses it every time it runs.
  //
  // So it seeds instead of mirrors: once the catalog and the saved presets have
  // both settled, and never after the user has touched the set. Writes are
  // serialized separately (flushSelection), which is what keeps the SERVER's
  // final state equal to the last intent.
  useEffect(() => {
    if (selectionSeededRef.current || !modelOptions.isSuccess || !moaOptions.isSuccess) {
      return
    }

    selectionSeededRef.current = true

    if (optionsProvider === 'moa') {
      setSelection(expandMoaPresetMembers(moaOptions.data, optionsModel, managedProvider?.models ?? []))

      return
    }

    // Compare against the resolved managed row's own slug, not a fuzzy name
    // check — optionsProvider is a bare slug here.
    if (optionsModel && managedProvider && optionsProvider === managedProvider.slug) {
      setSelection([optionsModel])

      return
    }

    setSelection([])
  }, [modelOptions.isSuccess, moaOptions.isSuccess, moaOptions.data, optionsProvider, optionsModel, managedProvider])

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

    // hc-598: a remembered effort the newly-selected model doesn't offer lands
    // on its closest level instead of travelling to the vendor as-is. The
    // stored preset keeps the user's original choice for models that honor it.
    const supportedEfforts = supportedReasoningEfforts(family.id, provider.name || provider.slug)

    await applyModelPreset(
      {
        effort:
          (caps?.reasoning ?? true) ? nearestSupportedEffort(preset.effort ?? 'medium', supportedEfforts) : undefined,
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

  // Order the selection the way the directory does, so the composed
  // aggregator/reference split never depends on click order.
  const inDirectoryOrder = (ids: string[], provider: ModelOptionProvider): string[] => {
    const order = new Map(collapseModelFamilies(provider.models ?? []).map((f, index) => [routedKey(f.id), index]))

    return [...ids].sort((a, b) => (order.get(routedKey(a)) ?? 0) - (order.get(routedKey(b)) ?? 0))
  }

  // hc-599: writes are SERIALIZED on this chain and each one persists the
  // selection as it stands when the chain reaches it. Two saves racing could
  // otherwise land out of order and leave the server holding an older subset
  // than the checkmarks show.
  const writeChainRef = useRef<Promise<void>>(Promise.resolve())
  // Toggles the server hasn't been told about yet. A write claims the whole
  // list, which is what coalesces a burst of clicks into ONE save — and is also
  // exactly the set to undo if that save fails.
  const unwrittenTogglesRef = useRef<{ added: boolean; model: string }[]>([])

  const undoToggle = ({ added, model }: { added: boolean; model: string }, provider: ModelOptionProvider) => {
    const key = routedKey(model)
    const live = selectionRef.current
    const present = live.some(id => routedKey(id) === key)

    if (added && present) {
      setSelection(live.filter(id => routedKey(id) !== key))
    } else if (!added && !present) {
      setSelection(inDirectoryOrder([...live, model], provider))
    }
  }

  const flushSelection = async (provider: ModelOptionProvider) => {
    const owned = unwrittenTogglesRef.current

    if (owned.length === 0) {
      // An earlier write in this burst already carried these clicks.
      return
    }

    unwrittenTogglesRef.current = []

    // Read through the ref, never this render's `platformSel`: a burst of
    // clicks shares one render closure, so the state copy is a snapshot from
    // before the later clicks and would persist a stale subset.
    const ids = selectionRef.current

    try {
      if (ids.length === 0) {
        // Deselecting the last platform model is a no-op — a main model can't
        // be "none", so the previous selection stays active until another is
        // picked.
        return
      }

      if (ids.length === 1) {
        const sole = collapseModelFamilies(provider.models ?? []).find(f => routedKey(f.id) === routedKey(ids[0]))

        if (sole) {
          await selectFamily(sole, provider)
        }

        return
      }

      const composed = composeAutoMoa(ids.map((id): MoaModelSlot => ({ provider: provider.slug, model: id })))

      if (!composed) {
        return
      }

      // Read the presets from the cache, not from this render's
      // `moaOptions.data` — a queued write runs after earlier ones updated it.
      const existing = queryClient.getQueryData<MoaConfigResponse>(['moa-presets']) ?? null
      const saved = await saveMoaModels(buildAutoMoaConfig(existing, composed))

      queryClient.setQueryData(['moa-presets'], saved)
      await setModelAssignment({ model: AUTO_PRESET_NAME, provider: 'moa', scope: 'main' })
      void queryClient.invalidateQueries({ queryKey: ['model-options'] })
    } catch (err) {
      // Undo the toggles THIS write carried, against the live selection —
      // never by restoring an array captured at click time, which would erase
      // every choice made while the failed write was in flight. Clicks that
      // arrived after this write claimed its batch are not ours to touch; the
      // next queued write persists them on top of the corrected set.
      for (const toggle of owned) {
        undoToggle(toggle, provider)
      }

      notifyError(err, t.shell.modelOptions.updateFailed)
    }
  }

  // hc-578 (MOA-INVISIBLE-DESIGN): toggle a managed-relay row in/out of the
  // platform multi-selection. The picker never shows "MoA" — just checked model
  // rows. <= 1 selected keeps the plain single-select path verbatim
  // (selectFamily → onSelectModel, session-scoped — the regression red line,
  // never touches the profile default); >= 2 composes the hidden `__auto__`
  // preset and activates it. `fanout` is pinned to user_turn by composeAutoMoa,
  // which is the billing red line (§2.2/§7).
  const togglePlatformModel = (family: ModelFamily, provider: ModelOptionProvider) => {
    // The user now owns the set — no server snapshot may seed over it.
    selectionSeededRef.current = true

    const key = routedKey(family.id)
    const current = selectionRef.current
    const added = !current.some(id => routedKey(id) === key)
    const nextIds = added ? [...current, family.id] : current.filter(id => routedKey(id) !== key)

    setSelection(inDirectoryOrder(nextIds, provider))
    unwrittenTogglesRef.current = [...unwrittenTogglesRef.current, { added, model: family.id }]

    writeChainRef.current = writeChainRef.current.then(() => flushSelection(provider))
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
                  {providerDisplayName(group.provider, copy.unnamedEndpoint)}
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
                        togglePlatformModel(family, group.provider)

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
                          <ProviderIcon vendor={modelVendor(family.id, group.provider.name)} />
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
                          providerName={group.provider.name}
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
