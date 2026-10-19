import { runtimeTranslations } from '@/i18n'

/** A skill as the active locale names it. The table is keyed by the bare slug,
 *  so a category-qualified name (`apexnodes/topic-research`) resolves too; an
 *  unlisted skill reads however the locale says (English: the name as given,
 *  Chinese: nothing, never the slug). */
export function skillDisplayName(name: string): string {
  const copy = runtimeTranslations().assistant.tool

  return copy.skillNames[name.split('/').pop() ?? name] ?? copy.skillNameFallback(name)
}
