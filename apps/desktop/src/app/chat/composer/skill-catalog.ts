import { useCallback, useEffect, useRef, useState } from 'react'

import { asText, includesQuery, prettyName } from '@/app/settings/helpers'
import { getSkills, toggleSkill } from '@/hermes'
import type { Locale } from '@/i18n'
import { zhCategoryLabel, zhHantCategoryLabel } from '@/lib/category-labels-zh'
import { zhSkillDescription } from '@/lib/skill-descriptions-zh'
import { notify, notifyError } from '@/store/notifications'
import type { SkillInfo } from '@/types/hermes'

// hc-572 composer "+" capability menu — the skill catalog that backs the
// "enabled" zone and the "unused skills" browse dialog. Enablement is GLOBAL:
// the same toggleSkill the Skills page drives (PD ②: reuse the page's global
// state, no session-scoped copy). Pure helpers here mirror the Skills page so
// the two surfaces read the same runtime facts; the hook keeps a live copy so a
// toggle in the dialog is reflected in the menu without a reload.

export function skillCategory(skill: SkillInfo): string {
  return asText(skill.category) || 'general'
}

// Description shown for a skill: in Simplified Chinese swap in our translation
// (keyed by skill.name), else the runtime's English description — same rule as
// the Skills page.
export function skillDescriptionFor(skill: SkillInfo, zh: boolean): string {
  const original = asText(skill.description)

  return zh ? zhSkillDescription(skill.name, original) : original
}

// Category chip / label. Mirror of the Skills page: our whitelist label in
// zh / zh-hant, else the title-cased folder name.
export function skillCategoryLabel(key: string, locale: Locale): string {
  const fallback = prettyName(key)

  if (locale === 'zh') {
    return zhCategoryLabel(key, fallback)
  }

  if (locale === 'zh-hant') {
    return zhHantCategoryLabel(key, fallback)
  }

  return fallback
}

function byName(a: SkillInfo, b: SkillInfo): number {
  return asText(a.name).localeCompare(asText(b.name))
}

export function enabledSkills(skills: SkillInfo[]): SkillInfo[] {
  return skills.filter(skill => skill.enabled).sort(byName)
}

export function disabledSkills(skills: SkillInfo[]): SkillInfo[] {
  return skills.filter(skill => !skill.enabled).sort(byName)
}

export function skillMatchesQuery(skill: SkillInfo, query: string, zh: boolean): boolean {
  const q = query.trim().toLowerCase()

  if (!q) {
    return true
  }

  // Search the English AND localized description so a query matches whether the
  // user types English or Chinese.
  return (
    includesQuery(skill.name, q) ||
    includesQuery(skill.description, q) ||
    includesQuery(skillDescriptionFor(skill, zh), q) ||
    includesQuery(skill.category, q)
  )
}

export function filterDisabledSkills(
  skills: SkillInfo[],
  query: string,
  category: string | null,
  zh: boolean
): SkillInfo[] {
  return disabledSkills(skills).filter(skill => {
    if (category && skillCategory(skill) !== category) {
      return false
    }

    return skillMatchesQuery(skill, query, zh)
  })
}

export interface SkillCategoryCount {
  key: string
  count: number
}

// Categories present among the DISABLED skills only — the browse dialog scopes
// its chips to what you can still enable.
export function disabledCategoryCounts(skills: SkillInfo[]): SkillCategoryCount[] {
  const counts = new Map<string, number>()

  for (const skill of skills) {
    if (skill.enabled) {
      continue
    }

    const key = skillCategory(skill)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => ({ key, count }))
}

export interface SkillCatalogToasts {
  enabled: string
  disabled: string
  appliesToNewSessions: (name: string) => string
  failedToUpdate: (name: string) => string
  loadFailed: string
}

export interface SkillCatalog {
  skills: SkillInfo[] | null
  enabled: SkillInfo[]
  disabled: SkillInfo[]
  loading: boolean
  saving: string | null
  setEnabled: (skill: SkillInfo, enabled: boolean) => Promise<void>
}

// Lazily loads the runtime skill list the first time the capability menu (or its
// browse dialog) opens, then keeps a live local copy so toggling in the dialog
// promotes/demotes a skill in the menu's "enabled" zone with no round-trip.
export function useSkillCatalog(active: boolean, toasts: SkillCatalogToasts): SkillCatalog {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const loadedRef = useRef(false)
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts

  useEffect(() => {
    if (!active || loadedRef.current) {
      return
    }

    loadedRef.current = true
    setLoading(true)
    getSkills()
      .then(setSkills)
      .catch(err => {
        loadedRef.current = false
        notifyError(err, toastsRef.current.loadFailed)
      })
      .finally(() => setLoading(false))
  }, [active])

  const setEnabled = useCallback(async (skill: SkillInfo, enabled: boolean) => {
    setSaving(skill.name)

    try {
      await toggleSkill(skill.name, enabled)
      setSkills(current => current?.map(row => (row.name === skill.name ? { ...row, enabled } : row)) ?? current)
      const t = toastsRef.current
      notify({
        kind: 'success',
        title: enabled ? t.enabled : t.disabled,
        message: t.appliesToNewSessions(skill.name)
      })
    } catch (err) {
      notifyError(err, toastsRef.current.failedToUpdate(skill.name))
    } finally {
      setSaving(null)
    }
  }, [])

  return {
    skills,
    enabled: skills ? enabledSkills(skills) : [],
    disabled: skills ? disabledSkills(skills) : [],
    loading,
    saving,
    setEnabled
  }
}
