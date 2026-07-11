import { type QueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { getGlobalModelInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { notify } from '@/store/notifications'
import {
  $activeSessionId,
  $currentModel,
  $currentProvider,
  setCurrentModel,
  setCurrentProvider
} from '@/store/session'
import type { ModelOptionsResponse } from '@/types/hermes'

interface ModelSelection {
  model: string
  provider: string
}

interface ModelControlsOptions {
  activeSessionId: string | null
  queryClient: QueryClient
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
}

/** True when the selection exists in the catalog payload: some provider row
 *  (matching the selection's provider when one is set) lists the model id.
 *  Fail-open on an empty/absent payload — validation must never block a pick
 *  just because the catalog hasn't loaded yet. */
export function selectionInCatalog(
  payload: ModelOptionsResponse | undefined,
  selection: ModelSelection
): boolean {
  const rows = payload?.providers

  if (!rows?.length || !selection.model) {
    return true
  }

  return rows.some(
    row => (!selection.provider || row.slug === selection.provider) && (row.models ?? []).includes(selection.model)
  )
}

// One-time gate for the "model no longer in catalog" toast (per app run, per
// model id) — a stale sticky pick would otherwise re-toast on every catalog
// refresh / menu open.
const notifiedMissingModels = new Set<string>()

export function useModelControls({ activeSessionId, queryClient, requestGateway }: ModelControlsOptions) {
  const { t } = useI18n()
  const copy = t.desktop

  const updateModelOptionsCache = useCallback(
    (provider: string, model: string, includeGlobal: boolean) => {
      const patch = (prev: ModelOptionsResponse | undefined) => ({ ...(prev ?? {}), provider, model })

      queryClient.setQueryData<ModelOptionsResponse>(['model-options', activeSessionId || 'global'], patch)

      if (includeGlobal) {
        queryClient.setQueryData<ModelOptionsResponse>(['model-options', 'global'], patch)
      }
    },
    [activeSessionId, queryClient]
  )

  // Seed the composer's model state from the profile default. `force` reseeds
  // for a profile swap (the new profile has its own default); otherwise this
  // only fills an EMPTY selection so a user's pick (plain UI state in
  // $currentModel) survives the lifecycle refreshes that fire on boot / fresh
  // draft / session events. A live session owns the footer, so skip entirely.
  const refreshCurrentModel = useCallback(async (force = false) => {
    try {
      if ($activeSessionId.get()) {
        return
      }

      if (!force && $currentModel.get()) {
        return
      }

      const result = await getGlobalModelInfo()

      if ($activeSessionId.get() || (!force && $currentModel.get())) {
        return
      }

      if (typeof result.model === 'string') {
        setCurrentModel(result.model)
      }

      if (typeof result.provider === 'string') {
        setCurrentProvider(result.provider)
      }
    } catch {
      // The delayed session.info event still updates this once the agent is ready.
    }
  }, [])

  // Returns whether the switch succeeded so callers can await it before applying
  // follow-up changes. The composer model is plain UI state: with no live
  // session it's just stored (and shipped on the next session.create); with one
  // it's scoped to that session via config.set. It NEVER writes the profile
  // default — that lives in Settings → Model — so picking a model here can't
  // silently mutate global config.
  // hc-512: a selection that is not in the current catalog must not be applied
  // silently — fall back to the catalog default and say so once. Reached by
  // stale sticky picks (reconcileModelSelection) and programmatic callers; rows
  // clicked in the picker are by construction in the catalog.
  const rejectMissingModel = useCallback(
    (selection: ModelSelection, payload: ModelOptionsResponse) => {
      if (!notifiedMissingModels.has(selection.model)) {
        notifiedMissingModels.add(selection.model)
        notify({
          kind: 'warning',
          title: copy.modelNotInCatalogTitle,
          message: copy.modelNotInCatalog
        })
      }

      // Pre-session the composer state is ours to fix: snap to the catalog
      // default (the runtime guarantees the configured default is listed).
      // With a live session the session's model is server-truth — leave it.
      if (!activeSessionId && payload.model && selectionInCatalog(payload, { model: payload.model, provider: payload.provider ?? '' })) {
        setCurrentModel(payload.model)
        setCurrentProvider(payload.provider ?? '')
        updateModelOptionsCache(payload.provider ?? '', payload.model, true)
      }
    },
    [activeSessionId, copy, updateModelOptionsCache]
  )

  const selectModel = useCallback(
    async (selection: ModelSelection): Promise<boolean> => {
      // hc-512 catalog check — validate against the freshest catalog we hold
      // for this scope (fail-open when none is cached yet).
      const catalog = queryClient.getQueryData<ModelOptionsResponse>(['model-options', activeSessionId || 'global'])

      if (catalog && !selectionInCatalog(catalog, selection)) {
        rejectMissingModel(selection, catalog)

        return false
      }

      // Snapshot for rollback: the switch is applied optimistically, so a
      // failure must restore the prior model/provider (store + query cache)
      // rather than leave the UI showing a model the backend never selected.
      const prevModel = $currentModel.get()
      const prevProvider = $currentProvider.get()

      setCurrentModel(selection.model)
      setCurrentProvider(selection.provider)
      updateModelOptionsCache(selection.provider, selection.model, !activeSessionId)

      // No live session yet: the pick is pure UI state. session.create reads
      // $currentModel/$currentProvider and applies it as that session's override.
      if (!activeSessionId) {
        return true
      }

      try {
        await requestGateway('config.set', {
          session_id: activeSessionId,
          key: 'model',
          value: `${selection.model} --provider ${selection.provider}`
        })

        void queryClient.invalidateQueries({ queryKey: ['model-options', activeSessionId] })

        return true
      } catch (err) {
        setCurrentModel(prevModel)
        setCurrentProvider(prevProvider)
        updateModelOptionsCache(prevProvider, prevModel, !activeSessionId)

        // Never surface the gateway's raw English error in the toast (e.g.
        // "session busy — /interrupt the current turn before switching models").
        // Busy is an expected, self-resolving state — say so in plain language;
        // everything else gets a generic retry line. Raw error → console.
        console.error('[model] switch failed', err)

        const busy = /session busy|busy session|turn.*in progress/i.test(
          err instanceof Error ? err.message : String(err)
        )

        notify({
          kind: 'error',
          title: copy.modelSwitchFailed,
          message: busy ? copy.modelSwitchBusy : copy.modelSwitchRetry
        })

        return false
      }
    },
    [activeSessionId, copy, queryClient, rejectMissingModel, requestGateway, updateModelOptionsCache]
  )

  // hc-512: reconcile the sticky pre-session pick against a freshly loaded
  // catalog. The runtime always injects the CONFIGURED current model into its
  // provider's row, so a mismatch can only be client-side staleness (a pick
  // whose model was rotated out of the live catalog since). Session-scoped
  // models are server-truth and never reconciled here.
  const reconcileModelSelection = useCallback(
    (payload: ModelOptionsResponse | undefined) => {
      if (!payload?.providers?.length || $activeSessionId.get()) {
        return
      }

      const selection = { model: $currentModel.get(), provider: $currentProvider.get() }

      if (!selection.model || selectionInCatalog(payload, selection)) {
        return
      }

      rejectMissingModel(selection, payload)
    },
    [rejectMissingModel]
  )

  return { reconcileModelSelection, refreshCurrentModel, selectModel, updateModelOptionsCache }
}
