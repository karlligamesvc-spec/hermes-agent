import type { ReactNode } from 'react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { ArrowUpRight, ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { IM_ENTRY_ROUTE, SETTINGS_ROUTE } from '../../routes'

import {
  isScenarioPickable,
  type ScenarioCatalog,
  scenarioIcon,
  type ScenarioItem,
  scenarioPrefill,
  type ScenarioSection,
  shelfSections
} from './catalog'
import { insertScenarioPrefill } from './pick'
import { ScenarioMenu } from './scenario-menu'
import { useChannelStatus } from './use-channel-status'
import { useScenarioCatalog } from './use-scenario-catalog'

/**
 * Zero-state scenario shelf (screen ①): a curated hero subset of the catalog
 * (社媒 6 + 电商 3), a "样例 → detail" preview per card, "全部场景" into the full
 * menu, and the "连接你的分身" manifestation strip. Rendered only in the empty
 * home state (via Intro) — it yields to the conversation the moment one starts.
 * Renders nothing when the catalog is fleet-disabled or empty.
 */
export function ScenarioShelf() {
  const catalog = useScenarioCatalog()
  const sections = shelfSections(catalog)
  const [detailItem, setDetailItem] = useState<ScenarioItem | null>(null)

  if (!catalog.enabled || sections.length === 0) {
    return null
  }

  return (
    <div className="pointer-events-auto mx-auto flex w-[min(40rem,100%)] flex-col gap-4 px-4 pb-6 text-left">
      {sections.map((section, index) => (
        <ScenarioGroup
          catalog={catalog}
          key={section.key}
          onOpenDetail={setDetailItem}
          section={section}
          showAll={index === sections.length - 1}
        />
      ))}
      <ConnectStrip />
      <ScenarioDetail item={detailItem} onClose={() => setDetailItem(null)} />
    </div>
  )
}

function ScenarioGroup({
  catalog,
  onOpenDetail,
  section,
  showAll
}: {
  catalog: ScenarioCatalog
  onOpenDetail: (item: ScenarioItem) => void
  section: ScenarioSection
  showAll: boolean
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2 px-0.5">
        <span className="text-[0.6875rem] uppercase tracking-[0.05em] text-(--ui-text-tertiary)">{section.title}</span>
        {showAll && <AllScenariosButton catalog={catalog} />}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {section.items.map(item => (
          <ScenarioCard item={item} key={item.key} onOpenDetail={onOpenDetail} />
        ))}
      </div>
    </div>
  )
}

function ScenarioCard({
  item,
  onOpenDetail
}: {
  item: ScenarioItem
  onOpenDetail: (item: ScenarioItem) => void
}) {
  const { t } = useI18n()
  const Icon = scenarioIcon(item)
  const pickable = isScenarioPickable(item)
  const hasSample = Boolean(item.sample_ref)

  return (
    <div className="group/card relative">
      <button
        className="flex w-full items-center gap-2.5 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-2.5 py-2 text-left transition-colors hover:border-(--ui-stroke-secondary) hover:bg-(--chrome-action-hover)"
        onClick={() => {
          if (pickable) {
            if (insertScenarioPrefill(item)) {
              triggerHaptic('selection')
            }
          } else {
            onOpenDetail(item)
          }
        }}
        title={item.sample_ref ?? undefined}
        type="button"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-(--ui-control-active-background) text-(--ui-text-secondary)">
          <Icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-foreground">{item.name}</span>
            {!pickable && (
              <span className="shrink-0 rounded-full border border-(--ui-stroke-tertiary) px-1.5 text-[0.625rem] text-(--ui-text-tertiary)">
                {t.scenarios.comingSoon}
              </span>
            )}
          </span>
          {item.sample_ref && (
            <span className="truncate text-[0.6875rem] text-(--ui-text-tertiary)">{item.sample_ref}</span>
          )}
        </span>
      </button>
      {hasSample && (
        <button
          aria-label={t.scenarios.sample}
          className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-1.5 py-0.5 text-[0.625rem] text-(--ui-text-tertiary) opacity-0 transition-opacity hover:text-foreground group-hover/card:opacity-100 focus-visible:opacity-100"
          onClick={event => {
            event.stopPropagation()
            onOpenDetail(item)
          }}
          type="button"
        >
          {t.scenarios.sample}
          <ArrowUpRight className="size-2.5" />
        </button>
      )}
    </div>
  )
}

