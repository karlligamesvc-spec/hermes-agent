/**
 * apex-product-assistant.ts — which profiles are assistants the product mode
 * created (hc-1080), shared by the main process (the config heal, which makes
 * them follow APEX's tier) and the renderer (hc-1077's tier page, which edits
 * APEX's tier for them). One rule, one place.
 *
 * hc-1078 stamps the origin once, with the name and look, under `ui_meta.apex`
 * in the profile's profile.yaml (what `profiles.list` returns as `ui_meta`).
 * Renames and look changes (hc-1078's menu, hc-1082's rename tool) never write
 * it and never drop it, so a developer-mode or upstream Bot-mode profile that
 * only got a name stays what it was.
 */

/** The `ui_meta` key APEX keeps an assistant's name, look and origin under. */
export const APEX_UI_META_KEY = 'apex'

/** The origin hc-1078 writes for an assistant it creates. */
export const PRODUCT_ASSISTANT_ORIGIN = 'product'

/** True when this `ui_meta` mapping marks an assistant the product mode created (`apex.origin` is exactly `product`). */
export function isProductAssistantMeta(uiMeta: unknown): boolean {
  if (!uiMeta || typeof uiMeta !== 'object' || Array.isArray(uiMeta)) {
    return false
  }

  const apex = (uiMeta as Record<string, unknown>)[APEX_UI_META_KEY]

  return (
    Boolean(apex) &&
    typeof apex === 'object' &&
    !Array.isArray(apex) &&
    (apex as Record<string, unknown>).origin === PRODUCT_ASSISTANT_ORIGIN
  )
}
