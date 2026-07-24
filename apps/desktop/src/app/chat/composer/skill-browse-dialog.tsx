import { useEffect, useMemo, useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { Search } from '@/lib/icons'
import { cn } from '@/lib/utils'

import {
  filterSkillsByScope,
  scopedCategoryCounts,
  type SkillCatalog,
  skillCategoryLabel,
  skillDescriptionFor,
  type SkillScope
} from './skill-catalog'

// hc-572 gave the composer "+" menu two skill rows — "Enabled skills" and
// "Unused skills" — each showing a live count. hc-572-followup: real-machine
// feedback found the ENABLED row had also flattened into a full one-row-per-
// skill list (Kael: "已启用的插件显示的太多了" — too many enabled skills shown
// here), so both rows now collapse to a single line and share this one browse
// dialog. Which row you click sets `initialScope`; a tab inside lets you flip
// to the other half without reopening from the menu. Search + category
// narrowing is unchanged from hc-572; the switch now toggles BOTH directions
// (enable from the "Unused" tab, disable from the "Enabled" tab) since a single
// dialog now owns both halves.
export function SkillBrowseDialog({
  catalog,
  initialScope,
  onOpenChange,
  open
}: {
  catalog: SkillCatalog
  initialScope: SkillScope
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const { locale, t } = useI18n()
  const c = t.composer.capabilities
  const zh = locale === 'zh'
  const [scope, setScope] = useState<SkillScope>(initialScope)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)

  // Either menu row can open this dialog — land on that row's half every time
  // it opens, rather than remembering whatever a previous visit left selected.
  useEffect(() => {
    if (open) {
      setScope(initialScope)
      setQuery('')
      setCategory(null)
    }
  }, [open, initialScope])

  const changeScope = (next: SkillScope) => {
    setScope(next)
    setCategory(null)
  }

  const skills = catalog.skills
  const categories = useMemo(() => scopedCategoryCounts(skills ?? [], scope), [skills, scope])

  const rows = useMemo(
    () => filterSkillsByScope(skills ?? [], scope, query, category, zh),
    [skills, scope, query, category, zh]
  )

  const enabledScope = scope === 'enabled'
  const title = enabledScope ? c.enabledLabel : c.unused
  const description = enabledScope ? c.browseDescEnabled : c.browseDesc
  const emptyCopy = enabledScope ? c.noneEnabled : c.allEnabled

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md gap-3">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex gap-1.5">
          <ScopeTab active={enabledScope} count={catalog.enabled.length} label={c.enabledLabel} onClick={() => changeScope('enabled')} />
          <ScopeTab active={!enabledScope} count={catalog.disabled.length} label={c.unused} onClick={() => changeScope('disabled')} />
        </div>

        <label className="flex items-center gap-2 rounded-md border border-(--ui-stroke-tertiary) px-2.5 py-1.5 text-sm focus-within:border-(--ui-stroke-secondary)">
          <Search className="size-3.5 shrink-0 text-(--ui-text-tertiary)" />
          <input
            aria-label={c.searchPlaceholder}
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-(--ui-text-tertiary)"
            onChange={event => setQuery(event.target.value)}
            placeholder={c.searchPlaceholder}
            type="text"
            value={query}
          />
        </label>

        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <CategoryChip active={category === null} onClick={() => setCategory(null)}>
              {t.skills.all}
            </CategoryChip>
            {categories.map(cat => (
              <CategoryChip
                active={category === cat.key}
                key={cat.key}
                onClick={() => setCategory(category === cat.key ? null : cat.key)}
              >
                {skillCategoryLabel(cat.key, locale)}
              </CategoryChip>
            ))}
          </div>
        )}

        <div className="max-h-80 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="grid min-h-24 place-items-center px-4 text-center text-xs text-muted-foreground">
              {emptyCopy}
            </div>
          ) : (
            <ul className="grid gap-0.5">
              {rows.map(skill => (
                <li
                  className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-(--ui-row-hover-background)"
                  key={skill.name}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{skill.name}</div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {skillDescriptionFor(skill, zh) || t.skills.noDescription}
                    </p>
                  </div>
                  <Switch
                    aria-label={skill.enabled ? c.disable(skill.name) : c.toggle(skill.name)}
                    checked={skill.enabled}
                    disabled={catalog.saving === skill.name}
                    onCheckedChange={checked => void catalog.setEnabled(skill, checked)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// The scope switcher: "Enabled skills · N" / "Unused skills · M". Same active/
// inactive treatment as CategoryChip below, sized to split the dialog's width
// evenly since there are always exactly two.
function ScopeTab({
  active,
  count,
  label,
  onClick
}: {
  active: boolean
  count: number
  label: string
  onClick: () => void
}) {
  return (
    <button
      aria-label={`${label} (${count})`}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors',
        active
          ? 'border-(--ui-stroke-secondary) bg-(--ui-control-active-background) text-foreground'
          : 'border-(--ui-stroke-tertiary) text-(--ui-text-tertiary) hover:text-foreground'
      )}
      onClick={onClick}
      type="button"
    >
      <span aria-hidden className="truncate">
        {label}
      </span>
      <span aria-hidden className="text-[0.7rem] tabular-nums text-(--ui-text-tertiary)">
        {count}
      </span>
    </button>
  )
}

function CategoryChip({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return (
    <button
      className={cn(
        'rounded-full border px-2 py-0.5 text-xs transition-colors',
        active
          ? 'border-(--ui-stroke-secondary) bg-(--ui-control-active-background) text-foreground'
          : 'border-(--ui-stroke-tertiary) text-(--ui-text-tertiary) hover:text-foreground'
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}
