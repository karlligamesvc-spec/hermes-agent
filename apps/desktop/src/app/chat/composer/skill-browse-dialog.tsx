import { useMemo, useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { Search } from '@/lib/icons'
import { cn } from '@/lib/utils'

import {
  disabledCategoryCounts,
  filterDisabledSkills,
  type SkillCatalog,
  skillCategoryLabel,
  skillDescriptionFor
} from './skill-catalog'

// hc-572: the "unused skills" browse surface reached from the composer "+" menu.
// 117 skills don't flatten into the menu — the disabled ones collapse to one
// entry that opens this dialog (search + category browse). Flipping a switch on
// enables the skill globally and, on reopening the menu, it has moved up into
// the "enabled" zone. Modeled on the Skills page rows + the existing prompt-
// snippets dialog (Radix submenus don't anchor reliably off the composer "+").
export function SkillBrowseDialog({
  catalog,
  onOpenChange,
  open
}: {
  catalog: SkillCatalog
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const { locale, t } = useI18n()
  const c = t.composer.capabilities
  const zh = locale === 'zh'
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)

  const skills = catalog.skills
  const categories = useMemo(() => disabledCategoryCounts(skills ?? []), [skills])
  const rows = useMemo(() => filterDisabledSkills(skills ?? [], query, category, zh), [skills, query, category, zh])

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md gap-3">
        <DialogHeader>
          <DialogTitle>{c.unused}</DialogTitle>
          <DialogDescription>{c.browseDesc}</DialogDescription>
        </DialogHeader>

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
              {c.allEnabled}
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
                    aria-label={c.toggle(skill.name)}
                    checked={false}
                    disabled={catalog.saving === skill.name}
                    onCheckedChange={() => void catalog.setEnabled(skill, true)}
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
