import { useI18n } from '@/i18n'
import { PRODUCT_DELIVERABLES_WORDS, PRODUCT_FOLDER_PICKER_WORDS } from '@/i18n/product-fold'
import { useSingleThreadMode } from '@/store/single-thread'

/** hc-1123: the composer chip's words, 「选择文件夹」 in product mode. */
export function useFolderPickerWords() {
  const { locale, t } = useI18n()
  const productMode = useSingleThreadMode()

  return productMode
    ? { ...t.composer.projectPicker, ...PRODUCT_FOLDER_PICKER_WORDS[locale] }
    : t.composer.projectPicker
}

/** hc-1123: the 交付物 pages' words, with no 项目 or Hermes in product mode. */
export function useDeliverablesWords() {
  const { locale, t } = useI18n()
  const productMode = useSingleThreadMode()
  const words = t.businessWorkspace.workflowDomain.deliverables

  return productMode ? { ...words, ...PRODUCT_DELIVERABLES_WORDS[locale] } : words
}