function AllScenariosButton({ catalog }: { catalog: ScenarioCatalog }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className="ml-auto flex items-center gap-0.5 rounded-md px-1 py-0.5 text-xs text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
          type="button"
        >
          {t.scenarios.allScenarios}
          <ChevronRight className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 overflow-hidden p-0" side="top" sideOffset={8}>
        <ScenarioMenu
          catalog={catalog}
          onPick={item => {
            if (insertScenarioPrefill(item)) {
              triggerHaptic('selection')
              setOpen(false)
            }
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function ScenarioDetail({ item, onClose }: { item: ScenarioItem | null; onClose: () => void }) {
  const { t } = useI18n()
  const s = t.scenarios
  const pickable = item ? isScenarioPickable(item) : false

  return (
    <Dialog onOpenChange={open => !open && onClose()} open={item !== null}>
      <DialogContent className="max-w-md">
        {item && (
          <>
            <DialogHeader>
              <DialogTitle>
                {item.name} · {s.detailHeading}
              </DialogTitle>
              {item.sample_ref && <DialogDescription>{item.sample_ref}</DialogDescription>}
            </DialogHeader>
            <div className="flex flex-col gap-3 text-xs">
              {pickable ? (
                <>
                  <DetailField label={s.labelCommand}>
                    <code className="rounded-md bg-(--ui-control-active-background) px-2 py-1 font-mono text-[0.6875rem] text-foreground">
                      {scenarioPrefill(item)}
                    </code>
                  </DetailField>
                  <DetailField label={s.labelInput}>
                    <span className="text-(--ui-text-secondary)">
                      {item.param_required ? (item.param_prompt ?? '') : s.inputNone}
                    </span>
                  </DetailField>
                </>
              ) : (
                <p className="text-(--ui-text-secondary)">{item.coming_soon_note ?? s.comingSoon}</p>
              )}
            </div>
            <DialogFooter>
              {pickable ? (
                <Button
                  onClick={() => {
                    insertScenarioPrefill(item)
                    triggerHaptic('selection')
                    onClose()
                  }}
                  type="button"
                >
                  {s.use}
                </Button>
              ) : (
                <span className="rounded-full border border-(--ui-stroke-tertiary) px-2 py-0.5 text-[0.6875rem] text-(--ui-text-tertiary)">
                  {s.comingSoon}
                </span>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DetailField({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.625rem] uppercase tracking-[0.06em] text-(--ui-text-tertiary)">{label}</span>
      {children}
    </div>
  )
}

/** "连接你的分身" — the shelf's channel manifestation. Reuses the shared channel
 *  status; unbound legs navigate to their connect surface. Hidden when no
 *  channel bridge is available (web build / older main). */
function ConnectStrip() {
  const { t } = useI18n()
  const s = t.scenarios
  const status = useChannelStatus()
  const navigate = useNavigate()

  const legs = [
    { boundLabel: t.imEntry.liveState.connected, key: 'feishu', leg: status.feishu, name: t.imEntry.channels.feishu?.name ?? '飞书', route: IM_ENTRY_ROUTE },
    { boundLabel: t.imEntry.liveState.connected, key: 'weixin', leg: status.weixin, name: t.imEntry.channels.weixin?.name ?? '微信', route: IM_ENTRY_ROUTE },
    { boundLabel: s.remoteOn, key: 'phone', leg: status.phoneRemote, name: s.phoneRemote, route: SETTINGS_ROUTE }
  ].filter(entry => entry.leg.available)

  if (legs.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-(--ui-stroke-secondary) px-3 py-2 text-xs text-(--ui-text-tertiary)">
      <span className="font-medium text-(--ui-text-secondary)">{s.connectTitle}</span>
      {legs.map(entry =>
        entry.leg.bound ? (
          <span
            className="flex items-center gap-1.5 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-2 py-0.5 text-(--ui-text-secondary)"
            key={entry.key}
          >
            <StatusDot tone="good" />
            {entry.name} {entry.boundLabel}
          </span>
        ) : (
          <button
            className={cn(
              'flex items-center gap-1.5 rounded-full border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) px-2 py-0.5',
              'hover:border-(--ui-stroke-secondary) hover:text-foreground'
            )}
            key={entry.key}
            onClick={() => navigate(entry.route)}
            type="button"
          >
            <StatusDot tone="muted" />
            {entry.name} · {s.bindCta}
          </button>
        )
      )}
    </div>
  )
}
