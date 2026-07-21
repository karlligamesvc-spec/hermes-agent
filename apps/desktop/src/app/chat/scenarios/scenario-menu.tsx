import { useMemo, useState } from 'react'

import { useI18n } from '@/i18n'
import { Search } from '@/lib/icons'
import { cn } from '@/lib/utils'

import {
  isScenarioPickable,
  menuSections,
  type ScenarioCatalog,
  scenarioIcon,
  type ScenarioItem,
  scenarioMatchesQuery
} from './catalog'

/**
 * The reusable two-level scenario picker — a searchable category rail (left) +
 * item list (right). Shared by the composer ✦ button (screen ②) and the
 * zero-state shelf's "全部场景" entry (screen ①). Selecting a live scenario
 * calls onPick; coming-soon items render muted with a badge and aren't
 * selectable. Renders inside a PopoverContent, so it styles only its innards.
 */
export function ScenarioMenu({
  catalog,
  onPick
}: {
  catalog: ScenarioCatalog
  onPick: (item: ScenarioItem) => void
}) {
  const { t } = useI18n()
  const s = t.scenarios
  const sections = useMemo(() => menuSections(catalog), [catalog])
  const [activeKey, setActiveKey] = useState(sections[0]?.key ?? '')
  const [query, setQuery] = useState('')

  const activeSection = sections.find(section => section.key === activeKey) ?? sections[0]
  const items = (activeSection?.items ?? []).filter(item => scenarioMatchesQuery(item, query))

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 pb-2 pt-2.5">
        <Search className="size-3.5 shrink-0 text-(--ui-text-tertiary)" />
        <input
          aria-label={s.searchPlaceholder}
          autoFocus
          className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-(--ui-text-tertiary)"
          onChange={event => setQuery(event.target.value)}
          placeholder={s.searchPlaceholder}
          type="text"
          value={query}
        />
      </div>
      <div className="flex min-h-[14rem]">
        <div className="flex w-[4.75rem] shrink-0 flex-col gap-0.5 border-r border-(--ui-stroke-secondary) py-1.5 pr-1.5">
          {sections.map(section => (
            <button
              className={cn(
                'rounded-md px-2 py-1 text-left text-xs',
                section.key === activeKey
                  ? 'bg-(--ui-control-active-background) font-medium text-foreground'
                  : 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground'
              )}
              key={section.key}
              onClick={() => setActiveKey(section.key)}
              type="button"
            >
              {section.title}
            </button>
          ))}
        </div>
        <div className="flex max-h-[18rem] min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto py-1.5 pl-1.5">
          {items.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-(--ui-text-tertiary)">{s.noMatches}</div>
          ) : (
            items.map(item => <ScenarioMenuRow item={item} key={item.key} onPick={onPick} />)
          )}
        </div>
      </div>
    </div>
  )
}

function ScenarioMenuRow({ item, onPick }: { item: ScenarioItem; onPick: (item: ScenarioItem) => void }) {
  const { t } = useI18n()
  const Icon = scenarioIcon(item)
  const pickable = isScenarioPickable(item)

  const inner = (
    <>
      <span className="grid size-5 shrink-0 place-items-center rounded-md bg-(--ui-control-active-background) text-(--ui-text-secondary)">
        <Icon className="size-3" />
      </span>
      <span className="min-w-0 flex-1 truncate">{item.name}</span>
      {!pickable && (
        <span className="shrink-0 rounded-full border border-(--ui-stroke-tertiary) px-1.5 text-[0.625rem] text-(--ui-text-tertiary)">
          {t.scenarios.comingSoon}
        </span>
      )}
    </>
  )

  if (!pickable) {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-(--ui-text-tertiary)"
        title={item.coming_soon_note ?? undefined}
      >
        {inner}
      </div>
    )
  }

  return (
    <button
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-(--chrome-action-hover)"
      onClick={() => onPick(item)}
      title={item.sample_ref ?? undefined}
      type="button"
    >
      {inner}
    </button>
  )
}
