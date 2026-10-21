/**
 * The check behind "a Chinese screen shows no English": the Latin words left in
 * rendered Chinese copy, minus the names that stay in Latin script on purpose.
 * Fixtures feed Chinese (or brand-only) data, so any word this returns is the
 * product's own copy leaking through: a missing zh key falling back to English,
 * a literal in a component, or a code name / slug standing in for a name.
 */
export const LATIN_ALLOWED = new Set([
  // Product and capability names the Chinese UI keeps as written.
  'AI',
  'APEX',
  'GEO',
  // Creator terms Chinese creators write in Latin: the Vlog content type and B 站 (Bilibili).
  'B',
  'Vlog',
  // Platforms and services, named the way their users know them.
  'GitHub',
  'Instagram',
  'TikTok',
  'X',
  'YouTube'
])

export function englishWords(text: string): string[] {
  return [...new Set(text.match(/[A-Za-z][A-Za-z'’]*/g) ?? [])].filter(word => !LATIN_ALLOWED.has(word))
}

const READABLE_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'] as const

/** Everything a user can read off a subtree: its text, plus the labels a screen
 *  reader announces or a hover shows. Keycaps (`<kbd>`: the A–D option badges,
 *  shortcut hints) name keys, not words, so they are left out. */
export function readableText(root: Element): string {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const text: string[] = []

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('kbd')) {
      text.push(node.textContent ?? '')
    }
  }

  const labels = [...root.querySelectorAll(READABLE_ATTRIBUTES.map(name => `[${name}]`).join(','))].flatMap(element =>
    READABLE_ATTRIBUTES.map(name => element.getAttribute(name) ?? '')
  )

  return [...text, ...labels].join('\n')
}
