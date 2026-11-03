/**
 * hc-1077: the looks an assistant's face can take — the tables the avatar
 * (apex-avatar.tsx) draws from, the sidebar reads a profile's `ui_meta.apex`
 * against, and the new-assistant sheet (hc-1078) offers. A leaf, so stores can
 * read it without pulling in the component.
 *
 * APEX itself is always the purple circle (K6). Another assistant takes one
 * of six shapes and one of six colours; the purple is not among them.
 */

/** APEX's purple: its face, and the default when nothing else is asked for. */
export const APEX_AVATAR_COLOR = '#6A4CEB'

/** The six shapes an assistant can take (prototype v2 ⑦), in the order the picker shows them. */
export const APEX_AVATAR_SHAPES = ['circle', 'squircle', 'pill', 'hexagon', 'cloud', 'drop'] as const

export type ApexAvatarShape = (typeof APEX_AVATAR_SHAPES)[number]

/**
 * The six colours another assistant can take, in picker order. A profile keeps
 * the id; the hex is what is drawn. Each holds 3:1 or more against the white
 * eyes, and the colours do not change in dark mode, so that holds on a dark
 * sidebar too (src/components/apex-avatar.test.tsx measures it).
 */
export const APEX_BOT_COLORS = [
  { hex: '#2563D9', id: 'blue' },
  { hex: '#0B8A7B', id: 'teal' },
  { hex: '#2E8A40', id: 'green' },
  { hex: '#C9631A', id: 'orange' },
  { hex: '#C93A6E', id: 'rose' },
  { hex: '#9A6B00', id: 'gold' }
] as const

export type ApexBotColor = (typeof APEX_BOT_COLORS)[number]['id']

/** What a new assistant looks like until it is given a look (the prototype's sheet opens on it). */
export const APEX_BOT_DEFAULT_LOOK: { color: ApexBotColor; shape: ApexAvatarShape } = {
  color: 'blue',
  shape: 'squircle'
}

export function isApexAvatarShape(value: unknown): value is ApexAvatarShape {
  return typeof value === 'string' && (APEX_AVATAR_SHAPES as readonly string[]).includes(value)
}

export function isApexBotColor(value: unknown): value is ApexBotColor {
  return typeof value === 'string' && APEX_BOT_COLORS.some(color => color.id === value)
}

/** The hex drawn for a colour id. */
export function apexBotColorHex(id: ApexBotColor): string {
  return APEX_BOT_COLORS.find(color => color.id === id)?.hex ?? APEX_BOT_COLORS[0].hex
}
