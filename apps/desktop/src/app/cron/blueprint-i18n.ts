import type { AutomationBlueprint, AutomationBlueprintField } from '@/hermes'
import { en } from '@/i18n/en'
import type { Translations } from '@/i18n/types'

export interface LocalizedBlueprintField extends AutomationBlueprintField {
  optionLabels?: Record<string, string>
}

export interface LocalizedBlueprint extends Omit<AutomationBlueprint, 'fields'> {
  fields: LocalizedBlueprintField[]
}

// Only translate recognized built-in copy. Newer/custom backend text stays
// authoritative; enum values, routing tokens and edited defaults stay intact.
export function localizeBlueprint(
  blueprint: AutomationBlueprint,
  copy: Translations['cron']['blueprints']
): LocalizedBlueprint {
  const reference = en.cron.blueprints
  const original = reference.catalog[blueprint.key]
  const translated = copy.catalog[blueprint.key]

  if (!original || !translated) {
    return blueprint
  }

  return {
    ...blueprint,
    title: blueprint.title === original.title ? translated.title : blueprint.title,
    description: blueprint.description === original.description ? translated.description : blueprint.description,
    fields: blueprint.fields.map(field => {
      const originalLabel = original.fieldLabels?.[field.name] ?? reference.fieldLabels[field.name]
      const translatedLabel = translated.fieldLabels?.[field.name] ?? copy.fieldLabels[field.name]
      const originalDefault = original.defaults?.[field.name]

      return {
        ...field,
        label: field.label === originalLabel ? (translatedLabel ?? field.label) : field.label,
        help: field.help === reference.fieldHelp[field.name] ? (copy.fieldHelp[field.name] ?? field.help) : field.help,
        default:
          field.type === 'text' && originalDefault !== undefined && field.default === originalDefault
            ? (translated.defaults?.[field.name] ?? field.default)
            : field.default,
        optionLabels: copy.optionLabels
      }
    })
  }
}
