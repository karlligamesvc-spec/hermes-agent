import { mergeTranslations, type TranslationOverride } from '@hermes/shared/i18n'

import { en } from './en'
import type { Translations } from './types'

export type TranslationOverrides = TranslationOverride<Translations>

/** One locale's `assistant.tool` overrides, kept in its own module. */
export type AssistantToolOverrides = NonNullable<NonNullable<TranslationOverrides['assistant']>['tool']>

export const defineLocale = (overrides: TranslationOverrides): Translations =>
  mergeTranslations<Translations>(en, overrides)
