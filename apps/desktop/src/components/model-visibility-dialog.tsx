import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { ProviderIcon } from '@/components/ui/provider-icon'
import { Switch } from '@/components/ui/switch'
import type { HermesGateway } from '@/hermes'
import { getGlobalModelOptions } from '@/hermes'
import { useI18n } from '@/i18n'
import { isMoaProviderSlug, SHOW_EXPLICIT_MOA_UI } from '@/lib/moa-compose'
import { modelOptionsQueryKey } from '@/lib/model-options'
import { displayModelName, modelDisplayParts } from '@/lib/model-status-label'
import { modelVendor } from '@/lib/model-vendor'
import { dropAliasedCustomRow, providerDisplayName } from '@/lib/provider-allowlist'
import { normalize } from '@/lib/text'
import {
  $visibleModels,
  collapseModelFamilies,
  effectiveVisibleKeys,
  modelVisibilityKey,
  setVisibleModels,
  toggleModelVisibility
} from '@/store/model-visibility'
import type { ModelOptionProvider, ModelOptionsResponse } from '@/types/hermes'

interface ModelVisibilityDialogProps {
  gw?: HermesGateway
  onOpenChange: (open: boolean) => void
  onOpenProviders: () => void
  open: boolean
  profile?: string
  sessionId?: string | null
}

export function ModelVisibilityDialog({
  gw,
  onOpenChange,
  onOpenProviders,
  open,
  profile = 'default',
  sessionId
}: ModelVisibilityDialogProps) {
  const { t } = useI18n()
  const copy = t.modelVisibility
  const [search, setSearch] = useState('')
  const stored = useStore($visibleModels)

  const modelOptions = useQuery({
    queryKey: modelOptionsQueryKey(profile, sessionId),
    queryFn: (): Promise<ModelOptionsResponse> => {
      if (gw && sessionId) {
        return gw.request<ModelOptionsResponse>('model.options', {
          session_id: sessionId,
          explicit_only: true
        })
      }

      return getGlobalModelOptions()
    },
    enabled: open
  })

  // The catalog ships MoA presets as a virtual `moa` provider row, which this
  // dialog used to render like any other: a "MIXTURE OF AGENTS" heading over
  // `default` / `apex-moa` / `__auto__`, each with its own visibility switch.
  // That names the mechanism MOA-INVISIBLE-DESIGN exists to hide (and offers a
  // toggle for the reserved preset the silent multi-select synthesizes), so the
  // row is held shut behind the same SHOW_EXPLICIT_MOA_UI as the settings
  // editor and the composer menu (hc-589 leg 6). Gated rather than dropped
  // outright, so upstream's row returns with the flag — and so the guard test
  // has something to go red on.
  const providers = useMemo(() => {
    // hc-598: drop the managed endpoint's anonymous bare-`custom` alias, the
    // same way the composer picker does — otherwise it opens a second "CUSTOM
    // ENDPOINT" section here, with its own visibility switches, for an endpoint
    // already listed above under its real name.
    const rows = dropAliasedCustomRow(modelOptions.data?.providers ?? []).filter(
      provider => (provider.models ?? []).length > 0
    )

    if (SHOW_EXPLICIT_MOA_UI) {
      return rows
    }

    return rows.filter(provider => !isMoaProviderSlug(provider.slug))
  }, [modelOptions.data])

  const visible = effectiveVisibleKeys(stored, providers)

  const toggle = (provider: ModelOptionProvider, model: string) => {
    setVisibleModels(toggleModelVisibility($visibleModels.get(), providers, provider.slug, model))
  }

  const q = normalize(search)

  const matches = (provider: ModelOptionProvider, model: string) =>
    !q || `${model} ${provider.name} ${provider.slug} ${displayModelName(model)}`.toLowerCase().includes(q)

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent bodyClassName="gap-0 overflow-hidden p-0" className="max-w-xs">
        <DialogHeader className="px-3 pb-1 pt-3">
          <DialogTitle className="text-[0.8125rem]">{copy.title}</DialogTitle>
        </DialogHeader>

        <div className="px-3 py-1.5">
          <input
            autoFocus
            className="h-5 w-full bg-transparent text-xs text-foreground placeholder:text-(--ui-text-tertiary) focus:outline-none"
            onChange={event => setSearch(event.target.value)}
            placeholder={copy.search}
            type="text"
            value={search}
          />
        </div>

        <div className="max-h-[55vh] overflow-y-auto pb-1">
          {providers.length === 0 ? (
            <div className="px-3 py-5 text-center text-xs text-muted-foreground">
              {modelOptions.isPending ? <GlyphSpinner className="mx-auto text-sm" /> : copy.noAuthenticatedProviders}
            </div>
          ) : (
            providers.map(provider => {
              const models = collapseModelFamilies(provider.models ?? []).filter(family => matches(provider, family.id))

              if (models.length === 0) {
                return null
              }

              return (
                <div className="py-0.5" key={provider.slug}>
                  <div className="px-3 pb-0.5 pt-1 text-[0.625rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)">
                    {providerDisplayName(provider, t.shell.modelMenu.unnamedEndpoint)}
                  </div>
                  {models.map(family => {
                    const { name, tag } = modelDisplayParts(family.id)
                    const key = modelVisibilityKey(provider.slug, family.id)

                    return (
                      <label
                        className="flex cursor-pointer items-center gap-2 px-3 py-1 text-xs hover:bg-accent/50"
                        key={key}
                      >
                        <ProviderIcon vendor={modelVendor(family.id, provider.name)} />
                        <span className="min-w-0 flex-1 truncate">
                          {name}
                          {tag ? <span className="text-(--ui-text-tertiary)"> {tag}</span> : null}
                        </span>
                        <Switch checked={visible.has(key)} onCheckedChange={() => toggle(provider, family.id)} />
                      </label>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>

        <div className="px-3 py-2">
          <Button
            className="-ml-2 text-(--ui-text-tertiary)"
            onClick={() => {
              onOpenChange(false)
              onOpenProviders()
            }}
            size="xs"
            type="button"
            variant="text"
          >
            {copy.addProvider}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
