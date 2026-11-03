/**
 * hc-1061: one row of the single-thread sidebar (assistant, 在微信里找 APEX), as prototype v2 sizes it,
 * with 2px less side padding so its lines still fit at the shell's 190px default width (the prototype draws 232px).
 */
export const SINGLE_THREAD_ROW_CLASS =
  'flex w-full items-center gap-2.5 rounded-xl border border-transparent px-2 py-2 text-left transition-colors duration-100 ease-out [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background) hover:transition-none'
